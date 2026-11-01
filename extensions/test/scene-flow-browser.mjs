import {createSceneFlowExample} from '/g03-consumer/browser/application.js';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';

const node=document.querySelector('#result'),checks=[],samples=[],errors=[];
const assert=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const frames=async(count=3)=>{for(let i=0;i<count;i++)await frame();};
const until=async(check,label)=>{const end=performance.now()+15000;while(performance.now()<end){if(check())return;await frame();}throw Error('Timeout: '+label);};
// Creation starts in a microtask. Observe a newly started load, not an old owner's
// abort cleanup; an 8ms request can start and finish between two display frames.
const loading=async(label)=>{const before=app.stats().loads,end=performance.now()+15000;while(performance.now()<end){const stats=app.stats();if(stats.loads>before&&stats.running>0)return;await new Promise(resolve=>setTimeout(resolve,0));}throw Error('Timeout: '+label);};
let app,audio;
try{
 app=await createSceneFlowExample(document.querySelector('canvas'),{assetUrl:new URL('/examples/scene-flow/level.json',location.href).href,delayMs:8});
 const adapterIdentity=()=>{const info=app.engine.adapter.info;return{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter,features:[...app.engine.device.features].sort()};};
 const initialAdapter=adapterIdentity();assert(initialAdapter.isFallbackAdapter===false,'actual GPU adapter is hardware');
 let device=app.engine.device;
 const observe=target=>target.addEventListener('uncapturederror',event=>errors.push(event.error.message));observe(device);device.pushErrorScope('validation');
 audio=new AudioContext();const borrowedGain=audio.createGain();borrowedGain.connect(audio.destination);
 const gui=app.persistentScene,root=app.root,initialMenu=app.engine.activeScene;
 let registrations=0;const originalRegistration=app.engine.registerDeviceRecoveryParticipant.bind(app.engine);
 app.engine.registerDeviceRecoveryParticipant=participant=>{registrations++;let active=true;const unregister=originalRegistration(participant);return()=>{if(!active)return;active=false;registrations--;unregister();};};
 await frames();
 const click=(x,y)=>{
  const canvas=document.querySelector('canvas'),rect=canvas.getBoundingClientRect();
  for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,isPrimary:true,pointerType:'mouse',button:0,buttons:type==='pointerdown'?1:0,clientX:rect.left+x,clientY:rect.top+y}));
 };
 const cold={...app.coldStart,navigation:performance.getEntriesByType('navigation')[0]?.toJSON(),workload:'initial menu and persistent GUI; no production qualification'};
 click(80,130);await until(()=>app.flow.progress.phase==='preparing','start button preparation');
 assert(app.engine.activeScene===initialMenu,'loading keeps the menu active');
 await until(()=>app.flow.progress.activeId==='level'&&app.flow.progress.phase==='active','level activation');await frames();
 assert(app.statusLabel.text==='Level ready','loading UI reports the completed phase');
 assert(initialMenu.state==='destroyed','successful switch retires only the old owned menu');
 assert(app.engine.activeScene.world.rootEntityList.length===33,'32 loaded descriptors bind 32 visible tiles plus camera');
 click(430,130);await until(()=>app.flow.progress.activeId==='menu','return button');await frames();
 assert(app.persistentScene===gui&&app.root===root&&gui.state==='created','the same borrowed GUI survives menu/loading/level/return');
 const failedMenu=app.engine.activeScene;
 const fail=await app.start({failIndex:3}).then(()=>null,error=>error);
 assert(fail&&app.engine.activeScene===failedMenu&&failedMenu.state==='active','single resource failure preserves the current menu');
 const cancel=app.start().then(()=>null,error=>error);await loading('cancellable load');app.flow.cancel();const cancelled=await cancel;
 assert(cancelled?.code==='E_SCENE_FLOW_ABORTED'&&app.engine.activeScene===failedMenu,'cancelled resource work cannot activate');
 const assetAbort=new AbortController();
 const assetTask=app.flow.transition({id:'asset-abort',create:()=>app.engine.createScene('2d'),assets:[{url:new URL('/examples/scene-flow/level.json?asset-abort',location.href).href,type:'scene-flow-level',signal:assetAbort.signal}]}).then(()=>null,error=>error);
 await loading('per-asset signal cancellation');assetAbort.abort();const assetError=await assetTask;
 assert(assetError?.code==='E_SCENE_FLOW_ABORTED'&&app.flow.progress.phase==='cancelled'&&app.engine.activeScene===failedMenu,'individual asset cancellation is classified as cancellation and preserves the menu');
 const replaced=app.start().then(()=>null,error=>error);await loading('replace pending load');await app.back();const replacement=await replaced;
 assert(replacement?.code==='E_SCENE_FLOW_SUPERSEDED'&&app.flow.progress.activeId==='menu','newest transition wins');
 await app.start({requests:256});await frames();assert(app.flow.progress.total===256&&app.stats().peakRunning<=4,'256 request stress preserves the actual loader bound');await app.back();await frames();
 // Warm finite shader/font variants before comparing steady resources. Cold data above is retained separately.
 await app.start();await frames();await app.back();await frames();await device.queue.onSubmittedWorkDone();
 const snapshot=()=>({gpu:getEngineDiagnosticsSnapshot(app.engine).gpuResources,assets:app.engine.assetManager.getDebugSnapshot(),stats:app.stats(),registrations});
 const baseline=snapshot();
 for(let iteration=0;iteration<20;iteration++){
  const start=performance.now();await app.start();await frames();const loadedAt=performance.now();await app.back();await frames();await device.queue.onSubmittedWorkDone();const current=snapshot();
  assert(current.assets.records.length===0&&current.assets.uploads.pendingTasks===0&&current.stats.running===0,'cycle '+iteration+' has no asset/job/upload residue');
  assert(current.registrations===baseline.registrations,'cycle '+iteration+' has balanced recovery registrations');
  assert(current.gpu.totals.resources<=baseline.gpu.totals.resources&&current.gpu.totals.estimatedBytes<=baseline.gpu.totals.estimatedBytes,'cycle '+iteration+' has no steady GPU resource growth');
  assert(current.gpu.releasedOwnerResiduals===0,'cycle '+iteration+' has no released-owner GPU residue');
  samples.push({iteration,loadMs:loadedAt-start,roundTripMs:performance.now()-start,...current});
 }
 for(let iteration=0;iteration<100;iteration++){
  const task=app.start().then(()=>null,error=>error);await loading('cancel '+iteration);app.flow.cancel();const error=await task;assert(error?.code==='E_SCENE_FLOW_ABORTED','cancellation '+iteration+' is explicit');
 }
 await frames();await device.queue.onSubmittedWorkDone();
 assert(app.engine.assetManager.size===0&&app.engine.assetManager.pendingJobCount===0,'100 cancellations leave no resource records or jobs');
 assert(app.stats().peakRunning<=4,'loader concurrency remained bounded across all workflows');
 const scopeError=await device.popErrorScope();if(scopeError)errors.push(scopeError.message);
 const ready=await app.flow.prepare({id:'device-loss',create:()=>app.engine.createScene('2d'),assets:[{url:new URL('/examples/scene-flow/level.json?device-loss',location.href).href,type:'scene-flow-level'}]});
 const previous=app.engine.activeScene;device.destroy();await device.lost;await app.engine.waitForRecovery();
 assert(app.engine.activeScene===previous&&previous.state==='active','real GPU device loss preserves the active scene through recovery');
 assert(ready.scene.state==='destroyed'&&app.flow.progress.phase==='cancelled','real GPU loss invalidates the prepared scene');
 let rejected=false;try{ready.commit();}catch{rejected=true;}assert(rejected,'device-stale prepared scene cannot commit');
 device=app.engine.device;observe(device);device.pushErrorScope('validation');await app.start();await frames();await app.back();await frames();await device.queue.onSubmittedWorkDone();
 assert(app.flow.progress.activeId==='menu'&&app.engine.assetManager.size===0,'a new transaction succeeds after real device recovery');
 const afterLoss=snapshot(),recoveredAdapter=adapterIdentity();app.flow.dispose();await frames();await device.queue.onSubmittedWorkDone();
 assert(gui.state==='created'&&root===app.root&&audio.state!=='closed','flow disposal preserves borrowed GUI and audio ownership');
 assert(app.engine.activeScene===null&&app.engine.assetManager.size===0&&registrations===0,'flow disposal releases all owned scenes and registrations');
 const finalScopeError=await device.popErrorScope();if(finalScopeError)errors.push(finalScopeError.message);
 app.dispose();assert(gui.state==='destroyed','application teardown finally destroys its own persistent GUI');
 const afterDestroy=getEngineDiagnosticsSnapshot(app.engine).gpuResources;
 assert(afterDestroy.totals.resources===0&&afterDestroy.totals.estimatedBytes===0,'application teardown leaves zero tracked GPU resources');
 assert(errors.length===0,'no WebGPU validation errors');
 borrowedGain.disconnect();await audio.close();
 node.textContent=JSON.stringify({schemaVersion:1,suite:'g03.scene-flow.packed-native',status:'passed',qualification:false,checks,adapters:{initial:initialAdapter,recovered:recoveredAdapter},coldStart:cold,steady:{baseline,samples,afterLoss},afterDestroy,stats:app.stats(),gpuErrors:errors,syntheticPointerInputs:true,physicalInputQualification:false});node.dataset.status='passed';
}catch(error){
 try{app?.dispose();}catch{}try{await audio?.close();}catch{}
 node.textContent=JSON.stringify({schemaVersion:1,suite:'g03.scene-flow.packed-native',status:'failed',qualification:false,checks,samples,errors,error:String(error.stack??error)});node.dataset.status='failed';
}
