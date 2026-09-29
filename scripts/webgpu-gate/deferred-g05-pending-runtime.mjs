// Private diagnostic bundle only; these resource owners are not public exports.
export {GPUResourceTracker,createGPUResourceOwner} from '../../engine/src/core/GPUResourceTracker.ts';
export {TransientRenderTargetPool,acquireTransientAttachments,releaseTransientAttachments} from '../../engine/src/rtt/TransientRenderTargetPool.ts';
export {DeferredTileResources,planDeferredTiles} from '../../engine/src/renderer/DeferredTileResources.ts';
export {DeferredAmbientOcclusion} from '../../engine/src/renderer/DeferredAmbientOcclusion.ts';
export {getDeferredAllocationBudget} from '../../engine/src/renderer/DeferredAllocationBudget.ts';
export {planDeferredViewMemory} from '../../engine/src/renderer/DeferredViewMemory.ts';
export {registerLightingAmbientOcclusion} from '../../engine/src/postprocess/LightingAmbientOcclusion.ts';
