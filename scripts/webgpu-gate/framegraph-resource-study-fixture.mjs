import { createProductionScene } from './framegraph-production-scene.mjs';
import { getEngineGPUResourceTracker } from '../../engine/dist/experimental.js';
window.startSoak = async (spec, plan) => {
  const node=document.querySelector('#result'), canvas=document.querySelector('#canvas');
  const result={schemaVersion:1,status:'running',caseId:spec.id,plan,errors:[],frames:[],samples:[],events:[],startedAt:new Date().toISOString()};
  window.studySnapshot=()=>({...result,visible:document.visibilityState,focused:document.hasFocus(),observedAt:new Date().toISOString()});
  let scene;
  try {
    result.phase='scene-initialization';
    scene=await createProductionScene(canvas,spec);
    const engine=scene.engine, tracker=getEngineGPUResourceTracker(engine);
    const info=engine.adapter.info;
    result.adapter={vendor:info.vendor,architecture:info.architecture,isFallbackAdapter:info.isFallbackAdapter};
    result.initial=scene.snapshot();
    engine.device.addEventListener('uncapturederror',e=>result.errors.push(e.error.message));
    engine.on('device-lost',()=>result.errors.push('device-lost'));
    for(const name of ['visibilitychange','blur','focus']) window.addEventListener(name,()=>result.events.push({name,time:performance.now(),visible:document.visibilityState,focused:document.hasFocus()}));
    let pending=0,peakPending=0;
    const submittedDone=engine.device.queue.onSubmittedWorkDone.bind(engine.device.queue);
    Object.defineProperty(engine.device.queue,'onSubmittedWorkDone',{configurable:true,value:()=>{
      pending++; peakPending=Math.max(peakPending,pending);
      return submittedDone().finally(()=>pending--);
    }});
    const sample=elapsed=>{
      const s=tracker.getDebugSnapshot();
      return {elapsed,frame:s.frame,resources:s.resources.length,bytes:s.resources.reduce((n,r)=>n+r.estimatedBytes,0),byType:s.byType,
        ownerCount:s.owners.length,cacheCount:s.caches.length,cacheEntries:s.caches.reduce((n,c)=>n+c.entries,0),releasedOwnerResiduals:s.releasedOwnerResiduals,
        pendingCompletions:pending,peakPendingCompletions:peakPending,
        transient:engine.activeScene.render3DSystem._postScenePasses._postRenderer?._transientTextures?.stats ?? null,
        mirror:engine.activeScene.render3DSystem.lastMirrorTargetPoolStats};
    };
    let origin,next=0,cpuStart;
    result.phase='interactive-capture';
    await new Promise((resolve,reject)=>{
      const fail=e=>{engine.stop();reject(e.error??Error(e.message));};window.addEventListener('error',fail,{once:true});
      engine.on('update',({detail:{time}})=>{origin??=time;cpuStart=performance.now();scene.update(time-origin);});
      engine.on('after-update',({detail:{time}})=>{
        const elapsed=(time-origin)/1000;
        result.frames.push([time,cpuStart,performance.now(),document.visibilityState==='visible'?1:0,document.hasFocus()?1:0]);
        if(elapsed>=next){result.samples.push(structuredClone(sample(elapsed)));next+=plan.sampleSeconds;}
        if(elapsed>=plan.seconds){engine.stop();window.removeEventListener('error',fail);resolve();}
      });
      engine.run();
    });
    result.phase='final-gpu-drain';
    await engine.device.queue.onSubmittedWorkDone(); await Promise.resolve();
    result.drained=sample(plan.seconds); result.final=scene.snapshot();
    result.status='captured';result.phase='capture-complete';
  } catch(error) { result.error=error.stack;result.status='failed'; }
  finally { scene?.engine.stop(); }
  window.finishSoak=()=>{if(scene){scene.dispose();result.cleanup=scene.cleanup();const s=getEngineGPUResourceTracker(scene.engine).getDebugSnapshot();result.cleanupDetails={owners:s.owners.length,caches:s.caches.length,releasedOwnerResiduals:s.releasedOwnerResiduals};}result.finishedAt=new Date().toISOString();node.textContent=JSON.stringify(result);node.dataset.status=result.status;};
  window.soakReady=true;
};
