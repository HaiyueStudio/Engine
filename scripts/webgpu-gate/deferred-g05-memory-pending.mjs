import assert from 'node:assert/strict';
import {importEngineSource} from '../../engine/test/helpers/internal-source.mjs';
import {createAuditGpuDevice} from '../benchmark/real-renderer-audit-device.mjs';
import {captureG05ResourceSnapshot} from './deferred-g05-memory-policy.mjs';
export async function checkG05PendingMemory(config){
 const {GPUResourceTracker,createGPUResourceOwner}=await importEngineSource('core/GPUResourceTracker.ts');
 const {TransientRenderTargetPool,acquireTransientAttachments}=await importEngineSource('rtt/TransientRenderTargetPool.ts');
 const {DeferredTileResources,planDeferredTiles}=await importEngineSource('renderer/DeferredTileResources.ts');
 const device=createAuditGpuDevice({limits:{maxStorageBuffersPerShaderStage:8,maxComputeWorkgroupSizeX:256,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupStorageSize:16384,maxComputeWorkgroupsPerDimension:65535}});
 const tracker=new GPUResourceTracker({debug:true}),owner=createGPUResourceOwner('system','g05-pending-memory');tracker.instrumentDevice(device,owner);
 const host={device,format:'rgba16float',width:1920,height:1080,defaults:{},getDepthFormat:()=> 'depth24plus'},pool=new TransientRenderTargetPool(host),tiles=new DeferredTileResources(device);
 const callbacks=[],context={device,encoder:device.createCommandEncoder(),afterSubmit:callback=>callbacks.push(callback)},formats=['rgba16float','rgba16float','rgba16float','depth32float'];
 const dimensions=[[1904,1072],[1920,1080]],generations=[];let result;
 try{
  for(const [width,height]of dimensions){
   const plan=planDeferredTiles(device,width,height);generations.push({width,height,bytesPerView:plan.viewBytes});
   assert.ok(plan.viewBytes<=config.memory.maxDeferredBytesPerViewGeneration);
   for(let view=0;view<4;view++){
    acquireTransientAttachments(pool,`view:${view}`,width,height,formats,context,{maxViews:4,maxLiveGenerations:2});tiles.acquire(`view:${view}`,plan,context);
   }
  }
  const pending=captureG05ResourceSnapshot(tracker);assert.equal(pending.views.length,4);
  for(const view of pending.views){assert.equal(view.gbufferTextures,8);assert.equal(view.tileBuffers,2);}
  assert.ok(pending.deferredEstimateBytes<=config.memory.maxDeferredTargetBytesTotal);
  const before=tracker.getDebugSnapshot().byType;
  assert.throws(()=>acquireTransientAttachments(pool,'view:0',1920,1079,formats,context,{maxViews:4,maxLiveGenerations:2}),{reason:'live-target-generations'});
  assert.throws(()=>tiles.acquire('view:0',planDeferredTiles(device,1936,1080),context),{reason:'tile-live-generations'});
  assert.throws(()=>acquireTransientAttachments(pool,'view:4',1920,1080,formats,context,{maxViews:4,maxLiveGenerations:2}),{reason:'view-count'});
  assert.throws(()=>tiles.acquire('view:4',planDeferredTiles(device,1920,1080),context),{reason:'tile-view-count'});
  const after=tracker.getDebugSnapshot().byType;for(const type of ['buffer','texture'])assert.equal(after[type].created,before[type].created);
  // Destroy while this encoder is still unsubmitted: every referenced generation stays alive.
  pool.destroy();tiles.destroy();const held=captureG05ResourceSnapshot(tracker);assert.equal(held.deferredEstimateBytes,pending.deferredEstimateBytes);
  device.queue.submit([context.encoder.finish()]);for(const callback of callbacks)callback(device.queue);await device.queue.onSubmittedWorkDone();await Promise.resolve();
  const settled=captureG05ResourceSnapshot(tracker);assert.equal(settled.allocationEstimateBytes,0);assert.equal(settled.records.length,0);
  result={status:'passed',generations,pending,heldBeforeSubmission:held.deferredEstimateBytes,afterCompletion:settled,capacityFailures:['live-target-generations','tile-live-generations','view-count','tile-view-count'],newResourcesOnRejectedRequests:0};
 }finally{pool.destroy();tiles.destroy(true);tracker.releaseOwner(owner);}
 return result;
}
