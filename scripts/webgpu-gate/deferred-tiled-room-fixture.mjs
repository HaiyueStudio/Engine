import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,
 createDeferredReferenceProfile,resetRealRendererBenchmarkMetrics,createRealRendererGpuTimestampProbe,getRealRendererBenchmarkMetrics} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {installTiledRoomScene} from './deferred-tiled-room-scene.mjs';
import {readFloatTexture} from './float-texture-readback.mjs';
const node=document.querySelector('#result'),progress=document.querySelector('#progress');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
async function tileSummary(device,profile){
  const tiles=profile.backend.tileDiagnostics;if(!tiles)return null;
  const {binding,plan}=tiles;
  if(tiles.bypassReason){
    const pointCount=profile.backend.lastSource.stats.pointCount;
    return {plan,gpuTileStorageAllocated:true,tileStorageBytes:binding.size,bypassReason:tiles.bypassReason,acceptedReferences:null,
      resolveListReferences:plan.tileCount*pointCount,overflowTiles:0,
      heatmap:Array.from({length:plan.tileCount},(_,tile)=>({tile,accepted:null,overflow:false,mode:'full-list-bypass'}))};
  }
  const readback=device.createBuffer({size:binding.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(binding.buffer,binding.offset??0,readback,0,binding.size);device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);const words=new Uint32Array(readback.getMappedRange());
    const heatmap=[];let acceptedReferences=0,resolveListReferences=0,overflowTiles=0;
    for(let tile=0;tile<plan.tileCount;tile++){
      const base=tile*132,missing=tile>=plan.storedTiles,accepted=missing?0:words[base+1],overflow=missing||words[base+2]!==0;
      if(!missing&&(words[base]!==base+4||accepted>profile.backend.lastSource.stats.pointCount))throw Error('Invalid room tile header');
      acceptedReferences+=accepted;resolveListReferences+=overflow?profile.backend.lastSource.stats.pointCount:accepted;if(overflow)overflowTiles++;
      heatmap.push({tile,accepted,overflow});
    }
    readback.unmap();return {plan,gpuTileStorageAllocated:true,bypassReason:null,acceptedReferences,resolveListReferences,overflowTiles,heatmap,sourceGeneration:profile.backend.lastSource.generation};
  }finally{readback.destroy();}
}
async function run(){
  const query=new URLSearchParams(location.search),preference=query.get('powerPreference')??'high-performance';
  const count=Number(query.get('count')??256),overlap=query.get('overlap')==='1',algorithm=query.get('algorithm')??'tiled',full=query.get('full')==='1';
  if(![128,256].includes(count)||!['reference','tiled'].includes(algorithm))throw Error('Invalid room case');
  const warmup=full?120:2,samples=full?300:3;
  const adapter=await navigator.gpu.requestAdapter({powerPreference:preference});if(!adapter||adapter.info.isFallbackAdapter)throw Error('Native adapter required');
  if(!adapter.features.has('timestamp-query'))throw Error('G03 timing requires timestamp-query');
  const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[];
  device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
  const target=createAuditTarget(device,1280,720,true);let state,probe,result,failure;
  try{
    state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,viewCount:1,renderProfile:'batched'});
    const scene=installTiledRoomScene(state,{count,overlap});
    const options=algorithm==='tiled'?{tiled:{}}:{};
    const profile=await createDeferredReferenceProfile(state.render3d,state.engine,options);
    probe=createRealRendererGpuTimestampProbe(state,{includeCompute:true});
    resetRealRendererBenchmarkMetrics(state);
    for(let i=0;i<warmup;i++){scene.update(i);await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});}
    resetRealRendererBenchmarkMetrics(state);
    const raw=[];
    for(let i=0;i<samples;i++){
      progress.textContent=`${algorithm} ${count} ${overlap?'overlap':'sparse'} ${i+1}/${samples}`;
      const mutationStart=performance.now();scene.update(i);const authoredMutationMs=performance.now()-mutationStart;
      await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});
      const t=state.lastFrameTiming,gpu=t.gpuTimestamp;
      if(gpu.scope!=='render-and-compute-span-v1'||!(gpu.spanMs>0))throw Error('Missing complete GPU span');
      const cull=gpu.passes.filter(p=>p.label==='DeferredTiles.cull'),resolve=gpu.passes.filter(p=>['DeferredReference.resolve','DeferredTiles.resolve'].includes(p.label));
      if(resolve.length!==1||cull.length!==(profile.backend.diagnostics.effective==='deferred-tiled'&&!profile.backend.diagnostics.reason?1:0))throw Error('Unexpected cull/resolve timing population');
      raw.push({frame:i,effective:profile.backend.diagnostics.effective,bypassReason:profile.backend.diagnostics.reason,cpuRuntimeMs:t.runtimeFrameMs,cpuRecordMs:t.cpuRecordMs,cpuSubmitMs:t.cpuSubmitMs,queueWaitMs:t.queueWaitMs,
        frameWallMs:t.sampleWallMs,authoredMutationMs,gpuSpanMs:gpu.spanMs,gpuPassSumMs:gpu.totalMs,cullMs:cull[0]?.durationMs??0,resolveMs:resolve[0].durationMs,passes:gpu.passes});
    }
    const metrics=getRealRendererBenchmarkMetrics(state);
    const source=profile.backend.lastSource;
    if(source.stats.pointCount!==count||source.stats.directionalCount!==1||source.stats.ambientCount!==1)throw Error('Room light population changed');
    // Pixel comparison follows timing and never enters the retained timing samples.
    scene.update(0);resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
    const actual=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture),actualLdr=await readFloatTexture(device,target.colorTexture);
    let tiles=await tileSummary(device,profile);
    const comparisonProfile=await createDeferredReferenceProfile(state.render3d,state.engine,algorithm==='tiled'?{}:{tiled:{}});
    scene.update(0);resetRealRendererBenchmarkMetrics(state);await runRealRendererBenchmarkFrame(state);
    if(!tiles)tiles=await tileSummary(device,comparisonProfile);
    const expected=await readFloatTexture(device,state.render3d._postScenePasses._postRenderer.sceneTexture),expectedLdr=await readFloatTexture(device,target.colorTexture);
    let maxHdrDelta=0,maxLdrDelta=0,litPixels=0;
    for(let i=0;i<actual.length;i++){
      const reference=algorithm==='tiled'?expected[i]:actual[i],delta=Math.abs(actual[i]-expected[i]);maxHdrDelta=Math.max(maxHdrDelta,delta);
      maxLdrDelta=Math.max(maxLdrDelta,Math.abs(actualLdr[i]-expectedLdr[i])*255);
      if(!Number.isFinite(actual[i])||!Number.isFinite(expected[i])||delta>Math.max(.002,Math.abs(reference)*.002))throw Error(`Room HDR mismatch at ${i}: ${actual[i]} vs ${expected[i]}`);
      if(i%4===0&&actual[i]+actual[i+1]+actual[i+2]>0)litPixels++;
    }
    if(litPixels<92160||maxLdrDelta>2.001)throw Error('Room image missing or LDR parity failed');
    const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
    result={schemaVersion:1,status:'passed',scope:full?'G03 paired-performance candidate sample; cohort/host/budget review still required':'G03 room timing smoke; no performance qualification',
      adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},
      fixtureId:scene.fixtureId,resolution:[1280,720],count,overlap,algorithm,warmup,samples,raw,metrics,
      source:source.stats,tiles,completeCoverage:comparisonProfile.backend.diagnostics.completeCoverage,pixels:{maxHdrDelta,maxLdrDelta,litPixels},validationErrors:errors};
    return result;
  }catch(error){failure=error;throw error;}
  finally{
    try{probe?.destroy();if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}
    catch(error){if(!failure)throw error;failure.stack+=`\nCleanup also failed: ${error.stack}`;}
    finally{target.destroy();device.destroy();}
  }
}
