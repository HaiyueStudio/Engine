import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import type { InternalMaterialRenderContext, MaterialGpuDrivenBatch, MaterialRendererRegistration, MaterialRendererViewContext } from '../renderer/MaterialRendererRegistry';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { GpuDrivenMegaBatchRun } from '../renderer/GpuDrivenBatchBuffer';
import type { GpuDrivenBatchBuffer } from '../renderer/GpuDrivenBatchBuffer';
import type { Render3DRenderItem } from './Render3DContracts';
import { requiredItemAt } from '../math/arrayAccess';
import type { ClippingPlanes } from '../components/ClippingPlanes';

export interface Render3DSubmitterOptions {
  gpuDrivenBatches: boolean;
  megaBatchRuns: readonly GpuDrivenMegaBatchRun[];
  batchBuffer: GpuDrivenBatchBuffer | null;
  resolveMaterialRenderer(material: Material): MaterialRendererRegistration | null;
  getGpuDrivenBatch(batchIndex: number): MaterialGpuDrivenBatch | undefined;
  setMaterialRenderContext<M extends Material>(
    passEncoder: GPURenderPassEncoder,
    entityId: number,
    geometry: Geometry3D,
    material: M,
    clippingPlanes: ClippingPlanes | null,
    worldMatrix: Float32Array,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    gpuDrivenBatch?: MaterialGpuDrivenBatch,
  ): InternalMaterialRenderContext<M>;
}

/** Fills the draw-local portion of the reusable material context owned by Render3DSystem. */
export function fillMaterialRenderContext<M extends Material>(
  context: InternalMaterialRenderContext,
  passEncoder: GPURenderPassEncoder,
  entityId: number,
  geometry: Geometry3D,
  material: M,
  clippingPlanes: ClippingPlanes | null,
  worldMatrix: Float32Array,
  viewProj: Float32Array,
  viewMatrix: Float32Array,
  gpuDrivenBatch?: MaterialGpuDrivenBatch,
): InternalMaterialRenderContext<M> {
  const typedContext = context as InternalMaterialRenderContext<M>;
  typedContext.passEncoder = passEncoder;
  typedContext.entityId = entityId;
  typedContext.geometry = geometry;
  typedContext.material = material;
  typedContext.clippingPlanes = clippingPlanes;
  typedContext.worldMatrix = worldMatrix;
  typedContext.viewProj = viewProj;
  typedContext.viewMatrix = viewMatrix;
  typedContext.gpuDrivenBatch = gpuDrivenBatch;
  return typedContext;
}

export class Render3DSubmitter {
  private readonly _activeRegistrations: MaterialRendererRegistration[] = [];

  prepareView(
    opaqueItems: readonly Render3DRenderItem[],
    transparentItems: readonly Render3DRenderItem[],
    viewContext: MaterialRendererViewContext,
    options: Render3DSubmitterOptions,
  ): void {
    this._activeRegistrations.length = 0;
    this._prepareItemList(opaqueItems, 0, viewContext, options);
    this._prepareItemList(transparentItems, opaqueItems.length, viewContext, options);
    for (const registration of this._activeRegistrations) registration.flushUploads?.(viewContext);
  }

  endView(viewContext: MaterialRendererViewContext): void {
    for (let i = this._activeRegistrations.length - 1; i >= 0; i--) {
      this._activeRegistrations[i]!.endView?.(viewContext);
    }
    this._activeRegistrations.length = 0;
  }

  drawItems(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    batchIndexOffset: number,
    options: Render3DSubmitterOptions,
  ): void {
    this.drawItemsRange(items, passEncoder, viewProj, viewMatrix, 0, items.length, batchIndexOffset, options);
  }

  drawOpaqueItems(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    options: Render3DSubmitterOptions,
  ): void {
    if (!options.gpuDrivenBatches || options.megaBatchRuns.length < 1) {
      this.drawItems(items, passEncoder, viewProj, viewMatrix, 0, options);
      return;
    }

    let cursor = 0;
    for (const run of options.megaBatchRuns) {
      if (run.firstBatch >= items.length) break;
      if (run.firstBatch > cursor) {
        this.drawItemsRange(items, passEncoder, viewProj, viewMatrix, cursor, run.firstBatch - cursor, cursor, options);
      }
      const runCount = Math.min(run.batchCount, items.length - run.firstBatch);
      if (runCount <= 0) continue;
      this.drawItemRun(items, passEncoder, viewProj, viewMatrix, run.firstBatch, runCount, options);
      cursor = run.firstBatch + runCount;
    }
    if (cursor < items.length) {
      this.drawItemsRange(items, passEncoder, viewProj, viewMatrix, cursor, items.length - cursor, cursor, options);
    }
  }

  /**
   * Walks the already-sorted transparent list without reordering it. Only
   * registrations that explicitly prove order-independent instance batching
   * may consume a range; all other items retain one draw per sorted object.
   */
  drawTransparentItems(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    batchIndexOffset: number,
    options: Render3DSubmitterOptions,
  ): void {
    const batchBuffer = options.batchBuffer;
    if (!options.gpuDrivenBatches || !batchBuffer) {
      this.drawItems(items, passEncoder, viewProj, viewMatrix, batchIndexOffset, options);
      return;
    }

    let cursor = 0;
    while (cursor < items.length) {
      const first = requiredItemAt(items, cursor, 'Render3D transparent submission items');
      const geometry = first.geometry;
      const material = first.material;
      const worldMatrix = first.worldMatrix;
      if (!geometry || !material || !worldMatrix) {
        cursor++;
        continue;
      }
      const registration = options.resolveMaterialRenderer(material);
      if (!registration) throwUnsupportedMaterial(material);
      if (!canBatchSortedTransparent(registration, material)) {
        this.drawItemsRange(
          items,
          passEncoder,
          viewProj,
          viewMatrix,
          cursor,
          1,
          batchIndexOffset + cursor,
          options,
        );
        cursor++;
        continue;
      }

      let end = cursor + 1;
      while (end < items.length) {
        const nextMaterial = items[end]?.material;
        if (
          !nextMaterial
          || options.resolveMaterialRenderer(nextMaterial) !== registration
          || !canBatchSortedTransparent(registration, nextMaterial)
        ) break;
        end++;
      }
      registration.renderSortedInstanceBatch(options.setMaterialRenderContext(
        passEncoder,
        first.entityId,
        geometry,
        material,
        first.clippingPlanes,
        worldMatrix,
        viewProj,
        viewMatrix,
      ), items, cursor, end - cursor, batchBuffer, batchIndexOffset + cursor);
      cursor = end;
    }
  }

