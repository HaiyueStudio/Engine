import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext, RenderFrameContext } from '../core/RenderCommandContext';
import { GpuSortComputePass } from '../compute/GpuSortComputePass';
import { TransparentMegaBatch } from '../renderer/TransparentMegaBatch';
import type { Render3DRenderItem } from './Render3DContracts';

export class Render3DTransparentOrchestrator {
  private _sortedTarget: Render3DRenderItem[] | null = null;
  private _sortedTargetCursor = 0;
  private readonly _appendSortedEntry = (entry: { payload: Render3DRenderItem }): void => {
    if (this._sortedTarget) this._sortedTarget[this._sortedTargetCursor++] = entry.payload;
  };

  constructor(private readonly _engine: IEngine) {}

  sortTransparentItems(
    transparentItems: Render3DRenderItem[],
    transparentBatch: TransparentMegaBatch<Render3DRenderItem>,
    gpuSorting: boolean,
  ): void {
    if (transparentItems.length <= 1) return;
    transparentBatch.sort();
    if (gpuSorting) transparentBatch.uploadGpu(this._engine);
    const transparentCount = transparentItems.length;
    const gpuSortedIndices = gpuSorting
      ? transparentBatch.getGpuSortedIndices(transparentCount)
      : null;
    if (gpuSortedIndices) {
      const entries = transparentBatch.entries;
      let write = 0;
      for (let i = 0; i < gpuSortedIndices.length; i++) {
        const index = gpuSortedIndices[i];
        const entry = index === undefined ? undefined : entries[index];
        if (entry?.payload) transparentItems[write++] = entry.payload;
      }
      transparentItems.length = write;
    } else {
      this._sortedTarget = transparentItems;
      this._sortedTargetCursor = 0;
      transparentBatch.forEachSorted(this._appendSortedEntry);
      transparentItems.length = this._sortedTargetCursor;
      this._sortedTarget = null;
    }
  }

  dispatchGpuSortBeforePass(
    context: RenderCommandContext,
    transparentBatch: TransparentMegaBatch<Render3DRenderItem>,
    sortPass: GpuSortComputePass,
    gpuSorting: boolean,
  ): void {
    if (!gpuSorting || transparentBatch.count <= 1) return;
    if (context.passEncoder) {
      if (!isRenderFrameContext(context)) return;
      context.endPass();
    }
    if (!transparentBatch.sortGpu(context, sortPass)) return;
    transparentBatch.requestGpuSortedIndexReadback(context);
  }
}

function isRenderFrameContext(context: RenderCommandContext): context is RenderFrameContext {
  return typeof (context as Partial<RenderFrameContext>).endPass === 'function'
    && typeof (context as Partial<RenderFrameContext>).beginPass === 'function';
}
