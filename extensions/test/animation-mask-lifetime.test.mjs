import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
let moduleIndex=0;
const data=source=>'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText+'\n//# sourceURL=animation-mask-plan-test-'+(++moduleIndex)+'.js').toString('base64');
const budget=data(readFileSync(new URL('../src/animation/AnimationMaskBudget.ts',import.meta.url),'utf8').replaceAll('@haiyue/animation-spec',import.meta.resolve('@haiyue/animation-spec')));
const {planAnimationMasks}=await import(data(readFileSync(new URL('../src/animation/AnimationMaskPlan.ts',import.meta.url),'utf8').replaceAll('./AnimationMaskBudget.js',budget).replaceAll('@haiyue/animation-spec',import.meta.resolve('@haiyue/animation-spec'))));
const options=(n=16)=>({maxGroupCount:n,width:64,height:32,maxTextureDimension2D:8192,viewKey:'mask-test'});
const source=(dependencies=[],transparent=false)=>({dependencies,transparent});

// A small scalar DAG oracle: every draw must still sample the correct logical
// source after physical aliases are overwritten. Dependency order is significant.
function verify(graph,outputs,plan){
 const keys=[...graph.keys()],seeds=new Map(keys.map((key,index)=>[key,index+1]));
 const apply=(key,values)=>(seeds.get(key)+values.reduce((n,value,index)=>n+(index+2)*value,0))%1000003;
 const cache=new Map(),logical=key=>{if(cache.has(key))return cache.get(key);const item=graph.get(key),value=item.transparent?0:apply(key,item.dependencies.map(logical));cache.set(key,value);return value;};
 const slots=[],owners=new Map(),actual=[];
 const read=key=>graph.get(key).transparent?0:(assert.ok(owners.has(key),'missing live source '+key),slots[owners.get(key)].value);
 for(const op of plan.operations){if(op.kind==='source'){
   const value=apply(op.source,graph.get(op.source).dependencies.map(read));
   if(slots[op.slot])owners.delete(slots[op.slot].key);slots[op.slot]={key:op.source,value};owners.set(op.source,op.slot);
  }else actual.push(outputs[op.index].map(read));}
 assert.deepEqual(actual,outputs.map(values=>values.map(logical)));assert.equal(slots.length,plan.targetCount);
}

test('small masks keep the original dependency-first eager order and one output segment',()=>{
 const graph=new Map([['parent',source(['leaf'])],['leaf',source()],['unused',source()]]),outputs=[['parent'],['leaf']];
 const plan=planAnimationMasks(graph,outputs,options());assert.equal(plan.mode,'eager');assert.equal(plan.targetCount,3);assert.deepEqual(plan.operations.map(op=>op.source??op.index),['leaf','parent','unused',0,1]);verify(graph,outputs,plan);
});

test('forty independent sources fit sixteen targets without dropping a consumer',()=>{
 const graph=new Map(Array.from({length:40},(_,i)=>['mask:'+i,source()])),outputs=[...graph.keys()].map(key=>[key]);
 const plan=planAnimationMasks(graph,outputs,options());assert.equal(plan.mode,'streamed');assert.equal(plan.sourceCount,40);assert.equal(plan.targetCount,1);assert.equal(plan.sourcePasses,40);verify(graph,outputs,plan);
});

test('shared nested masks retain roots until use and may safely regenerate evicted interiors',()=>{
 const graph=new Map();for(let i=0;i<40;i++)graph.set('leaf:'+i,source());
 for(let i=0;i<10;i++)graph.set('branch:'+i,source(['leaf:'+i,'leaf:'+(i+1),'leaf:'+(i+2)]));
 graph.set('root',source(Array.from({length:8},(_,i)=>'branch:'+i)));
 const outputs=[['root'],...Array.from({length:40},(_,i)=>['leaf:'+i]),['root'],['branch:4','branch:1','branch:4']];
 const plan=planAnimationMasks(graph,outputs,options());assert.ok(plan.targetCount<=11);verify(graph,outputs,plan);
});

