import assert from 'node:assert/strict';
import test from 'node:test';
import {GuiElement,GuiButton,GuiInput,GuiModal,GuiFocusManager,GuiRoot,GuiScrollView,GuiSystem} from '../dist/gui.js';

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

test('directions prefer nearby controls with explicit eligible neighbours and stable ties',()=>{
 const {root,focus}=tree(),origin=button(root,'origin'),diagonal=button(root,'diagonal',10,1);
 const farther=button(root,'z',40),closer=button(root,'c',20),tied=button(root,'b',20);
 root.layout({x:0,y:0,width:200,height:100});focus.focus(origin);
 assert.equal(focus.move('right'),diagonal,'nearby overlapping controls precede distant center alignment');
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

test('down follows nearby composite rows instead of a distant better-aligned panel',()=>{
 const {root,focus}=tree();
 const header=root.add(new GuiButton({id:'header',x:44,y:305,width:314,height:36}));
 const name=root.add(new GuiInput({id:'name',x:12,y:341,width:456,height:32}));
 const start=root.add(new GuiButton({id:'start',x:12,y:379,width:456,height:32}));
 const distant=root.add(new GuiButton({id:'panel-16',x:44,y:631,width:424,height:36}));
 root.layout({x:0,y:0,width:480,height:720});focus.focus(header);
 assert.equal(focus.move('down'),name);assert.equal(focus.move('down'),start);
 assert.equal(focus.move('up'),name);assert.equal(focus.move('up'),header);assert.ok(distant);
});
test('directional badge grid reaches the next row before lower wide controls',()=>{
 const {root,focus}=tree();const first=root.add(new GuiButton({id:'first',x:126,y:103,width:46,height:22}));
 const below=root.add(new GuiButton({id:'below',x:126,y:129,width:46,height:22}));
 root.add(new GuiButton({id:'far',x:44,y:631,width:424,height:36}));
 root.layout({x:0,y:0,width:480,height:720});focus.focus(first);assert.equal(focus.move('down'),below);
 assert.equal(focus.move('up'),first);
});
test('wide adjacent rows remain preferred in all four directional orientations',()=>{
 for(const direction of ['up','down','left','right']){
  const {root,focus}=tree(),horizontal=direction==='left'||direction==='right',sign=direction==='left'||direction==='up'?-1:1;
  const origin=button(root,'origin',200,200);
  const near=button(root,'near',200+(horizontal?20*sign:2),200+(horizontal?2:20*sign));
  button(root,'far',200+(horizontal?200*sign:0),200+(horizontal?0:200*sign));
  root.layout({x:0,y:0,width:500,height:500});focus.focus(origin);assert.equal(focus.move(direction),near,direction);
 }
});
test('directional candidates with empty geometry cannot steal focus',()=>{
 const {root,focus}=tree(),origin=button(root,'origin',0,0),valid=button(root,'valid',40,0);
 root.add(new GuiButton({id:'empty',x:15,y:0,width:0,height:10}));
 root.layout({x:0,y:0,width:100,height:100});focus.focus(origin);assert.equal(focus.move('right'),valid);
});

test('automatic directions skip containing focus targets while explicit and sequential routes remain available',()=>{
 const {root,focus}=tree(),container=root.add(new GuiScrollView({id:'viewport',width:100,height:100,contentHeight:400}));
 const a=button(container,'a',0,0),b=button(container,'b',0,80);
 root.layout({x:0,y:0,width:200,height:200});focus.focus(a);
 assert.equal(focus.move('down'),b,'the closer viewport center must not replace a neighbouring control');
 a.setFocusOptions({mode:'all',neighbours:{down:container.id}});focus.focus(a);assert.equal(focus.move('down'),container);
 focus.focus(a);assert.equal(focus.next(true),container,'sequential focus still includes the scroll container');
});

test('directions move focused descendants before revealing them in nested vertical and horizontal viewports',()=>{
 for(const axis of ['vertical','horizontal']){
  const horizontal=axis==='horizontal',root=new GuiRoot(),system=new GuiSystem({});
  const outer=root.add(new GuiScrollView({width:160,height:100,contentWidth:400,contentHeight:400,axis}));
  const inner=outer.add(new GuiScrollView({width:120,height:80,contentWidth:300,contentHeight:300,axis}));
  const a=inner.add(new GuiButton({id:'a',width:30,height:30}));
  const b=inner.add(new GuiButton({id:'b',x:horizontal?220:0,y:horizontal?0:220,width:30,height:30}));
  root.layout(400,300);system.roots.add(root);system.focus.setRoots([root.root]);system.focus.focus(a);
  try{
   assert.equal(system.dispatchAction(horizontal?'right':'down','gamepad'),true);assert.equal(system.focus.focused,b);
   assert.equal(inner.scrollOffset,horizontal?130:170);assert.equal(outer.scrollOffset,0);
   assert.equal(system.dispatchAction(horizontal?'left':'up','gamepad'),true);assert.equal(system.focus.focused,a);
   assert.equal(inner.scrollOffset,0);assert.equal(outer.scrollOffset,0);
   system.focus.focus(inner);system.dispatchAction(horizontal?'right':'down','gamepad');
   assert.equal(system.focus.focused,inner);assert.equal(inner.scrollOffset,40,'directly focused viewport retains directional scrolling');
  }finally{system.destroy();root.destroy();}
 }
});

test('directions traverse offscreen viewport rows before fixed chrome and can leave at the content boundary',()=>{
 const {root,focus}=tree(),toolbar=root.add(new GuiButton({id:'toolbar',x:0,y:98,width:100,height:30}));
 const exit=button(root,'exit',0,50),scroll=root.add(new GuiScrollView({y:100,width:100,height:100,contentHeight:400}));
 const a=button(scroll,'a',0,170),b=button(scroll,'b',0,208);
 root.layout({x:0,y:0,width:400,height:300});scroll.scrollTo(180);focus.focus(b);
 assert.equal(focus.move('up'),a,'clipped content remains before overlapping fixed chrome');
 assert.equal(focus.move('up'),exit,'a viewport does not trap focus when there is no further row');
 a.setFocusOptions({mode:'all',neighbours:{up:toolbar.id}});focus.focus(a);assert.equal(focus.move('up'),toolbar);
});

for(const entry of [
 {name:'Badge 21 left',direction:'left',origin:{x:240,y:155,width:46,height:22},near:{x:183,y:155,width:46,height:22},diagonal:{x:196,y:215,width:92,height:30}},
 {name:'Badge 22 right',direction:'right',origin:{x:297,y:155,width:46,height:22},near:{x:354,y:155,width:46,height:22},diagonal:{x:288,y:215,width:92,height:30}},
])test('recorded '+entry.name+' stays in its row instead of skipping to a lower tab',()=>{
 const {root,focus}=tree(),origin=root.add(new GuiButton({id:'origin',...entry.origin})),near=root.add(new GuiButton({id:'near',...entry.near}));
 root.add(new GuiButton({id:'lower-tab',...entry.diagonal}));root.layout({x:0,y:0,width:480,height:720});
 focus.focus(origin);assert.equal(focus.move(entry.direction),near);
});

test('directional rows and columns precede diagonals while explicit routes and diagonal fallback remain available',()=>{
 for(const direction of ['left','right','up','down']){
  const {root,focus}=tree(),vertical=direction==='up'||direction==='down',positive=direction==='right'||direction==='down';
  const transform=rect=>{const r=vertical?{x:rect.y,y:rect.x,width:rect.height,height:rect.width}:{...rect};if(positive){if(vertical)r.y=500-r.y-r.height;else r.x=500-r.x-r.width;}return r;};
  const origin=root.add(new GuiButton({id:'origin',...transform({x:240,y:155,width:46,height:22})}));
  const near=root.add(new GuiButton({id:'near',...transform({x:183,y:155,width:46,height:22})}));
  const diagonal=root.add(new GuiButton({id:'diagonal',...transform({x:196,y:215,width:92,height:30})}));
  root.layout({x:0,y:0,width:500,height:500});focus.focus(origin);assert.equal(focus.move(direction),near,direction);
  origin.setFocusOptions({mode:'all',neighbours:{[direction]:diagonal.id}});focus.focus(origin);assert.equal(focus.move(direction),diagonal);
  origin.setFocusOptions({mode:'all'});near.setVisible(false);focus.focus(origin);assert.equal(focus.move(direction),diagonal,'diagonal fallback remains available at a lane boundary');
 }
});

test('touching perpendicular edges do not make another row an aligned neighbour',()=>{
 const {root,focus}=tree(),origin=button(root,'origin'),aligned=button(root,'aligned',30,0);
 button(root,'touching-row',12,10);root.layout({x:0,y:0,width:100,height:100});focus.focus(origin);
 assert.equal(focus.move('right'),aligned);
});

test('almost-touching breadcrumb and Badge rows stay separate during horizontal navigation',()=>{
 const {root,focus}=tree();
 const origin=root.add(new GuiButton({id:'badge-1',x:12,y:103,width:46,height:22}));
 const next=root.add(new GuiButton({id:'badge-2',x:69,y:103,width:46,height:22}));
 root.add(new GuiButton({id:'audio-crumb',x:12,y:72,width:57.125,height:32}));
 root.layout({x:0,y:0,width:480,height:720});focus.focus(origin);assert.equal(focus.move('right'),next);
});

test('clipped rows in another viewport cannot steal grid focus; shared, explicit and partially visible routes remain available',()=>{
 for(const offset of [0,500]){
  const root=new GuiElement(),focus=new GuiFocusManager();
  const origin=root.add(new GuiButton({id:'badge-4',x:183,y:103,width:46,height:22}));
  const next=root.add(new GuiButton({id:'badge-5',x:240,y:103,width:46,height:22}));
  const scroll=root.add(new GuiScrollView({x:0,y:305,width:480,height:100,contentHeight:1000}));
  const prior=scroll.add(new GuiButton({id:'prior',x:12,y:260,width:456,height:32}));
  const clipped=scroll.add(new GuiButton({id:'clipped',x:12,y:298,width:456,height:32}));
  root.layout({x:0,y:0,width:1280,height:720});scroll.scrollTo(500);
  focus.setRoots([root],node=>({...node.rect,x:node.rect.x+offset}));focus.focus(origin);
  assert.equal(clipped.rect.y,103);assert.equal(focus.move('right'),next,'offscreen content overlaps the grid only before viewport clipping');
  origin.setFocusOptions({mode:'all',neighbours:{right:clipped.id}});focus.focus(origin);assert.equal(focus.move('right'),clipped);
  origin.setFocusOptions({mode:'all'});focus.focus(prior);assert.equal(focus.move('down'),clipped,'a shared viewport can reveal its next offscreen row');
  scroll.scrollTo(310);focus.focus(origin);assert.equal(focus.move('down'),clipped,'partially visible content remains an eligible entry');
 }
});
