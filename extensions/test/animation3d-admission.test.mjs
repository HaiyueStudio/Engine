import assert from 'node:assert/strict';
import test from 'node:test';
import { importAnimationSource } from './helpers/private-animation-source.mjs';
const { Animation3DMixer }=await importAnimationSource('animation3d/Animation3DMixer.ts');
const { animation3DMixerRuntime: runtimeOf }=await importAnimationSource('animation3d/runtime/mixer/Animation3DMixerRuntimeStore.ts');
const scalar=id=>({id,target:{kind:'node-id',nodeId:id},path:'property',component:'test',property:'value',valueType:'scalar',valueSize:1});
const vector=id=>({id,target:{kind:'node-id',nodeId:id},path:'transform.translation',valueType:'vec3',valueSize:3});
const clip=(id,bindings)=>({format:'haiyue-animation3d-clip@1',id,name:id,duration:1,tracks:bindings.map((binding,index)=>({id:id+index,binding,interpolation:'linear',times:new Float32Array([0,1]),values:new Float32Array(binding.valueSize*2)})),events:[]});
for(const shared of [false,true])test(`failed action rolls back ${shared?'existing and new':'new'} bindings and permits corrected admission`,()=>{
 const mixer=new Animation3DMixer({revision:0,resolve:()=>null}),runtime=runtimeOf(mixer);
 const base=mixer.createAction(clip('base',[scalar('occupied'),...(shared?[scalar('shared')]:[])]));
 const count=runtime.liveBindingCount;
 for(let i=0;i<8;i++) {
  assert.throws(()=>mixer.createAction(clip('reject',[...(shared?[scalar('shared')]:[]),scalar('candidate'),vector('occupied')]),{id:'retry'}),/incompatible value contracts/);
  assert.equal(runtime.liveBindingCount,count);assert.equal(mixer.actions.length,1);assert.equal(mixer.getAction('retry'),null);
 }
 mixer.removeAction(base);assert.equal(runtime.liveBindingCount,0);
 const retry=mixer.createAction(clip('corrected',[vector('candidate')]),{id:'retry'});
 mixer.removeAction(retry);assert.equal(runtime.liveBindingCount,0);mixer.destroy();
});
test('successful actions still share one binding until their final release',()=>{
 const mixer=new Animation3DMixer({revision:0,resolve:()=>null}),runtime=runtimeOf(mixer);
 const a=mixer.createAction(clip('a',[scalar('shared')])),b=mixer.createAction(clip('b',[scalar('shared')]));
 assert.equal(runtime.liveBindingCount,1);mixer.removeAction(a);assert.equal(runtime.liveBindingCount,1);mixer.removeAction(b);assert.equal(runtime.liveBindingCount,0);mixer.destroy();
});