test('impossible simultaneous roots still fail the original count budget',()=>{
 const graph=new Map(Array.from({length:9},(_,i)=>['m'+i,source()]));
 assert.throws(()=>planAnimationMasks(graph,[[...graph.keys()]],options(8)),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED'&&error.path.endsWith('.maskGroups'));
});

test('aggregate pixel capacity triggers reuse and remains a hard budget',()=>{
 const graph=new Map([['a',source()],['b',source()]]),q={...options(32),width:8192,height:8192};
 const plan=planAnimationMasks(graph,[['a'],['b']],q);assert.equal(plan.targetCount,1);verify(graph,[['a'],['b']],plan);
 assert.throws(()=>planAnimationMasks(graph,[['a','b']],q),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED'&&error.path.endsWith('.maskPixels'));
});

test('transparent groups use the identity texture without hiding active reference failures',()=>{
 const graph=new Map([['zero',source(['absent'],true)],['a',source(['zero'])]]),outputs=[['zero'],['a','zero']];
 const plan=planAnimationMasks(graph,outputs,options());assert.equal(plan.targetCount,1);assert.equal(plan.sourceCount,1);verify(new Map([['zero',source([],true)],['a',source(['zero'])]]),outputs,plan);
 assert.throws(()=>planAnimationMasks(graph,[['absent']],options()),error=>error.code==='E_ANIMATION_INVALID_FORMAT');
 assert.throws(()=>planAnimationMasks(new Map([['bad',source(['missing'])]]),[],options()),error=>error.code==='E_ANIMATION_INVALID_FORMAT');
});

test('cycles fail explicitly instead of becoming a transparent unresolved source',()=>{
 assert.throws(()=>planAnimationMasks(new Map([['a',source(['b'])],['b',source(['a'])]]),[['a']],options()),error=>error.code==='E_ANIMATION_INVALID_FORMAT');
});

test('long source chains are planned iteratively with two physical targets',()=>{
 const graph=new Map(Array.from({length:5000},(_,i)=>['n'+i,source(i?['n'+(i-1)]:[])])),plan=planAnimationMasks(graph,[['n4999']],options());
 assert.equal(plan.targetCount,2);assert.equal(plan.sourcePasses,5000);const owners=new Map(),slots=[];
 for(const op of plan.operations)if(op.kind==='source'){const index=Number(op.source.slice(1));if(index)assert.ok(owners.has('n'+(index-1)));if(slots[op.slot])owners.delete(slots[op.slot]);slots[op.slot]=op.source;owners.set(op.source,op.slot);}assert.ok(owners.has('n4999'));
});

test('source identities and repeated uses survive separators and sparse consumer lists',()=>{
 const graph=new Map(Array.from({length:25},(_,i)=>[':'+i+'|slot:0',source()])),keys=[...graph.keys()],outputs=keys.flatMap(key=>[[key,key],[],[key]]);
 const plan=planAnimationMasks(graph,outputs,options(2));assert.equal(plan.targetCount,1);verify(graph,outputs,plan);assert.ok(Object.isFrozen(plan)&&Object.isFrozen(plan.operations)&&plan.operations.every(Object.isFrozen));
});

test('per-source dependencies remain in declared blend order despite production scheduling order',()=>{
 const graph=new Map(Array.from({length:30},(_,i)=>['leaf'+i,source()]));graph.set('a',source(['leaf3','leaf1','leaf2']));graph.set('b',source(['leaf2','leaf3','leaf1']));
 const outputs=[['a','b'],['leaf27'],['b','a']];
 assert.throws(()=>planAnimationMasks(graph,outputs,options(4)),error=>error.code==='E_ANIMATION_LIMIT_EXCEEDED','three shared inputs plus two retained parent outputs require five targets');
 const plan=planAnimationMasks(graph,outputs,options());verify(graph,outputs,plan);
});
