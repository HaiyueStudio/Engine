import type { Material } from '../material/Material';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import type { MaterialRenderBatchItem } from './MaterialRendererRegistry';

export interface DirectInstanceBatchRun<M extends Material> {
  readonly item: MaterialRenderBatchItem<M> & {
    geometry: NonNullable<MaterialRenderBatchItem<M>['geometry']>;
    material: M;
    worldMatrix: Float32Array;
  };
  readonly firstBatch: number;
  readonly firstInstance: number;
  readonly instanceCount: number;
}

/**
 * Splits a material mega-batch into ranges that WebGPU can submit as one
 * direct instanced draw. Object slots must be consecutive because shaders use
 * `instance_index` to address the renderer object table.
 */
export function forEachDirectInstanceBatchRun<M extends Material>(
  items: readonly MaterialRenderBatchItem<M>[],
  first: number,
  count: number,
  batchBuffer: GpuDrivenBatchBuffer,
  visit: (run: DirectInstanceBatchRun<M>) => void,
  firstBatchIndex = first,
): void {
  const end = Math.min(items.length, first + count);
  let cursor = first;
  while (cursor < end) {
    const item = items[cursor];
    if (!isRenderableItem(item)) {
      cursor++;
      continue;
    }
    const firstInstance = batchBuffer.getObjectSlot(firstBatchIndex + cursor - first);
    let runEnd = cursor + 1;
    while (runEnd < end) {
      const next = items[runEnd];
      if (
        !isRenderableItem(next)
        || next.geometry.id !== item.geometry.id
        || next.material.id !== item.material.id
        || batchBuffer.getObjectSlot(firstBatchIndex + runEnd - first) !== firstInstance + (runEnd - cursor)
      ) break;
      runEnd++;
    }
    visit({
      item,
      firstBatch: cursor,
      firstInstance,
      instanceCount: runEnd - cursor,
    });
    cursor = runEnd;
  }
}

function isRenderableItem<M extends Material>(
  item: MaterialRenderBatchItem<M> | undefined,
): item is DirectInstanceBatchRun<M>['item'] {
  return !!item?.geometry && !!item.material && !!item.worldMatrix;
}
