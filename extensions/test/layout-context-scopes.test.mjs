import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';

const {runtime:{LayoutEvaluator}}=await loadResponsiveLayoutModules(process.env.G11_LAYOUT_CONTEXT_SOURCE
 ?{evaluatorSource:readFileSync(process.env.G11_LAYOUT_CONTEXT_SOURCE,'utf8')}:undefined);
const fill={unit:'fill'},point=value=>({unit:'point',value});
const root=(id,children=[])=>({id,width:80,height:80,root:id+'-root',nodes:[{id:id+'-root',kind:'container',style:{width:fill,height:fill,direction:'column'}},...children.map(n=>({...n,parent:id+'-root'}))]});
const component=(id,artboard)=>({id,kind:'component',component:{artboard,sizing:'node'},style:{width:point(40),height:point(40)}});
const text={id:'text',kind:'text',text:'label',style:{width:point(20),height:point(20)}};
function document(artboards,instances=[{id:'stage',artboard:'main',fit:'fill'}]){
 return{format:'haiyue-responsive-layout-2d',version:1,extension:'org.haiyue.layout-2d@1',assets:[],textStyles:[],textBlocks:[],artboards,instances};
}
function evaluate(doc,resolveNode){
 const contexts=[],provider={evaluate(_block,_request,context){contexts.push(structuredClone(context));return{id:'label',width:20,height:20,contentWidth:20,contentHeight:20,glyphs:[],lines:[],controls:[]}}};
 const evaluator=new LayoutEvaluator(doc,undefined,provider,resolveNode?{maxExpandedNodes:250_000,stableIds:true,resolveNode}:undefined);
 return{evaluator,contexts,run(){contexts.length=0;return evaluator.evaluate({viewport:[80,80],dpr:1,time:0})},close(){evaluator.dispose()}};
}
test('layout scopes preserve namespace identity through nested components without changing fitted boxes',()=>{
 const doc=document([root('main',[component('outer','card')]),root('card',[component('inner','leaf')]),root('leaf',[text])]);
 const f=evaluate(doc,context=>context.node.id==='outer'?{scopes:{data:['outer'],other:['external']}}:context.node.id==='inner'?{scopes:{data:['inner']}}:{});
 try{const frame=f.run();assert.equal(frame.instances.length,3);for(const c of f.contexts){assert.deepEqual(c.scopes,{data:['inner','outer'],other:['external']});assert.equal(c.node.id,'text')};assert.deepEqual(frame.nodes.find(n=>n.kind==='text').rect,{x:0,y:0,width:20,height:20});assert.equal(doc.artboards[0].nodes[1].component.artboard,'card');}finally{f.close()}
});
test('layout scopes keep repeated sibling/root instances isolated even when the artboard and node IDs match',()=>{
 const doc=document([root('main',[component('host','leaf')]),root('leaf',[text])],[{id:'one',artboard:'main',fit:'fill'},{id:'two',artboard:'main',fit:'fill'}]);
 const f=evaluate(doc,c=>c.node.id==='host'?{scopes:{data:[c.instanceId]}}:{});
 try{const frame=f.run();assert.equal(frame.instances.length,4);const first=f.contexts.filter(c=>c.instanceId.startsWith('r3:one')),second=f.contexts.filter(c=>c.instanceId.startsWith('r3:two'));assert.ok(first.length&&second.length);for(const c of first)assert.deepEqual(c.scopes,{data:['r3:one']});for(const c of second)assert.deepEqual(c.scopes,{data:['r3:two']});assert.equal(new Set(frame.instances.map(i=>i.id)).size,4);}finally{f.close()}
});
test('layout model-list item scopes shadow only their named namespace and preserve other inherited contexts',()=>{
 const list={id:'rows',kind:'list',list:{dataPort:'rows',templateArtboard:'row',direction:'column',itemExtent:20},style:{width:point(40),height:point(40)}};
 const doc=document([root('main',[component('host','card')]),root('card',[list]),root('row',[text])]),f=evaluate(doc,c=>c.node.id==='host'?{scopes:{data:['outer'],other:['foreign']}}:c.node.id==='rows'?{items:[{id:'a'},{id:'b'}],itemScope:'data'}:{});
 try{const frame=f.run();const rows=f.contexts.filter(c=>c.phase==='arrange');assert.equal(rows.length,2);assert.deepEqual(rows.map(c=>c.scopes),[{data:['a','outer'],other:['foreign']},{data:['b','outer'],other:['foreign']}]);assert.deepEqual(rows.map(c=>c.itemScope),['data','data']);assert.deepEqual(rows.map(c=>c.item.id),['a','b']);assert.equal(frame.visibleListItems,2);}finally{f.close()}
});
test('layout explicit child scopes shadow an inherited list row while retaining the original item and stable key',()=>{
 const list={id:'rows',kind:'list',list:{dataPort:'rows',templateArtboard:'row',direction:'column',itemExtent:40},style:{width:point(40),height:point(40)}};
 const doc=document([root('main',[list]),root('row',[component('child','leaf')]),root('leaf',[text])]),f=evaluate(doc,c=>c.node.id==='rows'?{items:[{id:'a'}],itemScope:'data'}:c.node.id==='child'?{scopes:{data:['explicit']}}:{});
 try{const frame=f.run();for(const c of f.contexts){assert.deepEqual(c.scopes,{data:['explicit','a']});assert.equal(c.item.id,'a');assert.equal(c.itemScope,'data')};assert.equal(frame.visibleListItems,1);assert.equal(new Set(frame.instances.map(i=>i.id)).size,3);}finally{f.close()}
});
test('legacy prepared text providers see no added scope members when no adapter supplies scoped metadata',()=>{
 const f=evaluate(document([root('main',[component('host','leaf')]),root('leaf',[text])]));
 try{const a=f.run(),b=f.run();assert.deepEqual(a,b);assert.ok(f.contexts.length);for(const c of f.contexts){assert.equal(Object.hasOwn(c,'scopes'),false);assert.equal(Object.hasOwn(c,'itemScope'),false)}}finally{f.close()}
});
