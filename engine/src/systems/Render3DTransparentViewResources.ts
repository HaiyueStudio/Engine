import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { GpuSortComputePass } from '../compute/GpuSortComputePass';
import { FrameRingResource, type FrameRingGenerationInfo } from '../renderer/FrameRingResource';
import { TransparentMegaBatch } from '../renderer/TransparentMegaBatch';
import type { Render3DRenderItem } from './Render3DContracts';

const GPU_VIEW_RING_FRAMES = 3;

interface TransparentViewGeneration {
  readonly info: FrameRingGenerationInfo;
  readonly batches: Array<TransparentMegaBatch<Render3DRenderItem> | null>;
  readonly sortPasses: Array<GpuSortComputePass | null>;
}

/**
 * Owns transparent batching and GPU-sort resources for every frame/view slot.
 * Render3DSystem chooses logical views; this object owns capacity, slot mapping,
 * generation retirement, and device-loss reset.
 */
export class Render3DTransparentViewResources {
  private readonly _ring: FrameRingResource<TransparentViewGeneration>;
  private _slot = 0;

  constructor(private readonly _engine: IEngine) {
    this._ring = new FrameRingResource<TransparentViewGeneration>({
      label: 'Render3DSystem.transparentViews',
      framesInFlight: GPU_VIEW_RING_FRAMES,
      create: info => ({
        info,
        batches: new Array<TransparentMegaBatch<Render3DRenderItem> | null>(info.slotCount).fill(null),
        sortPasses: new Array<GpuSortComputePass | null>(info.slotCount).fill(null),
      }),
      destroy: destroyGeneration,
    });
  }

  get slot(): number { return this._slot; }

  get batch(): TransparentMegaBatch<Render3DRenderItem> {
    return getBatch(this._engine, this._ring.resource, this._slot);
  }

  beginFrame(viewCount: number, context: RenderCommandContext): void {
    this._ring.beginFrame(viewCount, context);
    this._slot = 0;
  }

  select(viewIndex: number): TransparentMegaBatch<Render3DRenderItem> {
    this._slot = this._ring.slot(Math.max(0, viewIndex | 0));
    return this.batch;
  }

  getSortPass(): GpuSortComputePass {
    return getSortPass(this._engine, this._ring.resource, this._slot);
  }

  reset(): void {
    this._ring.reset();
    this._slot = 0;
  }
}

function getBatch(
  engine: IEngine,
  generation: TransparentViewGeneration,
  slot: number,
): TransparentMegaBatch<Render3DRenderItem> {
  let batch = generation.batches[slot];
  if (!batch) {
    batch = new TransparentMegaBatch(
      engine,
      generationLabel('Render3DSystem.transparentMegaBatch', generation.info, slot),
    );
    generation.batches[slot] = batch;
  }
  return batch;
}

function getSortPass(
  engine: IEngine,
  generation: TransparentViewGeneration,
  slot: number,
): GpuSortComputePass {
  let pass = generation.sortPasses[slot];
  if (!pass) {
    pass = new GpuSortComputePass(
      engine,
      generationLabel('Render3DSystem.transparentSort', generation.info, slot),
    );
    generation.sortPasses[slot] = pass;
  }
  return pass;
}

function destroyGeneration(generation: TransparentViewGeneration): void {
  for (const batch of generation.batches) batch?.destroyGpu();
  for (const pass of generation.sortPasses) pass?.destroy();
  generation.batches.length = 0;
  generation.sortPasses.length = 0;
}

function generationLabel(prefix: string, info: FrameRingGenerationInfo, slot: number): string {
  void info;
  return `${prefix}.view.${slot}`;
}
