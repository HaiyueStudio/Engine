import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createSceneFlow } from '@haiyue/extensions/scene-flow';
import { HaiyueEngine, EngineErrorCode } from '@haiyue/engine/core';
import { AssetManager } from '@haiyue/engine/assets';
import { Scene } from '@haiyue/engine/scene';
import { createMockEngine, createMockGpuDevice } from '../../engine/test/helpers.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const fresh = engine => new Scene(engine,{render3D:false,render2D:false,gui:false});
async function until(check) { for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('Expected asynchronous checkpoint was not reached'); }
function fixture(load=async url=>({url})) {
 const engine=createMockEngine(),participants=new Set(),disposed=[],manager=new AssetManager(createMockGpuDevice());
 manager.registerLoader({type:'unit',extensions:['unit'],load,dispose:value=>disposed.push(value.url)});
 Object.assign(engine,{assetManager:manager,_activeScene:null,id:'scene-flow-test',_assertNotTerminal(){},registerDeviceRecoveryParticipant(p){participants.add(p);return()=>participants.delete(p);}});
 Object.defineProperty(engine,'activeScene',{get(){return this._activeScene;}});
 engine.switchScene=HaiyueEngine.prototype.switchScene;
 const current=fresh(engine);engine.switchScene(current);
 return {engine,manager,current,disposed,participants,close(){engine.activeScene?.destroy();current.destroy();manager.dispose();}};
}

test('32 resource preparation has a real four-request bound, ordered assignment and separate activation',async()=>{
 const jobs=new Map(),order=[],progress=[];let running=0,max=0;
 const f=fixture(async url=>{running++;max=Math.max(max,running);const job=deferred();jobs.set(url,job);try{return await job.promise;}finally{running--;}});
 const flow=createSceneFlow({engine:f.engine,onProgress:p=>progress.push(p)});
 try{
  const task=flow.prepare({id:'level',create:()=>fresh(f.engine),assets:Array.from({length:32},(_,i)=>({url:i+'.unit',assign:value=>order.push(value.url)}))});
  await until(()=>jobs.size===4);assert.equal(max,4);assert.deepEqual(order,[]);assert.equal(f.engine.activeScene,f.current);
  const completed=new Set();
  while(completed.size<32){const entry=[...jobs.keys()].reverse().find(k=>!completed.has(k));if(entry){jobs.get(entry).resolve({url:entry});completed.add(entry);}await tick();}
  const prepared=await task;assert.equal(max,4);assert.equal(f.engine.activeScene,f.current);assert.equal(flow.progress.phase,'ready');
  assert.deepEqual(order,Array.from({length:32},(_,i)=>i+'.unit'));assert.ok(progress.every(Object.isFrozen));
  assert.equal(prepared.commit(),prepared.scene);prepared.dispose();assert.equal(prepared.scene.state,'active');flow.cancel();assert.equal(flow.progress.phase,'active');
  const next=await flow.transition({id:'menu',create:()=>fresh(f.engine)});assert.equal(prepared.scene.state,'destroyed');assert.equal(next.state,'active');assert.equal(f.current.state,'inactive');
  flow.dispose();assert.equal(next.state,'destroyed');assert.equal(f.current.state,'inactive');assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);
 }finally{flow.dispose();f.close();}
});

test('one failed resource rolls back all new handles without any assign or old-scene mutation',async()=>{
 const fail=deferred();const f=fixture(url=>url==='bad.unit'?fail.promise:Promise.resolve({url})),flow=createSceneFlow({engine:f.engine});let assigned=0,scene;
 try{
  const task=flow.prepare({id:'bad',create:()=>scene=fresh(f.engine),assets:['good.unit',{url:'bad.unit',assign:()=>assigned++},'other.unit']});task.catch(()=>{});
  await until(()=>f.manager.getJobState('asset:unit:good.unit')==='ready');fail.reject(Error('single resource failure'));
  await assert.rejects(task,/single resource failure/);assert.equal(assigned,0);assert.equal(scene.state,'destroyed');assert.equal(f.engine.activeScene,f.current);assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);assert.equal(flow.progress.phase,'failed');
 }finally{flow.dispose();f.close();}
});

test('an assignment failure releases the prepared scene and never assigns later entries or switches the current scene',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine});let scene;const order=[];
 try{
  await assert.rejects(flow.prepare({id:'bad binding',create:()=>scene=fresh(f.engine),assets:[{url:'first.unit',assign:()=>{order.push(0);throw Error('binding failed');}},{url:'second.unit',assign:()=>order.push(1)}]}),/binding failed/);
  assert.deepEqual(order,[0]);assert.equal(scene.state,'destroyed');assert.equal(f.engine.activeScene,f.current);assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);assert.equal(flow.progress.phase,'failed');
 }finally{flow.dispose();f.close();}
});

