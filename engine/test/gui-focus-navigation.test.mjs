import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiElement,GuiButton,GuiInput,GuiModal,GuiFocusManager,GuiRoot} from '../dist/gui.js';

const tree = () => {const root=new GuiElement(),focus=new GuiFocusManager();focus.setRoots([root]);return {root,focus};};
const button = (root,id,x=0,y=0,focus) => root.add(new GuiButton({id,x,y,width:10,height:10,...(focus?{focus}:{})}));

test('Tab is stable tree order with explicit indices, exclusions and reverse wrap',()=>{
 const {root,focus}=tree(),a=button(root,'a',80),b=button(root,'b',0,0,{mode:'all',tabIndex:2});
 const c=button(root,'c',0,0,{mode:'all',tabIndex:0});
 button(root,'none',0,0,{mode:'none'});button(root,'click',0,0,{mode:'click'});
 const negative=button(root,'negative',0,0,{mode:'all',tabIndex:-1});
 root.layout({x:0,y:0,width:200,height:100});
 assert.equal(focus.next(),a);assert.equal(focus.next(),c);assert.equal(focus.next(),b);
 assert.equal(focus.next(),a);assert.equal(focus.next(true),b);
 focus.focus(negative);assert.equal(focus.focused,negative);assert.equal(focus.next(),a);
});

test('click-only focus is programmatically valid and none cannot steal focus',()=>{
 const {root,focus}=tree(),click=button(root,'click',0,0,{mode:'click'}),none=button(root,'none',0,0,{mode:'none'});
 focus.focus(click);assert.equal(click.focused,true);focus.focus(none);assert.equal(focus.focused,click);
 focus.blur();assert.equal(click.focused,false);
});

test('directions use explicit eligible neighbour, angle, distance and stable ID',()=>{
 const {root,focus}=tree(),origin=button(root,'origin'),diagonal=button(root,'diagonal',10,1);
 const farther=button(root,'z',40),closer=button(root,'c',20),tied=button(root,'b',20);
 root.layout({x:0,y:0,width:200,height:100});focus.focus(origin);
 assert.equal(focus.move('right'),tied,'angle precedes distance, IDs break geometric ties');
 origin.setFocusOptions({mode:'all',neighbours:{right:'diagonal'}});focus.focus(origin);assert.equal(focus.move('right'),diagonal);
 diagonal.setDisabled(true);focus.focus(origin);assert.equal(focus.move('right'),tied);
 assert.equal(focus.move('up'),null);assert.equal(focus.focused,tied);assert.ok(farther&&closer);
});

test('directional geometry can map independent region-local rectangles to host space',()=>{
 const left=new GuiElement(),right=new GuiElement(),a=button(left,'a',50),b=button(right,'b',0);
 left.layout({x:0,y:0,width:100,height:50});right.layout({x:0,y:0,width:100,height:50});
 const f=new GuiFocusManager();f.setRoots([left,right],n=>({...n.rect,x:n.rect.x+(n===b?200:0)}));f.focus(a);
 assert.equal(f.move('right'),b);assert.equal(f.move('left'),a);
});

test('ancestor hiding, disabling and removal repair focus without losing visual invalidation',()=>{
 const {root,focus}=tree(),parent=root.add(new GuiElement()),a=button(parent,'a'),b=button(root,'b');
 focus.focus(a);root.clearDirty();parent.visible=false;focus.reconcile();assert.equal(focus.focused,b);assert.equal(a.focused,false);assert.equal(root.dirty,true);
 parent.visible=true;focus.focus(a);parent.disabled=true;focus.reconcile();assert.equal(focus.focused,b);
 parent.disabled=false;focus.focus(a);root.remove(parent);focus.reconcile();assert.equal(focus.focused,b);
 root.remove(b);focus.reconcile();assert.equal(focus.focused,null);
});

test('modal scopes trap focus and restore the previous valid control on close',()=>{
 const {root,focus}=tree(),a=button(root,'a'),modal=root.add(new GuiModal());focus.focus(a);
 modal.show();focus.reconcile();const first=focus.focused;assert.ok(first&&first!==a);assert.equal(focus.modal,modal);
 focus.focus(a);assert.equal(focus.focused,first);
 for(let i=0;i<12;i++){focus.next();assert.ok(modal.findById(focus.focused.id));}
 modal.hide();focus.reconcile();assert.equal(focus.focused,a);assert.equal(focus.modal,null);
});

test('nested modals restore inner-to-outer then the original focus',()=>{
 const {root,focus}=tree(),a=button(root,'a'),outer=root.add(new GuiModal()),inner=outer.add(new GuiModal());focus.focus(a);
 outer.show();focus.reconcile();const outerFocus=focus.focused;
 inner.show();focus.reconcile();assert.equal(focus.modal,inner);assert.ok(inner.findById(focus.focused.id));
 inner.hide();focus.reconcile();assert.equal(focus.focused,outerFocus);
 outer.hide();focus.reconcile();assert.equal(focus.focused,a);
});

test('invalid modal restore target falls back to first eligible, including modal removal',()=>{
 const {root,focus}=tree(),a=button(root,'a'),b=button(root,'b'),modal=root.add(new GuiModal());focus.focus(a);
 modal.show();focus.reconcile();a.setDisabled(true);root.remove(modal);focus.reconcile();assert.equal(focus.focused,b);
});

test('empty modal traps null focus until eligible content appears',()=>{
 const {root,focus}=tree(),a=button(root,'a'),modal=root.add(new GuiModal({showCloseButton:false,showConfirmButton:false,showCancelButton:false}));
 focus.focus(a);modal.show();focus.reconcile();assert.equal(focus.focused,null);assert.equal(focus.next(),null);
 const inner=button(modal,'inner');focus.reconcile();assert.equal(focus.focused,inner);
 modal.hide();focus.reconcile();assert.equal(focus.focused,a);
});

test('layout display-none state excludes focus independently of public visible',()=>{
 const root=new GuiRoot(),a=button(root.root,'a'),b=button(root.root,'b'),focus=new GuiFocusManager();
 const detach=root.installLayoutDelegate({measure:()=>({width:0,height:0}),arrange(_r,_v,commit){commit(a,{x:0,y:0,width:10,height:10},{display:'none'});commit(b,{x:20,y:0,width:10,height:10});},dispose(){}});
 root.layout(100,50);focus.setRoots([root.root]);assert.equal(focus.next(),b);focus.focus(a);assert.equal(focus.focused,b);
 detach();root.destroy();
});

test('focus configuration is immutable and invalid numeric order is rejected',()=>{
 const options={mode:'all',neighbours:{right:'a'}},node=new GuiButton({focus:options});
 options.neighbours.right='b';assert.equal(node.focusOptions.neighbours.right,'a');assert.ok(Object.isFrozen(node.focusOptions));
 assert.throws(()=>node.setFocusOptions({mode:'bogus'}),/Invalid/);assert.throws(()=>node.setFocusOptions({mode:'all',tabIndex:NaN}),/Invalid/);
});

test('reentrant blur cannot overwrite a newer focus transition; dispose clears all focus',()=>{
 const {root,focus}=tree(),a=button(root,'a'),b=button(root,'b'),c=button(root,'c');focus.focus(a);
 a.handleBlur=()=>focus.focus(c);focus.focus(b);assert.equal(focus.focused,c);assert.equal(b.focused,false);
 const generation=focus.generation;focus.dispose();assert.equal(focus.focused,null);assert.equal(c.focused,false);assert.ok(focus.generation>generation);
});
