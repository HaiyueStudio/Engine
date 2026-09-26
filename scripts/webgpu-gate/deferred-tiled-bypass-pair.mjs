import {createRealRendererBenchmarkScenario,runRealRendererBenchmarkFrame,destroyRealRendererBenchmarkScenario,createAuditTarget,
 createDeferredReferenceProfile,resetRealRendererBenchmarkMetrics,createRealRendererGpuTimestampProbe} from '../../artifacts/engine-0.2.1/g03/fixture.js';
import {installTiledRoomScene} from './deferred-tiled-room-scene.mjs';
const node=document.querySelector('#result');
try{node.textContent=JSON.stringify(await run());node.dataset.status='passed';}
catch(error){node.textContent=JSON.stringify({status:'failed',error:error.stack??String(error)});node.dataset.status='failed';}
async function run(){
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter||adapter.info.isFallbackAdapter||!adapter.features.has('timestamp-query'))throw Error('Native timestamp adapter required');
  const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[];
  device.addEventListener('uncapturederror',event=>errors.push(event.error.message));device.pushErrorScope('validation');
  const target=createAuditTarget(device,1280,720,true);let state,probe,result,backend,tiles,originalSelect,failure;
  try{
    state=await createRealRendererBenchmarkScenario({device,target,entityCount:0,viewCount:1,renderProfile:'batched'});
    const scene=installTiledRoomScene(state,{count:128,overlap:true});
    const profile=await createDeferredReferenceProfile(state.render3d,state.engine,{tiled:{}});backend=profile.backend;tiles=backend._tiles;
    const pipelines=backend._pipelines;originalSelect=tiles.select;
    probe=createRealRendererGpuTimestampProbe(state,{includeCompute:true});resetRealRendererBenchmarkMetrics(state);
    for(let frame=0;frame<120;frame++){scene.update(frame);await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});}
    resetRealRendererBenchmarkMetrics(state);const raw=[];
    for(let frame=0;frame<300;frame++){
      const order=frame%2?['automatic','direct-full-list']:['direct-full-list','automatic'];
      const pair={frame,order};
      for(const mode of order){
        // Test seam: bypass only the selector. Both modes share the same device,
        // optimized full-list pipelines, bind groups, source data and frame graph.
        tiles.select=mode==='automatic'?originalSelect:function(){this.lastBypassReason='all-lights-cover-near-plane';return this.lastBypassReason;};
        scene.update(frame);await runRealRendererBenchmarkFrame(state,{gpuTimestampProbe:probe});
        if(backend._pipelines!==pipelines||backend.diagnostics.effective!=='deferred-tiled'||!backend.diagnostics.completeCoverage)throw Error('Pair changed its pipeline or coverage');
        if(mode==='automatic'&&backend.diagnostics.reason!=='all-lights-cover-near-plane')throw Error('Pair did not select full-list fallback');
        const timing=state.lastFrameTiming,gpu=timing.gpuTimestamp;
        if(gpu.scope!=='render-and-compute-span-v1'||gpu.passes.length!==3||gpu.passes.some(pass=>pass.kind!=='render'))throw Error('Unexpected same-pipeline pass population');
        pair[mode]={cpuRuntimeMs:timing.runtimeFrameMs,gpuSpanMs:gpu.spanMs,passes:gpu.passes};
      }
      raw.push(pair);
    }
    tiles.select=originalSelect;
    const validation=await device.popErrorScope();if(validation)errors.push(validation.message);if(errors.length)throw Error(errors.join('\n'));
    return result={schemaVersion:1,status:'passed',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},fixtureId:'deferred-room-021-v1',resolution:[1280,720],count:128,overlap:true,warmup:120,pairs:300,raw,validationErrors:errors};
  }catch(error){failure=error;throw error;}
  finally{
    if(tiles&&originalSelect)tiles.select=originalSelect;
    try{probe?.destroy();if(state){await destroyRealRendererBenchmarkScenario(state);if(result)result.cleanup={ownerResidual:state.finalMetrics.ownerResidual,liveGpuResources:state.finalMetrics.liveGpuResources};}}
    catch(error){if(!failure)throw error;failure.stack+=`\nCleanup: ${error.stack}`;}
    finally{target.destroy();device.destroy();}
  }
}