test('supersession rejects promptly and destroys a late factory scene after completion',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine}),factory=deferred();let signal;
 try{
  const old=flow.prepare({id:'slow',create:s=>{signal=s;return factory.promise;}});old.catch(()=>{});await until(()=>signal);
  const next=await flow.transition({id:'new',create:()=>fresh(f.engine)});await assert.rejects(old,e=>e.code===EngineErrorCode.SceneFlowSuperseded);assert.equal(signal.aborted,true);
  const late=fresh(f.engine);factory.resolve(late);await until(()=>late.state==='destroyed');assert.equal(f.engine.activeScene,next);assert.equal(flow.progress.activeId,'new');
 }finally{flow.dispose();f.close();}
});

test('100 cancellations release records promptly, permit immediate same-key retry and retire late values once',async()=>{
 const jobs=[],f=fixture((url)=>{const job=deferred();jobs.push(job);return job.promise;}),flow=createSceneFlow({engine:f.engine});let assignments=0;
 try{
  for(let i=0;i<100;i++){
   const task=flow.prepare({id:'retry',create:()=>fresh(f.engine),assets:[{url:'shared.unit',assign:()=>assignments++}]});task.catch(()=>{});await until(()=>jobs.length===i+1);flow.cancel();await assert.rejects(task,e=>e.code===EngineErrorCode.SceneFlowAborted&&e.recovery==='ignore'&&e.recoverable===true);assert.equal(f.manager.size,0);assert.equal(f.manager.pendingJobCount,0);
  }
  jobs.forEach(job=>job.resolve({url:'retired.unit'}));await until(()=>f.disposed.length===100);assert.equal(assignments,0);assert.equal(f.engine.activeScene,f.current);assert.equal(f.participants.size,0);
 }finally{flow.dispose();f.close();}
});

for(const location of ['flow','request','texture-options'])test(location+' cancellation preserves an independent owner of a deduplicated resource',async()=>{
 const job=deferred(),f=fixture(()=>job.promise),flow=createSceneFlow({engine:f.engine}),controller=new AbortController();
 const external=f.manager.loadAsset('unit','shared.unit');
 try{
  const asset={url:'shared.unit',...(location==='request'?{signal:controller.signal}:{}),...(location==='texture-options'?{options:{signal:controller.signal}}:{})};
  const task=flow.prepare({id:'borrow',create:()=>fresh(f.engine),assets:[asset]});task.catch(()=>{});await until(()=>f.manager.getRefCount('asset:unit:shared.unit')===2);
  if(location==='flow')flow.cancel();else controller.abort('one owner cancelled');await assert.rejects(task,e=>e.code===EngineErrorCode.SceneFlowAborted);assert.equal(flow.progress.phase,'cancelled');assert.equal(f.manager.getRefCount('asset:unit:shared.unit'),1);
  job.resolve({url:'shared.unit'});const handle=await external;assert.equal(handle.value.url,'shared.unit');assert.deepEqual(f.disposed,[]);handle.release();assert.deepEqual(f.disposed,['shared.unit']);assert.equal(f.manager.size,0);
 }finally{flow.dispose();f.close();}
});

test('ready scene cancellation, external destruction and device loss each invalidate commit and release listeners',async()=>{
 for(const action of ['cancel','destroy','device-loss','signal']){
  const f=fixture(),flow=createSceneFlow({engine:f.engine}),controller=new AbortController();
  try{
   const ready=await flow.prepare({id:action,create:()=>fresh(f.engine),assets:['texture.unit'],signal:controller.signal});assert.equal(f.participants.size,1);
   if(action==='cancel')flow.cancel();if(action==='destroy')ready.scene.destroy();if(action==='device-loss')for(const p of [...f.participants])await p.suspendForDeviceLoss();if(action==='signal')controller.abort();
   assert.throws(()=>ready.commit());ready.dispose();ready.dispose();assert.equal(f.engine.activeScene,f.current);assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);
   const replacement=await flow.transition({id:'recover',create:()=>fresh(f.engine),assets:['texture.unit']});assert.equal(replacement.state,'active');
  }finally{flow.dispose();f.close();}
 }
});

test('active, destroyed and already claimed scenes are rejected without taking borrowed ownership',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine}),other=createSceneFlow({engine:f.engine});
 try{
  await assert.rejects(flow.prepare({id:'active',create:()=>f.current}),e=>e.code===EngineErrorCode.GameplayInvalidInput);assert.equal(f.current.state,'active');
  const dead=fresh(f.engine);dead.destroy();await assert.rejects(flow.prepare({id:'dead',create:()=>dead}));
  const ready=await flow.prepare({id:'owned',create:()=>fresh(f.engine)});await assert.rejects(other.prepare({id:'steal',create:()=>ready.scene}));assert.equal(ready.scene.state,'created');ready.commit();ready.dispose();assert.equal(ready.scene.state,'active');
 }finally{other.dispose();flow.dispose();f.close();}
});

