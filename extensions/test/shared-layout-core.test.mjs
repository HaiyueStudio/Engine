import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync,readdirSync} from 'node:fs';
import {oracleCases} from './shared-layout-oracle-cases.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
execFileSync(process.execPath,[fileURLToPath(new URL('../../node_modules/typescript/bin/tsc',import.meta.url)),'-p','extensions/test/shared-layout-pure-tsconfig.json'],{cwd:root,stdio:'pipe'});
const {createLayoutSession,LayoutError}=await import('../../artifacts/engine-0.2.2/g02/pure-layout/layout.js');
const node=(id,style={},children=[])=>({id,contentVersion:0,style,children});
const exact=(width,height)=>({width:{mode:'exact',value:width},height:{mode:'exact',value:height}});
const none=()=>({width:0,height:0,minWidth:0,minHeight:0});
const solve=(children,style={},width=300,height=80,measure=none)=>createLayoutSession().update(node('root',style,children),exact(width,height),measure);
function close(rect,expected){for(const key of Object.keys(expected))assert.ok(Math.abs(rect[key]-expected[key])<=1e-8,`${key}: ${rect[key]} != ${expected[key]}`);}

test('frozen gap, max, clamp redistribution and per-line justify counterexamples',()=>{
  let r=solve([node('a'),node('b')],{display:'grid',columns:[{fr:1},{fr:1}],rows:[20],columnGap:20},220,40);
  close(r.rects.get('a'),{x:0,y:0,width:100,height:20});close(r.rects.get('b'),{x:120,width:100});
  r=solve([node('a'),node('b')],{display:'grid',columns:[{min:50,max:100},{fr:1}],rows:[20]},300,40);
  close(r.rects.get('a'),{width:100});close(r.rects.get('b'),{x:100,width:200});
  r=solve([node('a',{grow:1,basis:0,maxWidth:100,height:20}),node('b',{grow:1,basis:0,height:20})],{alignItems:'start'},300,40);
  close(r.rects.get('a'),{width:100});close(r.rects.get('b'),{x:100,width:200});
  r=solve([node('a',{width:60,height:20,shrink:0}),node('b',{width:60,height:20,shrink:0})],{wrap:'wrap',justifyContent:'center',alignItems:'start',alignContent:'start',columnGap:10,rowGap:10},100,80);
  close(r.rects.get('a'),{x:20,y:0,width:60,height:20});close(r.rects.get('b'),{x:20,y:30,width:60,height:20});
});
test('scaled shrink freezes minimum and redistributes remaining deficit',()=>{
  const r=solve([node('a',{width:200,height:20,minWidth:150}),node('b',{width:100,height:20})],{alignItems:'start'},200,40);
  close(r.rects.get('a'),{width:150});close(r.rects.get('b'),{x:150,width:50});
});
test('fractional grow leaves intentional free space; zero basis is not content basis',()=>{
  const r=solve([node('a',{basis:0,grow:.5,height:10})],{alignItems:'start'},100,20);
  close(r.rects.get('a'),{width:50,height:10});
});
for(const [direction,rtl,expected] of [
  ['row','ltr',[0,20]],['row-reverse','ltr',[80,60]],['row','rtl',[80,60]],['row-reverse','rtl',[0,20]],
  ['column','ltr',[0,20]],['column-reverse','ltr',[80,60]],
])test(`logical order ${direction}/${rtl} does not change tree order`,()=>{
  const r=solve([node('a',{width:20,height:20}),node('b',{width:20,height:20})],{direction,writingDirection:rtl,alignItems:'start'},100,100);
  assert.deepEqual([...r.rects.keys()],['root','a','b']);
  close(r.rects.get('a'),{[direction.startsWith('row')?'x':'y']:expected[0]});close(r.rects.get('b'),{[direction.startsWith('row')?'x':'y']:expected[1]});
});
test('wrap reverse, align-self and multiline distribution use line cross sizes',()=>{
  const r=solve([node('a',{width:60,height:10,shrink:0}),node('b',{width:60,height:20,shrink:0})],{wrap:'wrap-reverse',alignContent:'space-between',alignItems:'start'},100,100);
  close(r.rects.get('a'),{y:90,height:10});close(r.rects.get('b'),{y:0,height:20});
});
test('border box and percentage padding use containing inline width',()=>{
  const r=solve([node('a',{width:100,height:80,padding:{top:{percent:10},left:5},border:{left:2,top:3}},[node('b',{width:10,height:10})])],{alignItems:'start'},200,100);
  close(r.rects.get('a'),{width:100,height:80});close(r.rects.get('b'),{x:7,y:23,width:10,height:10});
});
test('absolute dual insets stretch only auto sizes, relative zero start takes precedence',()=>{
  const r=solve([node('a',{position:'absolute',inset:{left:10,right:20,top:5,bottom:15}}),node('b',{width:20,height:10,inset:{left:0,right:9}})],{alignItems:'start'},100,50);
  close(r.rects.get('a'),{x:10,y:5,width:70,height:30});close(r.rects.get('b'),{x:0,width:20});
});
test('min beats max and ratio derives only the missing axis',()=>{
  const r=solve([node('a',{width:20,minWidth:80,maxWidth:40,aspectRatio:2}),node('b',{width:20,height:30,aspectRatio:4})],{alignItems:'start'},200,100);
  close(r.rects.get('a'),{width:80,height:40});close(r.rects.get('b'),{width:20,height:30});
});
test('Grid placement reserves explicit spans before sparse automatic items',()=>{
  const r=solve([node('a'),node('b',{placement:{column:0,row:0,columnSpan:2}}),node('c')],{display:'grid',columns:[40,40,40],rows:[20,20],columnGap:5,rowGap:5},130,45);
  close(r.rects.get('b'),{x:0,y:0,width:85,height:20});close(r.rects.get('a'),{x:90,y:0});close(r.rects.get('c'),{x:0,y:25});
});
test('Grid minmax fr floor and bounded fixed maximum are respected',()=>{
  const r=solve([node('a'),node('b')],{display:'grid',columns:[{min:100,max:{fr:1}},{fr:1}],rows:[20]},150,20);
  close(r.rects.get('a'),{width:100});close(r.rects.get('b'),{x:100,width:50});
});
test('hidden subtrees do not consume layout space or measurements',()=>{
  const r=solve([node('a',{display:'none',width:100},[node('hidden')]),node('b',{width:20,height:10})],{alignItems:'start'},100,50);
  assert.equal(r.rects.has('a'),false);assert.equal(r.rects.has('hidden'),false);close(r.rects.get('b'),{x:0,width:20});assert.equal(r.solvedNodes,2);
});
test('cached measurements are versioned, bounded, invalidatable and deterministic',()=>{
  const session=createLayoutSession({maxMeasureEntriesPerNode:2}),root=node('root',{},[node('text',{height:10})]);let calls=0;
  const measure=()=>{calls++;return {width:20,height:10,minWidth:0,minHeight:0}};
  const a=session.update(root,exact(100,50),measure),b=session.update(root,exact(100,50),measure);
  assert.equal(b.measuredNodes,0);assert.deepEqual([...a.rects],[...b.rects]);assert.equal(b.generation,a.generation+1);
  const prior=calls;session.invalidate(['text']);session.update(root,exact(100,50),measure);assert.ok(calls>prior);
  const v=calls;session.update(root,exact(100,50),measure,{metricsVersion:1});assert.ok(calls>v);
  for(const width of [110,120,130,100])session.update(root,exact(width,50),measure);
  assert.ok(calls>=6);session.dispose();session.dispose();assert.throws(()=>session.update(root,exact(100,50),measure),e=>e instanceof LayoutError&&e.code==='disposed');
});
test('failures abort atomically and do not publish cache or mutate previous results',()=>{
  const session=createLayoutSession(),root=node('root',{},[node('a',{width:20,height:10})]);
  const previous=session.update(root,exact(100,50),none);const saved=[...previous.rects];
  assert.throws(()=>session.update(root,exact(100,50),()=>{throw Error('measure failed')}),e=>e.code==='invalid-input');
  assert.deepEqual([...previous.rects],saved);assert.equal(previous.rects.set,undefined);assert.ok(Object.isFrozen(previous.rects.get('a')));
  const controller=new AbortController();
  assert.throws(()=>session.update(root,exact(100,50),()=>{controller.abort();return none()},{metricsVersion:1,signal:controller.signal}),e=>e.code==='aborted');
  const after=session.update(root,exact(100,50),none);assert.equal(after.generation,previous.generation+1);
});
test('cycles, duplicate IDs, depth, nodes, invalid numbers, tracks and placements diagnose',()=>{
  const session=createLayoutSession();const bad=node('bad');bad.children.push(bad);
  assert.throws(()=>session.update(bad,exact(100,100),none),e=>e.code==='cycle');
  for(const root of [node('r',{},[node('a'),node('a')]),node('r',{grow:-1}),node('r',{aspectRatio:0}),node('r',{border:{left:{percent:2}}}),node('r',{width:Infinity}),node('r',{columns:[{fr:-1}]}),node('r',{nonsense:1})])assert.throws(()=>session.update(root,exact(100,100),none),e=>e.code==='invalid-input');
  assert.throws(()=>createLayoutSession({maxNodes:1}).update(node('r',{},[node('a')]),exact(100,100),none),e=>e.code==='limit');
  assert.throws(()=>createLayoutSession({maxDepth:1}).update(node('r',{},[node('a')]),exact(100,100),none),e=>e.code==='limit');
  assert.throws(()=>solve([node('a',{placement:{column:1,row:0}})],{display:'grid',columns:[10],rows:[10]}),e=>e.code==='invalid-input');
  assert.throws(()=>solve([node('a',{placement:{column:0,row:0}}),node('b',{placement:{column:0,row:0}})],{display:'grid',columns:[10],rows:[10]}),e=>e.code==='invalid-input');
});
test('measurement mutation and reentry are rejected; unresolved percentages report cycle',()=>{
  const session=createLayoutSession(),root=node('root');
  assert.throws(()=>session.update(root,exact(100,100),()=>{root.style.width=42;return none()}),e=>e.code==='invalid-input');
  assert.throws(()=>session.update(node('r'),exact(100,100),()=>session.update(node('r'),exact(1,1),none)),e=>e.code==='invalid-input');
  assert.throws(()=>session.update(node('r',{},[node('a',{width:{percent:50}})]),{width:{mode:'unbounded'},height:{mode:'unbounded'}},none),e=>e.code==='cycle');
});
test('text is measured again at the allocated flex width after shrink',()=>{
  const measure=(_id,c)=>{const width=c.width.value??200;return {width:Math.min(200,width),height:Math.ceil(200/Math.max(1,width))*10,minWidth:0,minHeight:0}};
  const r=solve([node('text',{width:200})],{alignItems:'start'},100,100,measure);
  close(r.rects.get('text'),{width:100,height:20});
});
test('auto-height wrapped containers measure all flex lines before parent placement',()=>{
  const children=[node('panel',{width:100,wrap:'wrap',alignContent:'start',alignItems:'start',columnGap:10,rowGap:10},[node('a',{width:60,height:20,shrink:0}),node('b',{width:60,height:20,shrink:0})]),node('after',{width:10,height:10})];
  const r=solve(children,{direction:'column',alignItems:'start'},100,200);
  close(r.rects.get('panel'),{height:50});close(r.rects.get('after'),{y:50});
});
test('exact, at-most and unbounded constraints reach the independent measurer',()=>{
  const seen=[],measure=(_id,c)=>{seen.push(c);return {width:20,height:10,minWidth:0,minHeight:0}};
  const session=createLayoutSession();session.update(node('leaf'),exact(100,50),measure);
  assert.equal(seen[0].width.mode,'exact');assert.equal(seen[0].height.mode,'exact');
  close(session.update(node('leaf'),{width:{mode:'at-most',value:12},height:{mode:'unbounded'}},measure).rects.get('leaf'),{width:12,height:10});
  assert.equal(seen[1].width.mode,'at-most');assert.equal(seen.at(-1).width.mode,'exact');assert.equal(seen.at(-1).height.mode,'unbounded');
});
test('per-node cache evicts beyond its configured bound and versions force fresh measurements',()=>{
  let calls=0;const measure=()=>{calls++;return none()};const session=createLayoutSession({maxMeasureEntriesPerNode:2}),root=node('leaf');
  for(const width of [100,200,300])session.update(root,exact(width,50),measure);
  assert.equal(calls,3);session.update(root,exact(200,50),measure);assert.equal(calls,3);
  session.update(root,exact(100,50),measure);assert.equal(calls,4);
  root.contentVersion++;session.update(root,exact(100,50),measure);assert.equal(calls,5);
  session.update(root,exact(100,50),measure,{metricsVersion:1});assert.equal(calls,6);
  session.update(root,exact(100,50),()=>none());
  assert.equal(session.update(root,exact(100,50),measure,{metricsVersion:1}).measuredNodes,0);
});
test('constraint stages have an explicit bound and failure leaves a prior generation valid',()=>{
  const session=createLayoutSession({maxConstraintPasses:1});const previous=session.update(node('leaf'),exact(100,20),none);
  assert.throws(()=>session.update(node('root',{alignItems:'start'},[node('text')]),exact(100,100),()=>({width:200,height:10,minWidth:0,minHeight:0})),e=>e.code==='limit');
  assert.equal(previous.generation,1);assert.equal(session.update(node('leaf'),exact(100,20),none).generation,2);
});
test('ten thousand nodes and maximum accepted depth remain deterministic and bounded',()=>{
  const root=node('root',{wrap:'wrap',alignContent:'start'},Array.from({length:9999},(_,i)=>node(`n${i}`,{width:10,height:10,shrink:0})));
  const session=createLayoutSession(),a=session.update(root,exact(1000,1000),none),b=session.update(root,exact(1000,1000),none);
  assert.equal(a.solvedNodes,10000);assert.equal(a.rects.size,10000);assert.deepEqual([...a.rects],[...b.rects]);assert.equal(b.measuredNodes,0);
  let deep=node('bottom',{width:1,height:1});for(let i=0;i<127;i++)deep=node(`depth${i}`,{width:1,height:1},[deep]);
  assert.equal(createLayoutSession().update(deep,exact(1,1),none).solvedNodes,128);
  assert.throws(()=>createLayoutSession().update(node('overflow',{},[deep]),exact(1,1),none),e=>e.code==='limit');
  session.dispose();
});
test('measurement failures, invalid returns, in-flight disposal and early abort are typed',()=>{
  for(const invalid of [{width:NaN,height:0,minWidth:0,minHeight:0},{width:0,height:-1,minWidth:0,minHeight:0},Promise.resolve(none())])assert.throws(()=>createLayoutSession().update(node('r'),exact(1,1),()=>invalid),e=>e.code==='invalid-input');
  const session=createLayoutSession();assert.throws(()=>session.update(node('r'),exact(1,1),()=>{session.dispose();return none()}),e=>e.code==='disposed');
  const c=new AbortController();c.abort();let calls=0;assert.throws(()=>createLayoutSession().update(node('r'),exact(1,1),()=>{calls++;return none()},{metricsVersion:0,signal:c.signal}),e=>e.code==='aborted');assert.equal(calls,0);
});
test('percentages never resolve through an auto cross-axis measurement cycle',()=>{
  const session=createLayoutSession();
  const auto=node('r',{alignItems:'start'},[node('panel',{width:100,alignItems:'start'},[node('a',{width:20,height:{percent:50}})])]);
  assert.throws(()=>session.update(auto,exact(200,100),none),e=>e.code==='cycle');
  for(const style of [{rowGap:{percent:10}}, {inset:{top:{percent:50}},position:'absolute'}]){
    const root=node('r',{},[node('a',style)]);
    assert.throws(()=>session.update(root,{width:{mode:'exact',value:100},height:{mode:'unbounded'}},none),e=>e.code==='cycle');
  }
});
test('root constraints and metric generation are captured before user measurement',()=>{
  const session=createLayoutSession(),c=exact(100,50),options={metricsVersion:0};
  const result=session.update(node('r'),c,()=>{c.width.value=999;options.metricsVersion=9;return none()},options);
  close(result.rects.get('r'),{width:100,height:50});
});
test('fixed Grid tracks provide intrinsic size without introducing implicit tracks',()=>{
  const result=createLayoutSession().update(node('r',{display:'grid',columns:[{min:50,max:100},20],rows:[10]},[node('a')]),{width:{mode:'unbounded'},height:{mode:'unbounded'}},none);
  close(result.rects.get('r'),{width:120,height:10});
  assert.throws(()=>createLayoutSession().update(node('r',{display:'grid',columns:[{fr:1}],rows:[10]},[node('a')]),{width:{mode:'unbounded'},height:{mode:'unbounded'}},none),e=>e.code==='cycle');
});
test('measured content on a composite node participates alongside its flow children',()=>{
  const root=node('root',{direction:'column',alignItems:'start'},[node('panel',{width:100,alignItems:'start'},[node('a',{width:10,height:10})]),node('after',{width:10,height:10})]);
  const result=solve(root.children,root.style,200,200,(id)=>({width:0,height:id==='panel'?40:0,minWidth:0,minHeight:0}));
  close(result.rects.get('panel'),{width:100,height:40});close(result.rects.get('after'),{y:40});
});
test('auto flex bases use unbounded preferred main sizes before scaled shrink',()=>{
  const measure=(id,c)=>{const preferred=id==='a'?400:id==='b'?100:0;return {width:c.width.mode==='unbounded'?preferred:Math.min(preferred,c.width.value),height:10,minWidth:0,minHeight:0}};
  const r=solve([node('a',{height:10}),node('b',{height:10})],{alignItems:'start'},200,40,measure);
  close(r.rects.get('a'),{width:160});close(r.rects.get('b'),{x:160,width:40});
});
test('deep zero-basis containers measure only at allocated widths within four stages',()=>{
  let value=node('text',{height:10});for(let i=0;i<8;i++)value=node(`panel${i}`,{grow:1,basis:0,alignItems:'start'},[value,node(`spacer${i}`,{grow:1,basis:0,height:10})]);
  const r=solve([value],{alignItems:'start'},512,100,()=>({width:10,height:10,minWidth:0,minHeight:0}));
  close(r.rects.get('panel0'),{width:4});close(r.rects.get('text'),{width:4,height:10});
});
test('at-most root main size remeasures wrapped auto cross size',()=>{
  const session=createLayoutSession();
  const root=node('r',{wrap:'wrap',alignContent:'start',alignItems:'start',columnGap:10,rowGap:10},[node('a',{width:60,height:20,shrink:0}),node('b',{width:60,height:20,shrink:0})]);
  close(session.update(root,{width:{mode:'at-most',value:100},height:{mode:'unbounded'}},none).rects.get('r'),{width:100,height:50});
  const column=node('c',{direction:'column',wrap:'wrap',alignContent:'start',alignItems:'start',columnGap:10,rowGap:10},[node('a',{width:20,height:60,shrink:0}),node('b',{width:20,height:60,shrink:0})]);
  close(session.update(column,{width:{mode:'unbounded'},height:{mode:'at-most',value:100}},none).rects.get('c'),{width:50,height:100});
});
test('percentage padding keeps the containing width after main-axis shrink',()=>{
  const measure=(id,c)=>({width:id==='a'?160:0,height:id==='a'?Math.ceil(160/Math.max(1,c.width.value??160))*10:0,minWidth:0,minHeight:0});
  const r=solve([node('a',{width:200,padding:{left:{percent:10},right:{percent:10}}}),node('b',{width:100,height:10,shrink:0})],{alignItems:'start'},200,100,measure);
  close(r.rects.get('a'),{width:100,height:30});
});
test('exact root dimensions dominate root hints when deriving wrap and ratio cross sizes',()=>{
  const root=node('r',{minWidth:200,wrap:'wrap',alignContent:'start',alignItems:'start',columnGap:10,rowGap:10},[node('a',{width:60,height:20,shrink:0}),node('b',{width:60,height:20,shrink:0})]);
  close(createLayoutSession().update(root,{width:{mode:'exact',value:100},height:{mode:'unbounded'}},none).rects.get('r'),{width:100,height:50});
  close(createLayoutSession().update(node('ratio',{aspectRatio:2}),{width:{mode:'exact',value:100},height:{mode:'unbounded'}},none).rects.get('ratio'),{width:100,height:50});
});
test('frozen limits and oracle population remain covered without external core imports',()=>{
  const contract=JSON.parse(readFileSync(new URL('../../config/layout-022-contract.json',import.meta.url),'utf8'));
  assert.equal(oracleCases.length,110);for(const id of contract.requiredCorrectnessCaseIds)assert.ok(oracleCases.some(c=>c.id===id));
  const directory=new URL('../src/layout/',import.meta.url);
  for(const file of readdirSync(directory).filter(p=>p.endsWith('.ts'))){const source=readFileSync(new URL(file,directory),'utf8');for(const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))assert.ok(match[1].startsWith('./'),`${file} imports ${match[1]}`);}
  for(const name of ['box.ts','intrinsic.ts','session.ts','validate.ts'])assert.ok(!readFileSync(new URL(name,directory),'utf8').includes('hya-v1'),`${name} must not interpret a source format profile`);
  for(const [name,value]of Object.entries({maxNodes:10000,maxDepth:128,maxMeasureEntriesPerNode:8,maxConstraintPasses:4}))assert.equal(contract.layout[name],value);
  for(const limits of [{maxNodes:10001},{maxDepth:129},{maxMeasureEntriesPerNode:9},{maxConstraintPasses:5},{toString:1}])assert.throws(()=>createLayoutSession(limits),e=>e.code==='invalid-input');
});
test('fractional geometry never drifts and removed node IDs cannot retain stale metrics',()=>{
  const session=createLayoutSession(),root=node('r',{columnGap:.3,alignItems:'start'},[node('a',{basis:0,grow:.2,height:10,inset:{left:.1}}),node('b',{basis:0,grow:.8,height:10})]);
  const first=[...session.update(root,exact(300.5,40),none).rects];
  for(let i=0;i<100;i++)assert.deepEqual([...session.update(root,exact(300.5,40),none).rects],first);
  let width=20;const measure=id=>({width:id==='text'?width:0,height:10,minWidth:0,minHeight:0});
  const content=node('root',{alignItems:'start'},[node('text',{height:10})]);
  close(session.update(content,exact(200,40),measure).rects.get('text'),{width:20});
  session.update(node('root'),exact(200,40),measure);width=30;
  close(session.update(content,exact(200,40),measure).rects.get('text'),{width:30});session.dispose();
});
