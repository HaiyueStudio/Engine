import {observeG05CreationCosts} from './deferred-g05-cost-observer.mjs';
import {encodeFrameGraphPixels} from './framegraph-pixel-oracle.mjs';
import {captureG05ResourceSnapshot} from './deferred-g05-memory-policy.mjs';
import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,
 createDeferredReferenceProfile,resetRealRendererBenchmarkMetrics,createRealRendererGpuTimestampProbe,getRealRendererBenchmarkMetrics,RenderView,GtaoPass,SaoPass,SsaoPass} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {installG05RoomScene} from './deferred-g05-room-scene.mjs';
import {G05_ROOM_CASES} from './deferred-g05-policy.mjs';
import {readFloatTexture,createFloatTextureReadback} from './float-texture-readback.mjs';
const node=document.querySelector('#result'),progress=document.querySelector('#progress');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}

// Installed only after both timing populations. Capture before another view reuses scene color.
async function captureViews(state,scene){
 const owner=state.render3d._postScenePasses,original=owner.runPostProcess,readbacks=[];
 owner.runPostProcess=function(encoder,...args){
  const result=original.call(this,encoder,...args),frame=args[3];
  const rb=createFloatTextureReadback(state.device,this._postRenderer.sceneTexture);
  readbacks.push({key:frame.viewKey,rb});rb.encode(encoder);return result;
 };
 try{
  scene.update(0);await runRealRendererBenchmarkFrame(state);
  if(readbacks.length!==state.views.length)throw Error('Missing per-view HDR capture');
  const images=[];
  for(let i=0;i<state.views.length;i++){
   const view=state.views[i],capture=readbacks[i];
   if(capture.key!==view.key)throw Error(`HDR view identity mismatch: ${capture.key} vs ${view.key}`);
   images.push({key:view.key,hdr:await capture.rb.read(),ldr:await readFloatTexture(state.device,view.target.colorTexture)});
  }
  return images;
 }finally{owner.runPostProcess=original;for(const item of readbacks)item.rb.destroy();}
}
function compareViews(actual,expected,algorithm,width,height){
 return actual.map((a,index)=>{
  const e=expected[index];let maxHdrDelta=0,maxLdrDelta=0,maxHdrToleranceRatio=0,litPixels=0;
  if(a.key!==e.key||a.hdr.length!==width*height*4||a.ldr.length!==a.hdr.length||e.hdr.length!==a.hdr.length||e.ldr.length!==a.ldr.length)throw Error('Pixel population changed');
  for(let i=0;i<a.hdr.length;i++){
   const reference=algorithm==='tiled'?e.hdr[i]:a.hdr[i],delta=Math.abs(a.hdr[i]-e.hdr[i]);
   const ratio=delta/Math.max(.002,Math.abs(reference)*.002),ldr=Math.abs(a.ldr[i]-e.ldr[i])*255;
   if(!Number.isFinite(ratio)||!Number.isFinite(ldr)||ratio>1||ldr>2.001)throw Error(`Room parity ${a.key}/${i}: HDR ratio ${ratio}, LDR ${ldr}`);
   maxHdrDelta=Math.max(maxHdrDelta,delta);maxHdrToleranceRatio=Math.max(maxHdrToleranceRatio,ratio);maxLdrDelta=Math.max(maxLdrDelta,ldr);
   if(i%4===0&&a.hdr[i]+a.hdr[i+1]+a.hdr[i+2]>0)litPixels++;
  }
  if(litPixels<width*height*.1)throw Error('Invisible room image');
  return {key:a.key,checkedComponents:a.hdr.length,maxHdrDelta,maxHdrToleranceRatio,maxLdrDelta,litPixels};
 });
}
async function run(){
 const query=new URLSearchParams(location.search),caseId=query.get('caseId'),algorithm=query.get('algorithm'),full=query.get('full')==='1',moving=query.get('moving')==='1';
 if(!Object.hasOwn(G05_ROOM_CASES,caseId)||!['tiled','reference'].includes(algorithm))throw Error('Invalid G05 workload');
 const ao=query.get('ao');if(!['off','gtao','sao','ssao'].includes(ao))throw Error('Unknown AO cost mode');
 const c=G05_ROOM_CASES[caseId],warmup=full?120:2,samples=full?300:3;
 const adapter=await navigator.gpu.requestAdapter({powerPreference:query.get('powerPreference')??'high-performance'});
 if(!adapter||adapter.info.isFallbackAdapter||!adapter.features.has('timestamp-query'))throw Error('Native GPU with timestamp-query required');
 const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[];
 device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
 const costs=observeG05CreationCosts(device),costCounts={};
 const targets=Array.from({length:c.views},()=>createAuditTarget(device,c.width,c.height,true));let state,probe,result,failure,budgetOwner;
 try{
  const setupStarted=performance.now();
  state=await createRealRendererBenchmarkScenario({device,target:targets[0],entityCount:0,viewCount:c.views,renderProfile:'batched'});
  state.targets=targets;state.views=state.views.map((v,i)=>new RenderView({key:v.key,camera:v.camera,target:targets[i]}).snapshot());
  const scene=installG05RoomScene(state,{count:c.count,overlap:c.overlap,moving});
  if(ao!=='off')state.render3d.passes.push(new ({gtao:GtaoPass,sao:SaoPass,ssao:SsaoPass}[ao])({radius:2,intensity:3,resolutionScale:1,quality:'high'}));
  costs.stage('profile');
  const profileStart=performance.now(),profile=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{tiled:{}}:{});
  budgetOwner=profile.backend;
  const profileInitializeMs=performance.now()-profileStart,scenarioSetupMs=performance.now()-setupStarted;
  costs.stage('first-frame');
  resetRealRendererBenchmarkMetrics(state);scene.update(0);await runRealRendererBenchmarkFrame(state);
  const cold={scenarioSetupMs,profileInitializeMs,firstFrame:{...state.lastFrameTiming},metrics:getRealRendererBenchmarkMetrics(state)};
  costCounts.cold=costs.count();costs.stage('warmup');
  probe=createRealRendererGpuTimestampProbe(state,{includeCompute:true});
  for(let i=0;i<warmup;i++){scene.update(i);await runRealRendererBenchmarkFrame(state);}
  const warmResources=state.tracker.getDebugSnapshot().byType,resourceAttribution={warm:captureG05ResourceSnapshot(state.tracker)};
  costCounts.warm=costs.count();costs.stage('cpu');
  resetRealRendererBenchmarkMetrics(state);const cpuSourceBefore={...profile.backend.uploadStats},cpu=[];
  for(let i=0;i<samples;i++){
   progress.textContent=`${caseId}/${algorithm} CPU ${i+1}/${samples}`;
   const start=performance.now();scene.update(i);const authoredMutationMs=performance.now()-start;
   await runRealRendererBenchmarkFrame(state);const t=state.lastFrameTiming;
   if(t.gpuTimestamp!==null)throw Error('Timestamp probe contaminated CPU population');
   cpu.push({frame:i,timestampQuery:false,cpuRuntimeMs:t.runtimeFrameMs,cpuUpdateMs:t.cpuUpdateMs,cpuRecordMs:t.cpuRecordMs,cpuSubmitMs:t.cpuSubmitMs,queueWaitMs:t.queueWaitMs,frameWallMs:t.sampleWallMs,authoredMutationMs});
  }
  const cpuSourceAfter={...profile.backend.uploadStats};
  const cpuMetrics=getRealRendererBenchmarkMetrics(state),cpuResources=state.tracker.getDebugSnapshot().byType;
  resourceAttribution.cpu=captureG05ResourceSnapshot(state.tracker);
  costCounts.cpu=costs.count();costs.stage('gpu-warmup');
  // Warm the timestamp probe separately, then replay exactly the CPU frame sequence.
  for(let i=0;i<warmup;i++){scene.update(i);await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});}
  costs.stage('gpu');
  resetRealRendererBenchmarkMetrics(state);const gpuSourceBefore={...profile.backend.uploadStats},gpu=[];
  for(let i=0;i<samples;i++){
   progress.textContent=`${caseId}/${algorithm} GPU ${i+1}/${samples}`;scene.update(i);await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});
   const t=state.lastFrameTiming.gpuTimestamp,resolve=t.passes.filter(p=>['DeferredReference.resolve','DeferredTiles.resolve'].includes(p.label)),cull=t.passes.filter(p=>p.label==='DeferredTiles.cull');
   if(t.scope!=='render-and-compute-span-v1'||resolve.length!==c.views)throw Error('Incomplete GPU scope or view population');
   gpu.push({frame:i,gpuSpanMs:t.spanMs,gpuPassSumMs:t.totalMs,resolveMs:resolve.reduce((n,p)=>n+p.durationMs,0),resolveCount:resolve.length,cullMs:cull.reduce((n,p)=>n+p.durationMs,0),passes:t.passes,effective:profile.backend.diagnostics.effective,bypassReason:profile.backend.diagnostics.reason});
  }
  const gpuSourceAfter={...profile.backend.uploadStats};
  const gpuMetrics=getRealRendererBenchmarkMetrics(state),gpuResources=state.tracker.getDebugSnapshot().byType,source={...profile.backend.lastSource.stats};
  resourceAttribution.gpu=captureG05ResourceSnapshot(state.tracker);
  costCounts.gpu=costs.count();
  const allocationBudget={...profile.backend.allocationDiagnostics},tilePlan=profile.backend.tileDiagnostics?.plan??null;
  const creationCosts={schemaVersion:1,ao,settings:ao==='off'?null:{radius:2,intensity:3,resolutionScale:1,quality:'high'},scope:'Fresh browser/device API creation and first use; driver/OS shader caches are not forcibly cleared. Timings are not isolated driver compiler time.',counts:costCounts,records:await costs.report()};
  costs.stage('pixel-check');
  const actual=await captureViews(state,scene),comparison=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{}:{tiled:{}});
  const expected=await captureViews(state,scene),pixels=compareViews(actual,expected,algorithm,c.width,c.height);
  const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
  result={schemaVersion:1,status:'passed',suite:'g05-room',scope:full?'diagnostic performance candidate; requires cohort, host and budget qualification':'smoke only; no performance qualification',
   adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description,isFallbackAdapter:adapter.info.isFallbackAdapter},
   platform:{userAgent:navigator.userAgent,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency},deviceLimits:Object.fromEntries(['maxBufferSize','maxStorageBufferBindingSize','maxStorageBuffersPerShaderStage','maxSampledTexturesPerShaderStage','maxColorAttachments','maxColorAttachmentBytesPerSample','maxTextureDimension2D'].map(k=>[k,device.limits[k]])),
   caseId,algorithm,moving,...c,fixtureId:scene.fixtureId,warmup,samples,cpu,gpu,cpuMetrics,gpuMetrics,cold,sourceUploads:{cpu:{before:cpuSourceBefore,after:cpuSourceAfter},gpu:{before:gpuSourceBefore,after:gpuSourceAfter}},resources:{warm:warmResources,cpu:cpuResources,gpu:gpuResources},resourceAttribution,source,
   creationCosts,allocationBudget,tilePlan,completeCoverage:comparison.backend.diagnostics.completeCoverage,pixels,validationErrors:errors};
  if(query.get('framegraphOracle')==='1')globalThis.__framegraphPixels=encodeFrameGraphPixels(actual);
  return result;
 }catch(error){failure=error;throw error;}
 finally{
  try{probe?.destroy();if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources,allocationBudgetReservedBytes:budgetOwner.allocationDiagnostics.reservedBytes};}}
  catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}
  finally{for(const target of targets)target.destroy();device.destroy();}
 }
}