test('activation failure restores the actual previous scene and destroys only the new owner',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine});
 try{
  const ready=await flow.prepare({id:'bad switch',create:()=>fresh(f.engine),assets:['a.unit']});const original=f.engine.switchScene;
  f.engine.switchScene=function(scene,options){original.call(this,scene,options);if(scene===ready.scene)throw Error('activation failed');return this;};
  assert.throws(()=>ready.commit(),/activation failed/);assert.equal(f.engine.activeScene,f.current);assert.equal(f.current.state,'active');assert.equal(ready.scene.state,'destroyed');assert.equal(f.manager.size,0);assert.equal(flow.progress.phase,'failed');
 }finally{flow.dispose();f.close();}
});

test('a throwing deactivation restores the selected old scene before rejecting activation',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine});const original=f.engine.switchScene;
 try{
  const ready=await flow.prepare({id:'bad deactivation',create:()=>fresh(f.engine),assets:['a.unit']});
  f.engine.switchScene=function(scene,options){if(scene===ready.scene){f.current.deactivate();throw Error('deactivation hook failed');}return original.call(this,scene,options);};
  assert.throws(()=>ready.commit(),/deactivation hook failed/);assert.equal(f.engine.activeScene,f.current);assert.equal(f.current.state,'active');assert.equal(ready.scene.state,'destroyed');assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);
 }finally{f.engine.switchScene=original;flow.dispose();f.close();}
});

test('a failed rollback reports SceneInvalidState and still releases every new handle and registration',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine});const original=f.engine.switchScene;
 try{
  const ready=await flow.prepare({id:'bad rollback',create:()=>fresh(f.engine),assets:['a.unit']});
  f.engine.switchScene=function(scene,options){if(scene===f.current)throw Error('rollback hook failed');original.call(this,scene,options);if(scene===ready.scene)throw Error('activation failed');return this;};
  assert.throws(()=>ready.commit(),error=>error.code===EngineErrorCode.SceneInvalidState&&error.cause instanceof AggregateError);
  assert.equal(ready.scene.state,'destroyed');assert.notEqual(f.current.state,'destroyed');assert.equal(f.manager.size,0);assert.equal(f.participants.size,0);assert.equal(flow.progress.phase,'failed');
 }finally{f.engine.switchScene=original;flow.dispose();f.close();}
});

test('prepare snapshots caller data; invalid requests cannot cancel an existing ready transaction',async()=>{
 const f=fixture(),assets=[{url:'a.unit'}];let created=0,request={id:'snapshot',create:()=>{created++;return fresh(f.engine);},assets};
 const flow=createSceneFlow({engine:f.engine,onProgress:p=>{if(p.phase==='preparing'){request.create=()=>{throw Error('mutated factory');};assets[0].url='mutated.unit';}}});
 try{
  const ready=await flow.prepare(request);assert.equal(created,1);assert.equal(f.manager.hasAsset('asset:unit:a.unit'),true);
  for(const invalid of [{assets:Array(257).fill('a.unit')},{assets:new Array(2)},{signal:{}},{assets:[{url:'a.unit',signal:{}}]}]){
   await assert.rejects(flow.prepare({id:'invalid',create:()=>fresh(f.engine),...invalid}),e=>e.code===EngineErrorCode.GameplayInvalidInput);
  }
  assert.equal(ready.commit(),ready.scene);assert.throws(()=>ready.commit());
 }finally{flow.dispose();f.close();}
});

test('retained scenes stay owned until flow disposal; application-owned scene and resources survive',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine,previous:'retain'});const shared=await f.current.load('common.unit');
 try{
  const a=await flow.transition({id:'a',create:()=>fresh(f.engine),assets:['common.unit']}),b=await flow.transition({id:'b',create:()=>fresh(f.engine),assets:['common.unit']});
  assert.equal(a.state,'inactive');assert.equal(b.state,'active');assert.equal(f.manager.getRefCount('asset:unit:common.unit'),3);
  flow.dispose();flow.dispose();assert.equal(a.state,'destroyed');assert.equal(b.state,'destroyed');assert.equal(f.current.state,'inactive');assert.equal(f.manager.getRefCount('asset:unit:common.unit'),1);assert.equal(shared.url,'common.unit');
 }finally{flow.dispose();f.close();}
});

