import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,createDeferredReferenceProfile,resetRealRendererBenchmarkMetrics,getRealRendererBenchmarkMetrics,RenderView} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {installG05RoomScene} from './deferred-g05-room-scene.mjs';
import {G05_ROOM_CASES} from './deferred-g05-policy.mjs';
import {readFloatTexture} from './float-texture-readback.mjs';
const node=document.querySelector('#result');
async function boundary(state){await new Promise(resolve=>{globalThis.__webgpuAllocationPhase={state,resume:resolve};});globalThis.__webgpuAllocationPhase=null;}
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
async function run(){
 const q=new URLSearchParams(location.search),caseId=q.get('caseId'),algorithm=q.get('algorithm'),moving=q.get('moving')==='1',c=G05_ROOM_CASES[caseId];
 if(!c||!['reference','tiled'].includes(algorithm))throw Error('Invalid allocation workload');
 const adapter=await navigator.gpu.requestAdapter({powerPreference:q.get('preference')});
 if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
 const device=await adapter.requestDevice(),validationErrors=[];device.pushErrorScope('validation');device.addEventListener('uncapturederror',e=>validationErrors.push(e.error.message));
 const targets=Array.from({length:c.views},()=>createAuditTarget(device,c.width,c.height,true));let state,result;
 try{
  state=await createRealRendererBenchmarkScenario({device,target:targets[0],entityCount:0,viewCount:c.views,renderProfile:'batched'});
  state.targets=targets;state.views=state.views.map((v,i)=>new RenderView({key:v.key,camera:v.camera,target:targets[i]}).snapshot());
  const scene=installG05RoomScene(state,{count:c.count,overlap:c.overlap,moving}),profile=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{tiled:{}}:{});
  for(let i=0;i<120;i++){scene.update(i);await runRealRendererBenchmarkFrame(state);}
  const before=state.tracker.getDebugSnapshot().byType,sourceBefore={...profile.backend.uploadStats};resetRealRendererBenchmarkMetrics(state);
  await boundary('ready');
  for(let i=0;i<300;i++){scene.update(i);await runRealRendererBenchmarkFrame(state);}
  await boundary('done');
  const after=state.tracker.getDebugSnapshot().byType,metrics=getRealRendererBenchmarkMetrics(state),sourceAfter={...profile.backend.uploadStats},pixels=[];
  for(const view of state.views){const image=await readFloatTexture(device,view.target.colorTexture);let litPixels=0;for(let i=0;i<image.length;i+=4){if(!image.subarray(i,i+4).every(Number.isFinite))throw Error('Nonfinite pixels');if(image[i]+image[i+1]+image[i+2]>0)litPixels++;}pixels.push({key:view.key,components:image.length,litPixels});}
  const validation=await device.popErrorScope();if(validation)validationErrors.push(validation.message);
  result={schemaVersion:1,status:'passed',suite:'g05-cpu-allocations',performanceQualified:false,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},caseId,algorithm,moving,...c,warmup:120,frames:300,fixtureId:scene.fixtureId,completeCoverage:profile.backend.diagnostics.completeCoverage,source:{...profile.backend.lastSource.stats},sourceUploads:{before:sourceBefore,after:sourceAfter},resources:{before,after},metrics,pixels,validationErrors};return result;
 }finally{try{if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}finally{for(const target of targets)target.destroy();device.destroy();}}
}