  drawDepthPrepassItems(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    options: Render3DSubmitterOptions,
  ): void {
    for (const { entityId, geometry, material, clippingPlanes, worldMatrix } of items) {
      if (!geometry || !material || !worldMatrix) continue;
      const registration = options.resolveMaterialRenderer(material);
      if (!registration?.renderDepthPrepass || !registration.needsDepthPrepass?.(material)) continue;
      registration.renderDepthPrepass(options.setMaterialRenderContext(
        passEncoder,
        entityId,
        geometry,
        material,
        clippingPlanes,
        worldMatrix,
        viewProj,
        viewMatrix,
      ));
    }
  }

  drawItemsRange(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    start: number,
    count: number,
    batchIndexOffset: number,
    options: Render3DSubmitterOptions,
  ): void {
    const end = Math.min(items.length, start + count);
    for (let i = start; i < end; i++) {
      const { entityId, geometry, material, clippingPlanes, worldMatrix } = requiredItemAt(items, i, 'Render3D submission items');
      if (!geometry || !material || !worldMatrix) continue;
      const registration = options.resolveMaterialRenderer(material);
      if (!registration) throwUnsupportedMaterial(material);
      registration.renderItem(options.setMaterialRenderContext(
        passEncoder,
        entityId,
        geometry,
        material,
        clippingPlanes,
        worldMatrix,
        viewProj,
        viewMatrix,
        options.getGpuDrivenBatch(batchIndexOffset + i - start),
      ));
    }
  }

  drawItemRun(
    items: readonly Render3DRenderItem[],
    passEncoder: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewMatrix: Float32Array,
    firstBatch: number,
    batchCount: number,
    options: Render3DSubmitterOptions,
  ): void {
    const first = items[firstBatch];
    const firstGeometry = first?.geometry;
    const firstMaterial = first?.material;
    const firstWorldMatrix = first?.worldMatrix;
    if (!firstGeometry || !firstMaterial || !firstWorldMatrix) return;
    const registration = options.resolveMaterialRenderer(firstMaterial);
    if (!registration) throwUnsupportedMaterial(firstMaterial);
    const batchBuffer = options.batchBuffer;
    // prepareObjects() routes batchable opaque objects into the renderer's
    // batch object table before submission. Keep even a one-item mega run on
    // renderBatch() so preparation and drawing select the same table.
    if (!registration.renderBatch || !batchBuffer) {
      this.drawItemsRange(items, passEncoder, viewProj, viewMatrix, firstBatch, batchCount, firstBatch, options);
      return;
    }
    registration.renderBatch(options.setMaterialRenderContext(
      passEncoder,
      first.entityId,
      firstGeometry,
      firstMaterial,
      first.clippingPlanes,
      firstWorldMatrix,
      viewProj,
      viewMatrix,
    ), items, firstBatch, batchCount, batchBuffer);
  }

  private _prepareItemList(
    items: readonly Render3DRenderItem[],
    batchIndexOffset: number,
    viewContext: MaterialRendererViewContext,
    options: Render3DSubmitterOptions,
  ): void {
    let cursor = 0;
    while (cursor < items.length) {
      const first = requiredItemAt(items, cursor, 'Render3D prepare items');
      const material = first.material;
      if (!material) {
        cursor++;
        continue;
      }
      const registration = options.resolveMaterialRenderer(material);
      if (!registration) throwUnsupportedMaterial(material);
      if (this._activeRegistrations.indexOf(registration) < 0) {
        this._activeRegistrations.push(registration);
        registration.beginView?.(viewContext);
      }

      let end = cursor + 1;
      while (end < items.length) {
        const nextMaterial = items[end]?.material;
        if (!nextMaterial || options.resolveMaterialRenderer(nextMaterial) !== registration) break;
        end++;
      }
      if (registration.prepareObjects) {
        const count = end - cursor;
        registration.prepareObjects(viewContext, items, cursor, count, batchIndexOffset + cursor);
      }
      cursor = end;
    }
  }
}

function throwUnsupportedMaterial(material: Material): never {
  throw new EngineError(
    EngineErrorCode.RenderPipelineUnsupportedMaterial,
    `No material renderer is registered for ${material.constructor.name}.`,
    {
      hint: 'Call render3DSystem.registerMaterialRenderer(...) or pass a MaterialRendererRegistry with this material type registered.',
      docsPath: 'errors/E_RENDER_PIPELINE_UNSUPPORTED_MATERIAL',
    },
  );
}

function canBatchSortedTransparent(
  registration: MaterialRendererRegistration,
  material: Material,
): registration is MaterialRendererRegistration & Required<
  Pick<MaterialRendererRegistration, 'renderSortedInstanceBatch'>
> {
  return registration.renderSortedInstanceBatch !== undefined
    && registration.supportsSortedInstanceBatching?.(material) === true
    && registration.transparentDepthSort?.(material) === false
    && registration.needsDepthPrepass?.(material) !== true;
}
