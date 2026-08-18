import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { Frustum } from '../culling/Frustum';
import type { World } from '../ecs/World';
import type { FrameData } from '../frame/FrameData';
import type { Material } from '../material/Material';
import type { MaterialRendererRegistration } from '../renderer/MaterialRendererRegistry';
import type { RenderProfileSettings } from '../core/RenderProfile';
import type { Render3DViewCollectionOptions, Render3DSceneCollector } from './Render3DSceneCollector';
import { Render3DFrameItems } from './Render3DFrameItems';
import type { WorldFrameState } from './Render3DFrameState';
import { Render3DGpuDrivenBatchBuilder } from './Render3DGpuDrivenBatchBuilder';
import { Render3DOpaqueSorter, type Render3DOpaqueSorterStats } from './Render3DOpaqueSorter';
import { Render3DTransparentOrchestrator } from './Render3DTransparentOrchestrator';
import { Render3DTransparentViewResources } from './Render3DTransparentViewResources';

export interface Render3DViewPreparationSortResult extends Render3DOpaqueSorterStats {}

/**
 * Owns camera-dependent collection products and the GPU resources that prepare
 * them for submission. Scene extraction and pass submission deliberately stay
 * outside this owner because they have scene-global and render-pass lifetimes.
 */
export class Render3DViewPreparation {
  readonly frameItems = new Render3DFrameItems();
  readonly opaqueSorter = new Render3DOpaqueSorter();
  readonly transparentViews: Render3DTransparentViewResources;
  gpuDrivenBatches: Render3DGpuDrivenBatchBuilder;
  transparentOrchestrator: Render3DTransparentOrchestrator;

  constructor(private readonly _engine: IEngine) {
    this.transparentViews = new Render3DTransparentViewResources(_engine);
    this.gpuDrivenBatches = new Render3DGpuDrivenBatchBuilder(_engine);
    this.transparentOrchestrator = new Render3DTransparentOrchestrator(_engine);
  }

  beginFrame(viewCount: number, context: RenderCommandContext): void {
    this.frameItems.beginFrame();
    this.gpuDrivenBatches.beginFrame(viewCount, context);
    this.transparentViews.beginFrame(viewCount, context);
  }

  selectView(viewIndex: number, options: Render3DViewCollectionOptions): void {
    options.transparentBatch = this.transparentViews.select(viewIndex);
  }

  collectView(
    collector: Render3DSceneCollector,
    state: WorldFrameState,
    options: Render3DViewCollectionOptions,
    settings: RenderProfileSettings,
    transparentSort: boolean,
  ): number {
    options.frustumCull = settings.frustumCulling;
    options.gpuDrivenCulling = settings.gpuDrivenCulling;
    options.transparentSort = transparentSort;
    return collector.collectView(state, options).visibleCount;
  }

  sort(settings: RenderProfileSettings, transparentSort: boolean): Render3DViewPreparationSortResult {
    const opaqueItems = this.frameItems.opaqueItems;
    if (settings.megaBatchSort && opaqueItems.length > 1) {
      this.opaqueSorter.sort(
        opaqueItems,
        settings.materialBatching && !settings.gpuDrivenIndirectDraws,
      );
    } else {
      return this._sortTransparentAndReturn(
        transparentSort,
        { mode: 'none', itemCount: opaqueItems.length, radixThreshold: this.opaqueSorter.stats.radixThreshold },
        settings.gpuCullingReadback,
      );
    }
    return this._sortTransparentAndReturn(transparentSort, this.opaqueSorter.stats, settings.gpuCullingReadback);
  }

  prepareGpuDrivenBatches(
    context: RenderCommandContext,
    frustum: Frustum,
    settings: RenderProfileSettings,
    uniformSlot: number,
  ) {
    return this.gpuDrivenBatches.prepare(
      context,
      this.frameItems.opaqueItems,
      this.frameItems.transparentItems,
      frustum,
      settings.gpuDrivenBatches,
      settings.gpuDrivenDrawCommands,
      settings.gpuDrivenIndirectDraws,
      settings.gpuDrivenCulling,
      settings.gpuCullingReadback,
      uniformSlot,
    );
  }

  sortTransparentOnGpu(context: RenderCommandContext, enabled: boolean): void {
    const batch = this.transparentViews.batch;
    if (!enabled || batch.count <= 1) return;
    this.transparentOrchestrator.dispatchGpuSortBeforePass(
      context,
      batch,
      this.transparentViews.getSortPass(),
      enabled,
    );
  }

  prepareSceneGlobal(
    world: World,
    frameData: FrameData,
    state: WorldFrameState,
    settings: RenderProfileSettings,
    resolveMaterial: (material: Material) => MaterialRendererRegistration | null,
    getRendererSlot: (registration: MaterialRendererRegistration) => number,
    rendererRegistryRevision: number,
  ) {
    return this.gpuDrivenBatches.prepareSceneGlobal(
      world,
      frameData,
      state,
      settings.gpuDrivenBatches,
      settings.gpuDrivenIndirectDraws,
      resolveMaterial,
      getRendererSlot,
      rendererRegistryRevision,
    );
  }

  endFrame(): void {
    this.frameItems.clearReferences();
    this.gpuDrivenBatches.clearFrameData();
    this.opaqueSorter.clearReferences();
  }

  suspendForDeviceLoss(): void {
    this.gpuDrivenBatches.destroy();
    this.transparentViews.reset();
    this.frameItems.clearLists();
    this.endFrame();
  }

  recoverGpuResources(): void {
    this.gpuDrivenBatches = new Render3DGpuDrivenBatchBuilder(this._engine);
    this.transparentOrchestrator = new Render3DTransparentOrchestrator(this._engine);
  }

  private _sortTransparentAndReturn(
    transparentSort: boolean,
    result: Render3DViewPreparationSortResult,
    gpuSorting: boolean,
  ): Render3DViewPreparationSortResult {
    const transparentItems = this.frameItems.transparentItems;
    if (transparentSort && transparentItems.length > 1) {
      this.transparentOrchestrator.sortTransparentItems(
        transparentItems,
        this.transparentViews.batch,
        gpuSorting,
      );
    }
    return result;
  }
}
