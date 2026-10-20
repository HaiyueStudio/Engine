import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiRoot,GuiElement,GuiLabel,GuiButton,GuiSystem,GuiScrollView,GuiModal} from '../dist/gui.js';
import {World} from '../dist/ecs.js';

function setup() {
  const root=new GuiRoot(),a=root.add(new GuiButton({id:'a',x:7,width:25,height:12})),b=root.add(new GuiElement({id:'b',x:50,width:10,height:15}));
  let calls=0,disposed=0;
  const delegate={measure:()=>({width:0,height:0}),arrange(_root,viewport,commit){calls++;commit(a,{x:viewport.width/2,y:10,width:30,height:20});},dispose(){disposed++;}};
  return {root,a,b,delegate,get calls(){return calls},get disposed(){return disposed}};
}
test('opt-in delegate owns assigned rectangles, manual siblings keep coordinates and hits share geometry',()=>{
  const s=setup(),remove=s.root.installLayoutDelegate(s.delegate);
  s.root.layout(200,100);
  assert.deepEqual(s.a.rect,{x:100,y:10,width:30,height:20});assert.equal(s.b.rect.x,50);
  assert.equal(s.root.hitTest(110,15),s.a);
  assert.throws(()=>s.root.installLayoutDelegate(s.delegate),/already/);
  remove();remove();s.root.layout(200,100);assert.equal(s.a.rect.x,7);assert.equal(s.disposed,1);
});
test('static, hover, disabled and color changes cause no delegate solve; text and viewport changes do',()=>{
  const s=setup();s.root.installLayoutDelegate(s.delegate);s.root.layout(200,100);s.root.clearDirty();
  s.root.layout(200,100);s.a.setStyle({color:'#ff0000'});s.a.setDisabled(true);s.a.markDirty();s.root.layout(200,100);
  assert.equal(s.calls,1);
  s.a.setText('A longer button');s.root.layout(200,100);assert.equal(s.calls,2);
  s.root.layout(300,100);assert.equal(s.calls,3);assert.equal(s.a.rect.x,150);
});
test('foreign, duplicate, invalid, throwing and mutating delegates preserve every old rectangle',()=>{
  for(const operation of ['foreign','duplicate','invalid','throw','mutate','remove']){
    const s=setup();s.root.layout(200,100);const oldA={...s.a.rect},oldB={...s.b.rect};
    s.root.installLayoutDelegate({measure:s.delegate.measure,dispose(){},arrange(_root,_viewport,commit){
      commit(s.a,{x:90,y:2,width:10,height:10});
      if(operation==='foreign')commit(new GuiElement(),{x:0,y:0,width:1,height:1});
      if(operation==='duplicate')commit(s.a,{x:0,y:0,width:1,height:1});
      if(operation==='invalid')commit(s.b,{x:0,y:0,width:NaN,height:1});
      if(operation==='throw')throw Error('calculation failed');
      if(operation==='mutate')s.b.rect.width=100;
      if(operation==='remove')s.root.remove(s.b);
    }});
    assert.throws(()=>s.root.layout(200,100),undefined,operation);assert.deepEqual(s.a.rect,oldA,operation);assert.deepEqual(s.b.rect,oldB,operation);
  }
});
test('input-tree edits during calculation invalidate commit; failed generations can retry',()=>{
  const s=setup();let fail=true;
  s.root.installLayoutDelegate({...s.delegate,arrange(root,viewport,commit){if(fail){fail=false;s.a.setText('new');}s.delegate.arrange(root,viewport,commit)}});
  assert.throws(()=>s.root.layout(200,100),/changed/);s.root.layout(200,100);assert.equal(s.a.rect.x,100);
});
test('invalidation subscriptions retain previous/new bounds and can be removed; root destruction disposes once',()=>{
  const s=setup(),events=[];const unsubscribe=s.root.onInvalidation(event=>events.push(event));const remove=s.root.installLayoutDelegate(s.delegate);
  s.root.layout(200,100);assert.ok(events.some(e=>e.nextBounds?.width===200&&e.previousBounds));assert.ok(events.some(e=>e.reasons.includes('layout')));
  unsubscribe();const count=events.length;s.a.markDirty();assert.equal(events.length,count);
  s.root.destroy();s.root.destroy();remove();assert.equal(s.disposed,1);
});
test('a flowed label does not override its assigned width with manual autoWidth',()=>{
  const root=new GuiRoot(),label=root.add(new GuiLabel({text:'a',autoWidth:true}));
  root.installLayoutDelegate({measure:()=>({width:0,height:0}),arrange(_root,_viewport,commit){commit(label,{x:4,y:8,width:55,height:22})},dispose(){}});
  root.layout(100,100);assert.equal(label.rect.width,55);
  assert.throws(()=>root.measureElement(new GuiLabel(),{mode:'unbounded'},{mode:'unbounded'}),/another/);
});
test('completed queued pointers do not release capture that the native canvas no longer owns',()=>{
 let clicks=0;const canvas={addEventListener(){},removeEventListener(){},focus(){},hasPointerCapture(){return false},releasePointerCapture(){throw Error('No active pointer')},setPointerCapture(){throw Error('Completed pointer must not be captured')}};
 const root=new GuiRoot(),button=root.add(new GuiButton({width:100,height:40,onClick:()=>clicks++}));root.layout(200,100);
 const system=new GuiSystem({canvas}),world=new World('queued capture');system.renderer.prepare=()=>{};system.roots.add(root);
 const native=()=>({pointerId:9,pointerType:'touch',button:0,buttons:1,preventDefault(){}});
 system.pending.push({type:'pointerdown',native:native(),x:10,y:10},{type:'pointerup',native:native(),x:10,y:10});system.dispatchPendingEvents(world);
 assert.equal(clicks,1);assert.equal(button.pressed,false);system.destroy();
});
test('raw tree order, content and root-theme mutations cannot cross a calculation transaction',()=>{
 for(const mutate of [s=>s.root.root.children.reverse(),s=>{s.a.text='changed without setter'},s=>{s.root.theme.fontSize++}]){
  const s=setup();s.root.layout(200,100);const previous={...s.a.rect};s.root.installLayoutDelegate({...s.delegate,arrange(root,view,commit){mutate(s);s.delegate.arrange(root,view,commit)}});
  assert.throws(()=>s.root.layout(300,100),/changed/);assert.deepEqual(s.a.rect,previous);assert.equal(s.root.viewport.width,200);
 }
});
test('uninstall and destruction during measurement cannot resurrect retained assignments',()=>{
 for(const destroy of [false,true]){
  const s=setup();let cancel=false,remove;
  remove=s.root.installLayoutDelegate({...s.delegate,arrange(root,view,commit){s.delegate.arrange(root,view,commit);if(cancel){if(destroy)s.root.destroy();else remove()}}});
  s.root.layout(200,100);s.root.clearDirty();cancel=true;assert.throws(()=>s.root.layout(300,100),/changed/);
  s.a.layout({x:0,y:0,width:300,height:100});assert.equal(s.a.rect.x,7);assert.equal(s.disposed,1);
 }
});
test('arrangement failure restores scroll motion, viewport, dialog bounds and composite children',()=>{
 const root=new GuiRoot(),scroll=root.add(new GuiScrollView({width:100,height:60,contentHeight:400,inertia:true})),modal=root.add(new GuiModal({visible:true}));
 let fail=false,added;
 class Composite extends GuiElement {layout(parent){super.layout(parent);if(fail){added=this.add(new GuiElement());throw Error('custom arrange failed')}}}
 const composite=root.add(new Composite());scroll.scrollTo(100);scroll.fling(100);
 root.installLayoutDelegate({measure:()=>({width:0,height:0}),dispose(){},arrange(_root,_view,commit){commit(scroll,{x:0,y:0,width:100,height:60},{contentHeight:fail?20:400})}});
 root.layout(200,200);root.clearDirty();const oldDialog={...modal.dialogRect},oldScroll={...scroll.rect};fail=true;assert.throws(()=>root.layout(300,300),/custom arrange/);
 assert.equal(scroll.scrollY,100);assert.equal(scroll.contentHeight,400);assert.equal(scroll.animating,true);assert.deepEqual(scroll.rect,oldScroll);assert.deepEqual(modal.dialogRect,oldDialog);assert.equal(root.viewport.width,200);assert.deepEqual(composite.children,[]);assert.equal(added.parent,null);
});
test('installation rollback and throwing disposal still release the root owner',()=>{
 const root=new GuiRoot();let disposed=0;
 const off=root.onInvalidation(()=>{throw Error('subscriber failed')});assert.throws(()=>root.installLayoutDelegate({measure:()=>({width:0,height:0}),arrange(){},dispose(){disposed++}}),/subscriber/);assert.equal(disposed,1);off();
 root.installLayoutDelegate({measure:()=>({width:0,height:0}),arrange(){},dispose(){throw Error('disposal failed')}});assert.throws(()=>root.destroy(),/disposal/);assert.equal(root.destroyed,true);root.destroy();
});
