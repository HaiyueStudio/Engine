import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserMultiplayerInput,InputActionMap} from '../dist/experimental/simulation.js';
import {InputMap} from '../dist/input.js';
import {GuiSystem,GuiRoot,GuiButton,GuiSlider,GuiModal,GuiTree} from '../dist/gui.js';

const pad=(buttons={},axes=[0,0])=>({connected:true,buttons:Array.from({length:16},(_,i)=>({value:buttons[i]??0,pressed:(buttons[i]??0)>0.5})),axes});
// Web IDL attributes live on the prototype, unlike the plain data objects above.
class BrowserButton {
 constructor(value){this.raw=value;}
 get value(){return this.raw;}
 get pressed(){return this.raw>0.5;}
}
const browserPad=(buttons={})=>({...pad(),buttons:Array.from({length:16},(_,i)=>new BrowserButton(buttons[i]??0))});
function fixture(){
 const target=new EventTarget(),visibility=new EventTarget();visibility.hidden=false;let pads=[pad()],polls=0,tick=0;
 const input=new BrowserMultiplayerInput({eventTarget:target,visibilityTarget:visibility,getGamepads:()=>{polls++;return pads;},players:[{id:'p1',gamepadIndex:0,bindings:{jump:{gamepadButtons:[0],keys:['Space']},alias:{gamepadButtons:[0]},move:{gamepadAxes:[{axis:0}]}}},{id:'p2',gamepadIndex:0,bindings:{fire:{gamepadButtons:[0]}}}]});
 const sample=()=>input.sample(++tick),action=(s,name,player=0)=>s.players[player].actions.find(a=>a.action===name);
 return {input,target,visibility,sample,action,set:p=>{pads=p;},polls:()=>polls};
}
test('GUI consumes a physical press once, masks every player alias, and retains ownership after unsubscribe until neutral',()=>{
 const f=fixture();let calls=0;const off=f.input.addGamepadLayer(InputActionMap.guiNavigation(),(action,index)=>{assert.equal(index,0);calls++;return action==='confirm';});
 f.set([pad({0:1})]);const first=f.sample();assert.equal(calls,1);assert.equal(f.action(first,'jump').held,false);assert.equal(f.action(first,'alias').pressed,false);assert.equal(f.action(first,'fire',1).pressed,false);
 f.sample();assert.equal(calls,1);off();assert.equal(f.action(f.sample(),'jump').held,false);
 f.set([pad({0:0.4})]);assert.equal(f.action(f.sample(),'jump').value,0);
 f.set([pad()]);f.sample();f.set([pad({0:1})]);assert.equal(f.action(f.sample(),'jump').pressed,true);assert.equal(f.polls(),6);f.input.dispose();
});
test('a new GUI layer cannot steal a held scene press; unconsumed controls and other devices remain independent',()=>{
 const f=fixture();f.set([pad({0:1}),pad({0:1})]);assert.equal(f.action(f.sample(),'jump').pressed,true);let hits=[];
 f.input.addGamepadLayer(InputActionMap.guiNavigation(),(a,index)=>{hits.push([a,index]);return index===0&&a==='confirm';});
 assert.equal(f.action(f.sample(),'jump').held,true);assert.deepEqual(hits,[]);
 f.set([pad(),pad()]);f.sample();f.set([pad({0:1}),pad({0:1})]);assert.equal(f.action(f.sample(),'jump').held,false);assert.deepEqual(hits,[['confirm',0],['confirm',1]]);f.input.dispose();
});
test('browser GamepadButton accessors retain press edges across held frames and later mutable samples',()=>{
 const f=fixture(),events=[];
 f.input.addGamepadLayer(InputActionMap.guiNavigation(),action=>{events.push(action);return true;},{capture:()=>true});
 const live=browserPad();f.set([live]);f.sample();
 for(const [button,action] of [[15,'right'],[5,'next'],[0,'confirm'],[1,'cancel']]){
  live.buttons[button].raw=1;
  for(let frame=0;frame<30;frame++){
   const state=f.sample();assert.equal(f.action(state,'jump').held,false);
   assert.equal(events.filter(value=>value===action).length,1,`${action} must fire once while held`);
  }
  live.buttons[button].raw=0;f.sample();
  live.buttons[button].raw=1;f.sample();
  assert.equal(events.filter(value=>value===action).length,2,`${action} must rearm after release`);
  live.buttons[button].raw=0;f.sample();
 }
 assert.equal(f.polls(),133,'one device poll per sample');f.input.dispose();
});
test('newest layer priority, alias arbitration and directional analog neutral use one sample',()=>{
 const f=fixture(),events=[];const map=new InputActionMap({right:{gamepadAxes:[{axis:0,direction:'positive',deadZone:0.25}]},other:{gamepadAxes:[{axis:0,direction:'positive',deadZone:0.25}]}});
 f.input.addGamepadLayer(map,a=>{events.push(`old:${a}`);return true;});const off=f.input.addGamepadLayer(map,a=>{events.push(`new:${a}`);return true;});
 f.set([pad({},[0.9,0])]);assert.equal(f.action(f.sample(),'move').value,0);assert.deepEqual(events,['new:right']);off();
 f.set([pad({},[0.4,0])]);assert.equal(f.action(f.sample(),'move').value,0);f.set([pad()]);f.sample();f.set([pad({},[0.9,0])]);assert.equal(f.action(f.sample(),'move').value,0);assert.deepEqual(events,['new:right','old:right']);f.input.dispose();
});