test('256 assets use the configured bound with no duplicate decode and deterministic progress',async()=>{
 let running=0,max=0,calls=0;const f=fixture(async url=>{running++;max=Math.max(max,running);calls++;await tick();running--;return {url};}),flow=createSceneFlow({engine:f.engine,concurrency:8});const progress=[];
 const observed=createSceneFlow({engine:f.engine,concurrency:8,onProgress:p=>progress.push(p)});
 try{
  await observed.transition({id:'stress',create:()=>fresh(f.engine),assets:Array.from({length:256},(_,i)=>(i%32)+'.unit')});assert.ok(max<=8);assert.equal(calls,32);assert.equal(f.manager.getDebugSnapshot().records.reduce((n,r)=>n+r.refs,0),256);assert.equal(observed.progress.completed,256);
  assert.ok(progress.every((p,i)=>i===0||p.completed>=progress[i-1].completed));observed.dispose();assert.equal(f.manager.size,0);assert.equal(f.disposed.length,32);
 }finally{observed.dispose();flow.dispose();f.close();}
});

test('pre-aborted requests never invoke factories; dispose retires a factory that ignores cancellation',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine}),controller=new AbortController();controller.abort();let calls=0;
 try{
  await assert.rejects(flow.prepare({id:'pre-aborted',create:()=>{calls++;return fresh(f.engine);},signal:controller.signal}));assert.equal(calls,0);
  const factory=deferred();let entered=false;const task=flow.prepare({id:'late',create:()=>{entered=true;return factory.promise;}});task.catch(()=>{});await until(()=>entered);flow.dispose();await assert.rejects(task);const scene=fresh(f.engine);factory.resolve(scene);await until(()=>scene.state==='destroyed');assert.equal(flow.progress.phase,'disposed');assert.equal(f.current.state,'active');
 }finally{flow.dispose();f.close();}
});

test('limits reject non-finite/fractional input before work; progress reentry respects newest generation',async()=>{
 const f=fixture();
 try{
  for(const concurrency of [0,17,NaN,Infinity,1.5,null])assert.throws(()=>createSceneFlow({engine:f.engine,concurrency}));
  for(const maxRequests of [0,4097,NaN,1.5,null])assert.throws(()=>createSceneFlow({engine:f.engine,maxRequests}));
  let replacement;let flow;flow=createSceneFlow({engine:f.engine,onProgress:p=>{if(p.id==='outer'&&p.phase==='ready')replacement=flow.transition({id:'inner',create:()=>fresh(f.engine)});}});
  try{await assert.rejects(flow.prepare({id:'outer',create:()=>fresh(f.engine)}),e=>e.code===EngineErrorCode.SceneFlowSuperseded);await replacement;assert.equal(flow.progress.activeId,'inner');}finally{flow.dispose();}
 }finally{f.close();}
});

test('scene resource preparation uses the existing upload scheduler exactly once per logical load',async()=>{
 const f=fixture(),flow=createSceneFlow({engine:f.engine});let uploaded=0;
 f.manager.registerLoader({type:'scheduled',load:async(url,context)=>{
  context.setPhase('uploading');return context.scheduleUpload({label:url,bytes:1024,upload:()=>{uploaded++;return {url};}});
 }});
 try{
  await flow.transition({id:'upload',create:()=>fresh(f.engine),assets:Array.from({length:32},(_,i)=>({url:i+'.scheduled',type:'scheduled'}))});
  const snapshot=f.manager.getDebugSnapshot().uploads;assert.equal(uploaded,32);assert.equal(snapshot.uploadCalls,32);assert.equal(snapshot.uploadedBytes,32768);assert.equal(snapshot.pendingTasks,0);
  flow.dispose();assert.equal(f.manager.size,0);
 }finally{flow.dispose();f.close();}
});

test('progress observer errors cannot corrupt ownership, and cancellation from committing cannot activate',async t=>{
 const f=fixture();let flow;const messages=[];t.mock.method(console,'error',(...args)=>messages.push(args));
 try{
  flow=createSceneFlow({engine:f.engine,onProgress(){throw Error('observer error');}});const scene=await flow.transition({id:'observed',create:()=>fresh(f.engine),assets:['a.unit']});assert.equal(scene.state,'active');assert.ok(messages.length>0);flow.dispose();assert.equal(f.manager.size,0);
  f.engine.switchScene(f.current);flow=createSceneFlow({engine:f.engine,onProgress:p=>{if(p.phase==='committing')flow.cancel();}});
  const ready=await flow.prepare({id:'cancel-at-commit',create:()=>fresh(f.engine),assets:['b.unit']});assert.throws(()=>ready.commit(),e=>e.code===EngineErrorCode.SceneFlowAborted);assert.equal(f.engine.activeScene,f.current);assert.equal(ready.scene.state,'destroyed');assert.equal(f.participants.size,0);assert.equal(f.manager.size,0);
 }finally{flow?.dispose();f.close();}
});
