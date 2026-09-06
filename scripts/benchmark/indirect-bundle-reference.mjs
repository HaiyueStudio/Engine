// Diagnostic baseline: the previous prepared per-object indirect submission,
// consuming exactly the same GPU command buffers and renderer shader/resources.
const originalBatches = new WeakMap();
export function useIndividualIndirectSubmission(renderers, enabled) {
  for (const renderer of renderers) {
    if (!originalBatches.has(renderer)) originalBatches.set(renderer, renderer.renderBatch);
    const original = originalBatches.get(renderer);
    if (!enabled) { renderer.renderBatch = original; continue; }
    const batch = {};
    renderer.renderBatch = function(pass, items, first, count, buffers, ...rest) {
      if (!buffers.gpuUploadEnabled) return original.call(this, pass, items, first, count, buffers, ...rest);
      const firstBatchIndex = rest[1] ?? first;
      for (let index = first; index < Math.min(items.length, first + count); index++) {
        const item = items[index];
        if (!item?.geometry || !item.material || !item.worldMatrix) continue;
        batch.batchBuffer = buffers;
        batch.batchIndex = firstBatchIndex + index - first;
        batch.objectSlot = buffers.getObjectSlot(batch.batchIndex);
        buffers.writeIndirectCommandView(batch.batchIndex, batch);
        this.render(pass, item.entityId, item.geometry, item.material, item.worldMatrix,
          { gpuDrivenBatch: batch, skipDepthPrepass: rest[0] ?? false }, item.clippingPlanes);
      }
    };
  }
}