test('an explicitly capturing GUI scope masks slow analog ramps before UI/gameplay dead-zone thresholds diverge',()=>{
 const f=fixture();let captures=true;const events=[];
 const off=f.input.addGamepadLayer(InputActionMap.guiNavigation(),action=>{events.push(action);return true;},{capture:()=>captures});
 for(const raw of [0,0.1,0.3,0.55,0.58,0.62,0.63,0.8]){f.set([pad({},[raw,0])]);const value=f.action(f.sample(),'move');assert.equal(value.value,0);assert.equal(value.pressed,false);}
 assert.deepEqual(events,['right']);captures=false;off();f.set([pad({},[0.8,0])]);assert.equal(f.action(f.sample(),'move').value,0);
 f.set([pad()]);f.sample();f.set([pad({},[0.8,0])]);assert.equal(f.action(f.sample(),'move').pressed,true);f.input.dispose();
});

test('capture scopes block mapped controls even at a navigation edge while unbound gamepad channels still reach scene',()=>{
 const f=fixture();let n=0;f.input.addGamepadLayer(new InputActionMap({up:{gamepadButtons:[12]}}),()=>{n++;return false;},{capture:()=>true});
 f.set([pad({0:1,12:1})]);const result=f.sample();assert.equal(n,1);assert.equal(f.action(result,'jump').pressed,true,'unbound A remains available');
 f.input.dispose();
});

