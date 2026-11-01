import test from 'node:test';
import assert from 'node:assert/strict';
import {InputActionMap,InputMap} from '../dist/input.js';
import {InputActionMap as ExperimentalMap,BrowserMultiplayerInput} from '../dist/experimental/simulation.js';
const pad=(axes=[0,0],buttons=[])=>({connected:true,axes,buttons:buttons.map(value=>({value,pressed:value>=.5}))});
const key=(target,type,code,extra={})=>{const event=new Event(type);Object.assign(event,{code,...extra});target.dispatchEvent(event);};
const action=(snapshot,name,player=0)=>snapshot.players[player].actions.find(a=>a.action===name);

test('stable input exports the original class and default keyboard axes match browser gamepad signs',()=>{
 assert.equal(InputActionMap,ExperimentalMap);const map=InputActionMap.standardGameplay();
 for(const [code,name,value] of [['ArrowLeft','MoveX',-1],['KeyA','MoveX',-1],['ArrowRight','MoveX',1],['KeyD','MoveX',1],['ArrowUp','MoveY',-1],['KeyW','MoveY',-1],['ArrowDown','MoveY',1],['KeyS','MoveY',1]]){
  assert.equal(map.sampleKeyboard([code]).find(a=>a.action===name).value,value);assert(map.actionsForKey(code).includes(name));
 }
 assert.deepEqual(map.sampleKeyboard(['ArrowLeft','KeyD','ArrowUp','KeyS']),[]);
 assert.equal(map.sampleGamepad(pad([-1,1])).find(a=>a.action==='MoveX').value,-1);assert.equal(map.sampleGamepad(pad([-1,1])).find(a=>a.action==='MoveY').value,1);
 assert.equal(map.sampleKeyboard(['Space'])[0].value,1);
});
test('legacy keys remain boolean, strongest alternatives retain insertion ties and directional sides cancel',()=>{
 const map=new InputActionMap({Move:{keys:['KeyJ'],keyboardAxes:[{negative:['KeyA'],positive:['KeyD'],scale:.5},{negative:['ArrowLeft'],positive:['ArrowRight']} ]}});
 assert.equal(map.sampleKeyboard(['KeyJ','ArrowLeft'])[0].value,1);assert.equal(map.sampleKeyboard(['KeyA','ArrowRight'])[0].value,1);
 assert.equal(map.sampleKeyboard(['ArrowLeft','ArrowRight','KeyA'])[0].value,-.5);assert.deepEqual(map.sampleKeyboard(['KeyA','KeyD']),[]);
 const signed=new InputActionMap({Move:{gamepadAxes:[{axis:0,direction:'negative',scale:-1},{axis:1,direction:'positive'}]}});
 assert.equal(signed.sampleGamepad(pad([-1,1]))[0].value,-1);assert.deepEqual(signed.sampleGamepad(pad([.1,.15])),[]);
});
test('normalization and cached reverse indices retain old immutable snapshots after atomic replacement',()=>{
 const map=new InputActionMap({Move:{keyboardAxes:[{negative:['KeyA','KeyA'],positive:['KeyD']}]},fire:{pointerButtons:[0]}}),old=map.toJSON(),keys=map.actionsForKey('KeyA'),values=map.sampleKeyboard(['KeyA']);
 assert.equal(map.toJSON(),old);assert.equal(map.actionsForKey('KeyA'),keys);assert(Object.isFrozen(old.Move.keyboardAxes[0].negative));assert(Object.isFrozen(values[0]));
 assert.throws(()=>map.setBindings({good:{keys:['KeyG']},bad:{keyboardAxes:[{negative:['X'],positive:[4]}]}}));assert.equal(map.toJSON(),old);
 map.setAction('Move',{keys:['KeyW']});assert.deepEqual(keys,['Move']);assert.deepEqual(values,[{action:'Move',value:-1}]);assert.deepEqual(old.Move.keyboardAxes[0].negative,['KeyA']);assert.deepEqual(map.actionsForKey('KeyA'),[]);assert.deepEqual(map.actionsForKey('KeyW'),['Move']);map.removeAction('fire');assert.deepEqual(map.actionsForPointerButton(0),[]);
});
test('boolean InputMap snapshots are frozen and saved snapshots never change during later sampling',()=>{
 const map=new InputMap({' jump ':[' Space ','Space'],left:['KeyA']});let held=new Set(['Space']);const first=map.snapshot({pressed:c=>held.has(c),down:c=>held.has(c),up:()=>false});held=new Set(['KeyA']);const second=map.snapshot({pressed:c=>held.has(c),down:()=>false,up:c=>c==='Space'});
 assert.deepEqual(first,{pressed:['jump'],down:['jump'],up:[]});assert.deepEqual(second,{pressed:['left'],down:[],up:['jump']});assert(Object.isFrozen(first));assert(Object.isFrozen(first.pressed));
 map.getKeys('jump').clear();assert.equal(map.hasKey('Space'),true);const json=map.toJSON();json.jump.push('KeyX');assert.equal(map.hasKey('KeyX'),false);
});
test('borrowed map changes release removed actions once and quarantine held keys/pointers until neutral',()=>{
 const target=new EventTarget(),map=new InputActionMap({old:{keys:['KeyA'],pointerButtons:[0]}}),input=new BrowserMultiplayerInput({eventTarget:target,getGamepads:()=>[],players:[{id:'p',bindings:map}]});
 try{key(target,'keydown','KeyA');const first=input.sample(1);assert(action(first,'old').pressed);map.setBindings({fresh:{keys:['KeyA'],pointerButtons:[0]}});const changed=input.sample(2);assert(action(changed,'old').released);assert.equal(action(changed,'fresh').held,false);assert.equal(action(input.sample(3),'old'),undefined);
 key(target,'keyup','KeyA');input.sample(4);key(target,'keydown','KeyA');assert(action(input.sample(5),'fresh').pressed);target.dispatchEvent(new Event('blur'));assert(action(input.sample(6),'fresh').released);assert.deepEqual(first.players[0].actions[0],{action:'old',value:1,held:true,pressed:true,released:false});
 const pointer=type=>{const event=new Event(type);Object.assign(event,{button:0});target.dispatchEvent(event);};pointer('pointerdown');assert(action(input.sample(7),'fresh').pressed);map.setBindings({newPointer:{pointerButtons:[0]}});const p=input.sample(8);assert(action(p,'fresh').released);assert.equal(action(p,'newPointer').held,false);pointer('pointerup');input.sample(9);pointer('pointerdown');assert(action(input.sample(10),'newPointer').pressed);target.dispatchEvent(new Event('pointercancel'));assert(action(input.sample(11),'newPointer').released);assert.equal(action(input.sample(12),'newPointer').released,false);
 }finally{input.dispose();}
});
test('same-sample rebinding inside provider and route never leaks a held gamepad control to a new action',()=>{
 for(const phase of ['provider','route']){const map=new InputActionMap({old:{gamepadButtons:[0]}});let pads=[pad([0,0],[0])],change=false,tick=0;const input=new BrowserMultiplayerInput({eventTarget:new EventTarget(),getGamepads:()=>{if(change&&phase==='provider'){change=false;map.setBindings({fresh:{gamepadButtons:[0]}});}return pads;},players:[{id:'p',gamepadIndex:0,bindings:map}]});
  try{input.addGamepadRoute(()=>{if(change&&phase==='route'){change=false;map.setBindings({fresh:{gamepadButtons:[0]}});}return false;});input.sample(++tick);pads=[pad([0,0],[1])];if(phase==='provider'){assert(action(input.sample(++tick),'old').pressed);}change=true;const changed=input.sample(++tick);assert.equal(action(changed,'fresh').held,false);assert.equal(action(input.sample(++tick),'fresh').held,false);pads=[pad([0,0],[0])];input.sample(++tick);pads=[pad([0,0],[1])];assert(action(input.sample(++tick),'fresh').pressed);}finally{input.dispose();}
 }
});
test('rebind quarantines only its original device and preserves keyboard/gamepad strongest-value ties',()=>{
 const target=new EventTarget(),map=InputActionMap.standardGameplay(),other=new InputActionMap({jump:{gamepadButtons:[0]}});let pads=[pad([-1,0],[1]),pad([0,0],[1])];const input=new BrowserMultiplayerInput({eventTarget:target,getGamepads:()=>pads,players:[{id:'one',bindings:map,gamepadIndex:0},{id:'two',bindings:other,gamepadIndex:1}]});
 try{key(target,'keydown','KeyD');assert.equal(action(input.sample(1),'MoveX').value,1);map.setAction('MoveX',{keyboardAxes:[{negative:['KeyA'],positive:['KeyD']}],gamepadAxes:[{axis:0}]});const s=input.sample(2);assert(action(s,'MoveX').released);assert.equal(action(s,'jump',1).held,true);assert.equal(action(s,'jump',1).pressed,false);pads=[pad(),pad()];key(target,'keyup','KeyD');input.sample(3);pads=[pad([-1,0]),pad()];assert.equal(action(input.sample(4),'MoveX').value,-1);}finally{input.dispose();}
});
