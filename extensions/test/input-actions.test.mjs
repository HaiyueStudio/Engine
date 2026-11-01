import test from 'node:test';
import assert from 'node:assert/strict';
import {InputActionMap} from '@haiyue/engine/input';
import {createInputBindingProfile} from '@haiyue/extensions/input-actions';
const key=(code,down)=>({device:'keyboard',code,down});
const pad=(axis=0,button=0,index=0)=>({device:'gamepad',index,snapshot:{connected:true,axes:[axis,0],buttons:[{pressed:button>=.5,value:button}]}});
const value=(map,code)=>map.sampleKeyboard([code]).find(a=>a.action==='MoveX')?.value??0;
test('button capture waits for release, commits once and leaves borrowed map alive on disposal',()=>{
 const map=new InputActionMap({Jump:{keys:['Space'],gamepadButtons:[0]}});let changes=0;const profile=createInputBindingProfile({map,onChange:()=>changes++});
 profile.beginRebind('Jump','button');assert(profile.offer(key('Enter',true)));assert.equal(changes,0);profile.offer(key('Enter',false));profile.offer(key('KeyJ',true));assert.equal(changes,1);assert.deepEqual(map.toJSON().Jump.keys,['KeyJ']);assert.deepEqual(map.toJSON().Jump.gamepadButtons,[0]);assert.equal(profile.offer(key('KeyJ',true)),false);profile.dispose();profile.dispose();assert.equal(map.sampleKeyboard(['KeyJ'])[0].value,1);assert.throws(()=>profile.exportData(),e=>e.code==='E_INPUT_PROFILE_INVALID');
});
test('directional keyboard capture preserves the other side, old snapshots and independent device alternatives',()=>{
 const map=InputActionMap.standardGameplay(),profile=createInputBindingProfile({map}),old=profile.exportData();profile.beginRebind('MoveX','negative');profile.offer(key('Enter',false));profile.offer(key('KeyH',true));assert.equal(value(map,'KeyH'),-1);assert.equal(value(map,'KeyD'),1);assert.equal(value(map,'KeyA'),0);assert(Object.isFrozen(old.bindings.MoveX.keyboardAxes[0].negative));assert(old.bindings.MoveX.keyboardAxes[0].negative.includes('KeyA'));assert.equal(map.sampleGamepad(pad(-1).snapshot).find(a=>a.action==='MoveX').value,-1);profile.dispose();
});
test('reject conflict preserves map, emits immutable detail, disarms held repeats and permits another choice',()=>{
 const map=new InputActionMap({Jump:{keys:['Space']},Fire:{keys:['KeyJ']}}),old=map.toJSON(),conflicts=[],profile=createInputBindingProfile({map,onConflict:c=>conflicts.push(c)});profile.beginRebind('Jump','button');profile.offer(key('Enter',false));assert.throws(()=>profile.offer(key('KeyJ',true)),e=>e.code==='E_INPUT_BINDING_CONFLICT');assert.equal(map.toJSON(),old);assert(Object.isFrozen(conflicts[0].sample));profile.offer(key('KeyJ',true));assert.equal(conflicts.length,1);profile.offer(key('KeyJ',false));profile.offer(key('KeyK',true));assert.deepEqual(map.toJSON().Jump.keys,['KeyK']);profile.dispose();
});
test('share and replace arbitrate physical aliases without removing unrelated controls or actions',()=>{
 for(const conflict of ['share','replace']){const map=new InputActionMap({Jump:{keys:['Space']},Fire:{keys:['KeyJ','KeyF'],pointerButtons:[0]},Move:{keyboardAxes:[{negative:['KeyJ'],positive:['KeyD']}]}}),profile=createInputBindingProfile({map,conflict});profile.beginRebind('Jump','button');profile.offer(key('Enter',false));profile.offer(key('KeyJ',true));assert.deepEqual(map.actionsForKey('KeyJ'),conflict==='share'?['Jump','Fire','Move']:['Jump']);assert.deepEqual(map.toJSON().Fire.pointerButtons,[0]);assert.equal(map.sampleKeyboard(['KeyF']).find(a=>a.action==='Fire').value,1);assert.equal(map.sampleKeyboard(['KeyD']).find(a=>a.action==='Move').value,1);profile.dispose();}
});
test('pointer and gamepad buttons capture after neutral while low analog noise cannot capture',()=>{
 const map=new InputActionMap({Fire:{}}),profile=createInputBindingProfile({map});profile.beginRebind('Fire','button');profile.offer({device:'pointer',button:0,down:false});profile.offer({device:'pointer',button:2,down:true});assert.deepEqual(map.toJSON().Fire.pointerButtons,[2]);profile.beginRebind('Fire','button');profile.offer(pad(0,1));assert.equal(map.toJSON().Fire.gamepadButtons,undefined);profile.offer(pad(.1,0));profile.offer(pad(.3,0));assert.equal(map.toJSON().Fire.gamepadButtons,undefined);profile.offer(pad(0,1));assert.deepEqual(map.toJSON().Fire.gamepadButtons,[0]);profile.dispose();
});
test('axis captures retain the opposite side and can invert a physical direction without altering GUI magnitude semantics',()=>{
 const map=InputActionMap.standardGameplay(),profile=createInputBindingProfile({map});profile.beginRebind('MoveX','negative');profile.offer(pad(.9));assert.equal(map.toJSON().MoveX.gamepadAxes.length,1);profile.offer(pad());profile.offer(pad(.49));profile.offer(pad(.8));assert.equal(map.sampleGamepad(pad(.8).snapshot).find(a=>a.action==='MoveX').value<0,true);assert.equal(map.sampleGamepad(pad(-1).snapshot).find(a=>a.action==='MoveX'),undefined);profile.dispose();
 const gui=InputActionMap.guiNavigation();assert.equal(gui.sampleGamepad(pad(-1).snapshot).find(a=>a.action==='left').value,1);
});
test('replace on one gamepad half-axis retains the opposite physical side in other actions',()=>{
 const map=new InputActionMap({Move:{gamepadAxes:[{axis:0}]},Target:{}}),profile=createInputBindingProfile({map,conflict:'replace'});profile.beginRebind('Target','negative');profile.offer(pad());profile.offer(pad(-1));assert.equal(map.sampleGamepad(pad(-1).snapshot).find(a=>a.action==='Move'),undefined);assert.equal(map.sampleGamepad(pad(1).snapshot).find(a=>a.action==='Move').value,1);assert.equal(map.sampleGamepad(pad(-1).snapshot).find(a=>a.action==='Target').value,-1);profile.dispose();
});
test('cancel, disconnect and distinct gamepad indices require a fresh neutral before another binding',()=>{
 const map=new InputActionMap({Jump:{keys:['Space']}}),profile=createInputBindingProfile({map}),old=map.toJSON();profile.beginRebind('Jump','button');profile.offer(pad());profile.offer({...pad(),snapshot:{connected:false,axes:[],buttons:[]}});profile.offer(pad(0,1));profile.offer(pad(0,1,1));assert.equal(map.toJSON(),old);profile.cancelRebind();assert.equal(profile.offer(key('KeyJ',true)),false);assert.equal(map.toJSON(),old);profile.beginRebind('Jump','button');profile.offer(pad());profile.offer(pad(0,1));assert.deepEqual(map.toJSON().Jump.gamepadButtons,[0]);profile.dispose();
});
test('versioned save/restore validates the whole descriptor atomically, preserves values, and does not own storage',()=>{
 const map=InputActionMap.standardGameplay(),profile=createInputBindingProfile({map}),saved=JSON.parse(JSON.stringify(profile.exportData()));map.setAction('Jump',{keys:['KeyJ']});profile.restore(saved);assert.deepEqual(map.toJSON().Jump.keys,['Space']);const old=map.toJSON();for(const data of [{...saved,version:2},{...saved,format:'wrong'},{...saved,bindings:{valid:{keys:['KeyV']},bad:{gamepadAxes:[{axis:0,scale:0}]}}}]){assert.throws(()=>profile.restore(data),e=>e.code==='E_INPUT_PROFILE_INVALID');assert.equal(map.toJSON(),old);}profile.dispose();
});
test('limits and malformed offers fail without partial writes, callbacks can cancel/dispose safely',()=>{
 const map=new InputActionMap({a:{keys:['KeyA']},b:{keys:['KeyB']}});assert.throws(()=>createInputBindingProfile({map,maxActions:1}),e=>e.code==='E_INPUT_PROFILE_INVALID');for(const options of [{maxActions:4097},{captureAxisThreshold:.15},{conflict:'bad'}])assert.throws(()=>createInputBindingProfile({map,...options}),e=>e.code==='E_INPUT_PROFILE_INVALID');
 let profile=createInputBindingProfile({map,maxActions:2});assert.throws(()=>profile.beginRebind('c','button'),e=>e.code==='E_INPUT_PROFILE_INVALID');profile.beginRebind('a','button');assert.throws(()=>profile.offer({device:'gamepad',index:0,snapshot:{connected:true,axes:[NaN],buttons:[]}}),e=>e.code==='E_INPUT_PROFILE_INVALID');profile.dispose();
 const old=map.toJSON();profile=createInputBindingProfile({map,conflict:'replace',onConflict:()=>profile.cancelRebind()});profile.beginRebind('a','button');profile.offer(key('Enter',false));profile.offer(key('KeyB',true));assert.equal(map.toJSON(),old);profile.dispose();
});
test('the frozen 128-action/100-rebind workload preserves immutable records and exact serialized round trips',()=>{
 const map=new InputActionMap(Object.fromEntries(Array.from({length:128},(_,i)=>['Action'+i,{keys:['Key'+i]}]))),profile=createInputBindingProfile({map}),first=profile.exportData();
 for(let i=0;i<100;i++){profile.beginRebind('Action'+i,'button');profile.offer(key('Enter',false));profile.offer(key('New'+i,true));const saved=JSON.parse(JSON.stringify(profile.exportData()));profile.restore(saved);assert.deepEqual(profile.exportData(),saved);}assert.equal(Object.keys(profile.exportData().bindings).length,128);assert.deepEqual(first.bindings.Action0.keys,['Key0']);profile.dispose();
});

test('sparse device/descriptor arrays reject atomically and observer errors cannot undo committed bindings',()=>{
 const map=new InputActionMap({Jump:{keys:['Space']}}),before=map.toJSON();let profile=createInputBindingProfile({map});profile.beginRebind('Jump','button');
 for(const snapshot of [{connected:true,axes:Array(1),buttons:[]},{connected:true,axes:[],buttons:Array(1)}])assert.throws(()=>profile.offer({device:'gamepad',index:0,snapshot}),e=>e.code==='E_INPUT_PROFILE_INVALID');
 assert.throws(()=>profile.restore({format:'haiyue-input-profile',version:1,bindings:{Jump:{keys:Array(1)}}}),e=>e.code==='E_INPUT_PROFILE_INVALID');assert.equal(map.toJSON(),before);profile.dispose();
 profile=createInputBindingProfile({map,onChange:()=>{throw Error('observer');}});profile.beginRebind('Jump','button');profile.offer(key('Enter',false));assert.throws(()=>profile.offer(key('KeyJ',true)),/observer/);assert.deepEqual(map.toJSON().Jump.keys,['KeyJ']);assert.equal(profile.offer(key('KeyJ',true)),false);profile.dispose();
});