test('same-layer aliases cannot double-activate one source but a distinct active alternative remains usable',()=>{
 const f=fixture(),events=[];f.input.addGamepadLayer(new InputActionMap({one:{gamepadButtons:[0]},alias:{gamepadButtons:[0]},alternative:{gamepadButtons:[0,1]}}),a=>{events.push(a);return true;});
 f.set([pad({0:1,1:1})]);f.sample();assert.deepEqual(events,['one','alternative']);f.input.dispose();
});
test('window blur and hidden-resume cannot replay a held confirmation; neutral and reconnect permit fresh presses',()=>{
 const f=fixture();let n=0;f.input.addGamepadLayer(InputActionMap.guiNavigation(),()=>{n++;return true;});f.set([pad({0:1})]);f.sample();assert.equal(n,1);
 f.target.dispatchEvent(new Event('blur'));f.sample();assert.equal(n,1);f.visibility.hidden=true;f.visibility.dispatchEvent(new Event('visibilitychange'));f.sample();f.visibility.hidden=false;f.visibility.dispatchEvent(new Event('visibilitychange'));f.sample();assert.equal(n,1);
 f.set([pad()]);f.sample();f.set([pad({0:1})]);f.sample();assert.equal(n,2);f.set([null]);f.sample();f.set([pad({0:1})]);f.sample();assert.equal(n,3);f.input.dispose();
});
test('host sampled standard gamepad drives a production modal/slider flow without double scene activation',()=>{
 const f=fixture(),gui=new GuiSystem({}),root=new GuiRoot();let confirmed=0;
 const open=root.add(new GuiButton({onClick:()=>modal.show()})),modal=root.add(new GuiModal({showCloseButton:false,showConfirmButton:false,showCancelButton:false}));
 const slider=modal.add(new GuiSlider({min:0,max:3,step:1,value:0})),done=modal.add(new GuiButton({y:80,onClick:()=>{confirmed++;modal.close('confirm');}}));
 root.layout(400,300);gui.roots.add(root);gui.focus.setRoots([root.root]);gui.focus.focus(open);
 const off=f.input.addGamepadLayer(InputActionMap.guiNavigation(),a=>gui.dispatchAction(a,'gamepad'));
 const press=button=>{f.set([pad({[button]:1})]);const s=f.sample();f.set([pad()]);f.sample();return s;};
 assert.equal(f.action(press(0),'jump').held,false);assert.equal(modal.visible,true);assert.equal(gui.focus.focused,slider);
 press(15);assert.equal(slider.value,1);press(5);assert.equal(gui.focus.focused,done);press(0);assert.equal(confirmed,1);assert.equal(modal.visible,false);assert.equal(gui.focus.focused,open);
 off();gui.destroy();root.destroy();f.input.dispose();
});
test('GUI keyboard consumption filters sampler actions independently of DOM default prevention and preserves raw event propagation',()=>{
 const f=fixture(),canvas=new EventTarget();canvas.tabIndex=0;canvas.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100});
 const gui=new GuiSystem({canvas,width:100,height:100},{preventDefault:false}),root=new GuiRoot();let clicks=0;
 const button=root.add(new GuiButton({onClick:()=>clicks++}));root.layout(100,100);gui.roots.add(root);gui.focus.setRoots([root.root]);gui.focus.focus(button);
 const down=new Event('keydown',{cancelable:true});Object.assign(down,{code:'Space',key:' ',repeat:false});canvas.dispatchEvent(down);f.target.dispatchEvent(down);
 assert.equal(InputMap.isEventConsumed(down),true);assert.equal(down.defaultPrevented,false);assert.equal(clicks,1);assert.equal(f.action(f.sample(),'jump').held,false);
 gui.destroy();assert.equal(f.action(f.sample(),'jump').held,false);const up=new Event('keyup');Object.assign(up,{code:'Space'});f.target.dispatchEvent(up);f.sample();
 const fresh=new Event('keydown');Object.assign(fresh,{code:'Space'});f.target.dispatchEvent(fresh);assert.equal(f.action(f.sample(),'jump').pressed,true);root.destroy();f.input.dispose();
});
test('tree owns selection/expand/collapse keys before GUI spatial navigation, skips disabled rows and emits once',()=>{
 const gui=new GuiSystem({}),root=new GuiRoot();let selections=0,expands=0;
 const tree=root.add(new GuiTree({nodes:[{key:'a',label:'A',children:[{key:'disabled',label:'Disabled',disabled:true},{key:'b',label:'B'}]},{key:'c',label:'C'}],onSelect:()=>selections++,onExpand:()=>expands++}));
 root.add(new GuiButton({x:280}));root.layout(400,300);gui.roots.add(root);gui.focus.setRoots([root.root]);gui.focus.focus(tree);
 gui.dispatchAction('down');assert.equal(tree.selectedKey,'a');gui.dispatchAction('right');assert.equal(expands,1);gui.dispatchAction('right');assert.equal(tree.selectedKey,'b');gui.dispatchAction('left');assert.equal(tree.selectedKey,'a');gui.dispatchAction('left');assert.equal(expands,2);assert.equal(selections,3);assert.equal(gui.focus.focused,tree);
 gui.dispatchAction('next');assert.notEqual(gui.focus.focused,tree);gui.destroy();root.destroy();
});
