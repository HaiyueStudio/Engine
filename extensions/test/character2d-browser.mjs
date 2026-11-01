import {createCharacterExample} from '/feature-consumer/browser/application.js';
import {getEngineDiagnosticsSnapshot} from '@haiyue/engine/diagnostics';
import {Entity,World} from '@haiyue/engine/ecs';
import {Transform2D} from '@haiyue/engine/components';
import {Physics2DBody,Physics2DSystem} from '@haiyue/engine/physics';
import {createBox2DPhysics2DBackend} from '@haiyue/engine/physics/backend';
import {createCharacter2D} from '@haiyue/extensions/character2d';
import {profile,validateCharacterBrowserResult} from '/extensions/test/character2d-browser-policy.mjs';
const result=document.querySelector('#result'),checks=[],shapes=[];
const assert=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};
const frames=async(n)=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);};
const adapter=engine=>{const i=engine.adapter.info;return{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description,isFallbackAdapter:i.isFallbackAdapter};};
let app;
try{
 for(const shape of profile.shapes){
  app=await createCharacterExample(document.querySelector('canvas'),{shape,gameRules:false});let device=app.engine.device;const gpuErrors=[];
  const watch=d=>d.addEventListener('uncapturederror',e=>gpuErrors.push(e.error.message));watch(device);device.pushErrorScope('validation');
  const initialAdapter=adapter(app.engine);assert(initialAdapter.isFallbackAdapter===false,shape+' uses an actual hardware adapter');
  await frames(profile.warmupFrames);app.engine.stop();const cadences=[];
  for(const hz of profile.cadences){
   app.reset();app.physics.update(app.scene.world,0,0);const start=app.controller.state.tick;app.controller.setVelocity([0,-120]);let captured=null,physicalUnaffectedByPresentation=true,time=0;
   const off=app.physics.onFixedStep(e=>{if(e.phase==='after'&&e.tick===start+profile.ticks)captured=app.controller.state;});
   for(let frame=0;frame<1000&&!captured;frame++){
    time+=1000/hz;app.physics.update(app.scene.world,time,1000/hz);
    const physical=app.actor.getComponent(Transform2D),before=[physical.x,physical.y];app.presentation.update(app.scene.world,time,1000/hz);
    physicalUnaffectedByPresentation&&=physical.x===before[0]&&physical.y===before[1];
   }
   off();assert(!!captured,shape+'/'+hz+' completed 120 actual fixed ticks');assert(captured.grounded&&!captured.stuck,shape+'/'+hz+' grounds without penetration');
   assert(physicalUnaffectedByPresentation,shape+'/'+hz+' presentation never writes the physics pose');
   cadences.push({hz,tickDelta:captured.tick-start,position:captured.position,velocity:captured.velocity,grounded:captured.grounded,stuck:captured.stuck,physicalUnaffectedByPresentation});
  }
  for(const c of cadences)assert(c.position.every((v,i)=>Math.abs(v-cadences[0].position[i])<1e-6),shape+' fixed trajectory is independent of '+c.hz+'Hz display deltas');
  const settle=()=>{app.reset();app.physics.update(app.scene.world,0,0);app.controller.setVelocity([0,-120]);for(let i=0;i<profile.ticks;i++){app.physics.update(app.scene.world,(i+1)*1000/60,1000/60);app.presentation.update(app.scene.world,(i+1)*1000/60,1000/60);}};
  settle();app.engine.run();await frames(profile.warmupFrames);await device.queue.onSubmittedWorkDone();
  const baseline=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals,samples=[];
  for(let iteration=0;iteration<profile.resourceCycles;iteration++){
   app.engine.stop();settle();app.engine.run();await frames(3);await device.queue.onSubmittedWorkDone();
   const gpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources,physics=app.physics.resourceSnapshot(),worlds=app.stats();
   assert(gpu.totals.resources<=baseline.resources&&gpu.totals.estimatedBytes<=baseline.estimatedBytes,shape+' cycle '+iteration+' has no GPU growth');
   assert(gpu.releasedOwnerResiduals===0,shape+' cycle '+iteration+' has no released-owner residue');
   assert(physics.bodies===5&&worlds.activeWorlds===1&&worlds.totalWorlds===1,shape+' cycle '+iteration+' reuses exactly one world');
   assert(app.engine.assetManager.size===0&&app.engine.assetManager.pendingJobCount===0,shape+' cycle '+iteration+' has no asset/job residue');
   samples.push({iteration,gpu:gpu.totals,physics,worlds:worlds.activeWorlds,releasedOwnerResiduals:gpu.releasedOwnerResiduals});
  }
  app.controller.setVelocity([60,0]);await frames(4);let lostPose=null;
  const lost=()=>{lostPose=app.controller.state.position;};app.engine.on('device-lost',lost);
  const oldError=await device.popErrorScope();if(oldError)gpuErrors.push(oldError.message);
  device.destroy();await device.lost;await app.engine.waitForRecovery();app.engine.off('device-lost',lost);
  device=app.engine.device;watch(device);device.pushErrorScope('validation');
  let first=null;const firstFrame=()=>{first=app.controller.state;app.engine.off('after-update',firstFrame);};app.engine.on('after-update',firstFrame);await frames(3);
  assert(first&&lostPose&&first.previousPosition[0]>=lostPose[0]-1e-6,shape+' recovery never interpolates from a pre-loss older pose');
  assert(app.stats().activeWorlds===1&&app.stats().totalWorlds===1,shape+' GPU recovery preserves its CPU physics world');
  const recoveredAdapter=adapter(app.engine);app.controller.setVelocity([0,0]);await device.queue.onSubmittedWorkDone();const error=await device.popErrorScope();if(error)gpuErrors.push(error.message);
  assert(gpuErrors.length===0,shape+' has no WebGPU validation errors');const coldStart=app.coldStart;
  app.dispose();const finalGpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals,worlds=app.stats();
  assert(finalGpu.resources===0&&finalGpu.estimatedBytes===0,shape+' destroys all tracked GPU resources');assert(worlds.activeWorlds===0,shape+' destroys its original physics world');
  shapes.push({shape,cadences,baseline,samples,adapter:initialAdapter,recoveredAdapter,recoveryReset:true,worlds,finalGpu,gpuErrors,coldStart});app=null;
 }
 // The same installed public code runs the frozen 32/128 CPU production cohort.
 const base=createBox2DPhysics2DBackend();let createdWorlds=0,destroyedWorlds=0;
 const backend={id:base.id,capabilities:base.capabilities,createWorld(o){createdWorlds++;const d=base.createWorld(o),destroy=d.destroy.bind(d);d.destroy=()=>{destroyedWorlds++;destroy();};return d;}};
 const world=new World(),physics=new Physics2DSystem({gravity:[0,0],backend}),characters=[];world.addSystem(physics);
 try{
  for(let i=0;i<profile.obstacles;i++)world.addEntity(new Entity().addComponent(new Transform2D({x:i*200,y:-100})).addComponent(new Physics2DBody({type:'static',width:180,height:20})));
  for(let i=0;i<profile.characters;i++){const entity=new Entity().addComponent(new Transform2D({x:i*200,y:0})).addComponent(new Physics2DBody({type:'kinematic',width:40,height:40}));world.addEntity(entity);const c=createCharacter2D({physics,entity});c.setVelocity([0,-120]);characters.push(c);}
  const started=performance.now();for(let i=0;i<profile.pressureFrames;i++)world.update((i+1)*1000/60,1000/60);
  const beforeDestroy=physics.resourceSnapshot(),grounded=characters.map(c=>c.state.grounded&&!c.state.stuck),positions=characters.map(c=>c.state.position),cpuWallMs=performance.now()-started;
  assert(grounded.every(Boolean),'all 32 actual installed characters settle against 128 obstacles');assert(createdWorlds===1&&beforeDestroy.bodies===160,'32 characters share exactly one original backend world');
  for(const c of characters)c.dispose();world.destroy();const afterDestroy=physics.resourceSnapshot();assert(afterDestroy.bodies===0&&afterDestroy.colliders===0&&destroyedWorlds===1,'pressure cohort releases every borrowed owner through its world');
  const pressure={characters:32,obstacles:128,frames:600,createdWorlds,destroyedWorlds,beforeDestroy,afterDestroy,grounded,positions,cpuWallMs};
  const report={schemaVersion:1,status:'passed',qualification:false,syntheticCadenceInjection:true,physicalInputQualification:false,checks,shapes,pressure,profile};
  const validation=validateCharacterBrowserResult(report);if(validation.status!=='passed')throw Error(validation.errors.join('; '));
  result.textContent=JSON.stringify(report);result.dataset.status='passed';
 }finally{for(const c of characters)c.dispose();if(!world.destroyed)world.destroy();}
}catch(error){try{app?.dispose();}catch{}result.textContent=JSON.stringify({status:'failed',qualification:false,checks,shapes,error:String(error.stack??error)});result.dataset.status='failed';}
