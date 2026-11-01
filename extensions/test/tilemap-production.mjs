import{createTilemapExample}from'/feature-consumer/browser/application.js';
import{getEngineDiagnosticsSnapshot}from'@haiyue/engine/diagnostics';
import{productionProfile as profile}from'./tilemap-browser-policy.mjs';
import{drainTilemap}from'./tilemap-browser-lifecycle.mjs';
const node=document.getElementById('result'),progress=document.getElementById('progress'),cohorts=[],errors=[];
let app,device,scope=false;
try{
 const workloads=[false,true].flatMap(atlas=>profile.mutationPercent.map(mutation=>({atlas,mutation})));let adapter;
 for(let round=1;round<=2;round++)for(const spec of round===2?[...workloads].reverse():workloads){
  const canvas=document.querySelector('canvas');canvas.width=1280;canvas.height=720;
  app=await createTilemapExample(canvas,{columns:512,rows:512,atlas:spec.atlas,samples:4});device=app.engine.device;
  const info=app.engine.adapter.info;adapter={vendor:info.vendor,description:info.description,isFallbackAdapter:info.isFallbackAdapter};if(adapter.isFallbackAdapter)throw Error('Native GPU required.');
  device.pushErrorScope('validation');scope=true;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  const cohort={...spec,round,warmup:[],samples:[],firstRenderedAt:null,captureStartedAt:null,completedAt:null,readiness:[],cleanup:null,coldStart:app.coldStart};cohorts.push(cohort);
  const indices=Uint32Array.from({length:Math.floor(512*512*spec.mutation/100)},(_,i)=>(i*8191+17)%(512*512));
  let frameStart=0,mutationMs=0,previous=null,first=null,readinessStarted=0;
  const update=()=>{frameStart=performance.now();for(const index of indices){const x=index%512,y=Math.floor(index/512);app.map.setCell(x,y,app.map.getCell(x,y)===1?2:1);}mutationMs=performance.now()-frameStart;};
  app.engine.on('update',update);
  try{await new Promise((resolve,reject)=>{
   const frame=event=>{try{
    const now=event.detail.time;if(first===null){first=now;cohort.firstRenderedAt=now;cohort.captureStartedAt=now+profile.warmupMs;}
    const stats=app.system.renderer.stats,before=previous??stats;
    const raw={time:now,intervalMs:event.detail.delta,cpuMutationMs:mutationMs,cpuUpdateRenderSubmitMs:performance.now()-frameStart,visible:document.visibilityState==='visible',focused:document.hasFocus(),vertexUploadCalls:stats.vertexUploadCalls-before.vertexUploadCalls,vertexUploadBytes:stats.vertexUploadBytes-before.vertexUploadBytes,draws:stats.draws-before.draws,residentChunks:stats.residentChunks,activeBytes:stats.activeBytes,retiredBytes:stats.retiredBytes,workingBytes:stats.workingBytes,cpuVertexBytes:stats.cpuVertexBytes,cpuMapBytes:stats.cpuMapBytes};previous=stats;
    (now<cohort.captureStartedAt?cohort.warmup:cohort.samples).push(raw);
    if(now>=cohort.captureStartedAt&&!cohort.gpuWorkingSet)cohort.gpuWorkingSet=getEngineDiagnosticsSnapshot(app.engine).gpuResources;
    if(readinessStarted<2){const readinessFrame=++readinessStarted;void device.queue.onSubmittedWorkDone().then(()=>cohort.readiness.push({frame:readinessFrame,completedAt:performance.now()}),reject);}
    progress.textContent='G08 production '+JSON.stringify({...spec,round,seconds:Math.floor((now-first)/1000)});
    if(now-cohort.captureStartedAt>=profile.durationMs){cohort.completedAt=now;app.engine.off('after-update',frame);app.engine.stop();resolve();}
   }catch(error){app.engine.off('after-update',frame);reject(error);}};app.engine.on('after-update',frame);
  });}finally{app.engine.off('update',update);app.engine.stop();}
  await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope();scope=false;if(validation)errors.push(validation.message);
  cohort.beforeSceneDestroy=getEngineDiagnosticsSnapshot(app.engine).gpuResources;
  const renderer=app.system.renderer;app.scene.destroy();cohort.cleanup=await drainTilemap(renderer,device);
  cohort.beforeAppDestroy=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals;
  await app.dispose();await device.lost;cohort.finalGpu=getEngineDiagnosticsSnapshot(app.engine).gpuResources.totals;app=null;
 }
 const result={schemaVersion:1,status:'passed',profile,adapter,cohorts,errors,qualification:false,measurement:{pacing:'actual original Engine requestAnimationFrame; no readback or queue waits in steady capture',readiness:'first two actual submitted frames complete; warmup starts at first rendered frame',gpu:'separate native timestamp matrix, identical in-flight/readback behavior for both variants',cold:'fresh application per cohort; one fresh Chrome profile for this complete run, not independent process cold-start qualification'}};
 node.textContent=JSON.stringify(result);node.dataset.status=result.status;
}catch(error){node.textContent=JSON.stringify({schemaVersion:1,status:'failed',profile,cohorts,errors,error:String(error.stack??error)});node.dataset.status='failed';}
finally{if(scope)try{await device.popErrorScope();}catch{}try{await app?.dispose();}catch{}}
