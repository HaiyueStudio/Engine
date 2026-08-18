import type { IEngine } from '../core/IEngine';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import type { Fog } from '../lighting/Fog';
import type { SceneRenderEnvironment } from '../frame/SceneRenderEnvironment';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { GpuDrivenBatchBuffer } from './GpuDrivenBatchBuffer';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { DirectionalShadowState } from './ShadowMapRenderer';
import type { ClippingPlanes } from '../components/ClippingPlanes';
import { MaterialRegistryBase } from './MaterialRegistryBase';
import type { MaterialRenderContract, MaterialRendererKey } from './MaterialRegistryBase';

export type { MaterialConstructor, MaterialRendererKey } from './MaterialRegistryBase';

export interface MaterialRendererViewContext {
  engine: IEngine;
  /** Stable identity of the RenderView currently being encoded. */
  viewKey: string;
  viewProj: Float32Array;
  viewMatrix: Float32Array;
  /** Uniform binding slot for the current RenderViewFrame. */
  viewSlot: number;
  eyePosition: [number, number, number];
  /** First enabled scene Fog component, or null when fog is disabled for this frame. */
  fog: Fog | null;
  reverseZ: boolean;
  msaaSamples: 1 | 4;
  /** Allocation-free scene lighting/environment snapshot for this view. */
  sceneEnvironment: SceneRenderEnvironment;
  /** CPU SceneFrame snapshot shared by all material and auxiliary renderers. */
  sceneFrameUniforms: SceneFrameUniformSnapshot;
  /** Scene-global directional shadow rendered before the view, or null when unavailable. */
  directionalShadow: DirectionalShadowState | null;
  /** PBR multi-shadow slots; indices match the leading directional lights in sceneEnvironment.pbrLights. */
  directionalShadows: readonly (DirectionalShadowState | null)[];
  commandContext: RenderCommandContext;
  /** Shared GPU batch storage for this view, or null when indirect batches are unavailable. */
  gpuDrivenBatchBuffer: GpuDrivenBatchBuffer | null;
  /** Resolves the optional GPU-driven draw record associated with a prepared object. */
  getGpuDrivenBatch(batchIndex: number): MaterialGpuDrivenBatch | undefined;
}

export interface MaterialRenderContext<M extends Material = Material> extends MaterialRendererViewContext {
  passEncoder: GPURenderPassEncoder;
  entityId: number;
  geometry: Geometry3D;
  material: M;
  clippingPlanes: ClippingPlanes | null;
  worldMatrix: Float32Array;
}

export interface MaterialRenderBatchItem<M extends Material = Material> {
  entityId: number;
  geometry: Geometry3D | null;
  material: M | null;
  clippingPlanes: ClippingPlanes | null;
  worldMatrix: Float32Array | null;
}

export interface MaterialGpuDrivenBatch {
  batchBuffer: GpuDrivenBatchBuffer;
  /** View-local indirect-command index. */
  batchIndex: number;
  /** Scene-global object-table slot encoded as firstInstance. */
  objectSlot: number;
  materialSlot: number;
  rendererSlot: number;
  indexedIndirectBuffer: GPUBuffer;
  indexedIndirectOffset: number;
  drawIndirectBuffer: GPUBuffer;
  drawIndirectOffset: number;
  instanceTableBuffer: GPUBuffer;
  materialTableBuffer: GPUBuffer;
  megaBatchRunBuffer: GPUBuffer;
}

/** @internal Render3D implementation context. */
export interface InternalMaterialRenderContext<M extends Material = Material> extends MaterialRenderContext<M> {
  gpuDrivenBatch?: MaterialGpuDrivenBatch | undefined;
}

export interface MaterialRendererRegistration<M extends Material = Material> extends MaterialRenderContract<M> {
  /** Whether this material participates in directional-shadow receiver planning. */
  receivesDirectionalShadow?: boolean | ((material: M) => boolean);
  /** Resolves a material override for directional-shadow pipeline culling. */
  shadowCullMode?: (material: M) => GPUCullMode | null;
  /** Called at most once for this renderer before any object preparation in a view. */
  beginView?: (context: MaterialRendererViewContext) => void;
  /** Receives an allocation-free range of the original render-item array. Implementations must not retain it. */
  prepareObjects?: (
    context: MaterialRendererViewContext,
    items: readonly MaterialRenderBatchItem<M>[],
    first: number,
    count: number,
    /** View-local batch index corresponding exactly to items[first]. */
    firstBatchIndex: number,
  ) => void;
  /** Commits queued object/material/deformation uploads before draw encoding starts. */
  flushUploads?: (context: MaterialRendererViewContext) => void;
  needsDepthPrepass?: (material: M) => boolean;
  renderDepthPrepass?: (context: MaterialRenderContext<M>) => void;
  renderItem(context: MaterialRenderContext<M>): void;
  renderBatch?: (
    context: MaterialRenderContext<M>,
    items: readonly MaterialRenderBatchItem<M>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
  ) => void;
  /**
   * Explicit opt-in for transparent materials whose already-sorted instances
   * may be submitted together without changing their blending semantics.
   */
  supportsSortedInstanceBatching?: (material: M) => boolean;
  /**
   * Draws an allocation-free range from the transparent sorted list.
   * Implementations must preserve the supplied order and compatibility checks.
   */
  renderSortedInstanceBatch?: (
    context: MaterialRenderContext<M>,
    items: readonly MaterialRenderBatchItem<M>[],
    first: number,
    count: number,
    batchBuffer: GpuDrivenBatchBuffer,
    /** View-local batch index corresponding exactly to items[first]. */
    firstBatchIndex: number,
  ) => void;
  /** Called once after the renderer's final draw in a view. */
  endView?: (context: MaterialRendererViewContext) => void;
}

export class MaterialRendererRegistry extends MaterialRegistryBase<Material, MaterialRendererRegistration> {
  register<M extends Material>(registration: MaterialRendererRegistration<M>): this {
    return super.register(registration as unknown as MaterialRendererRegistration);
  }

  unregister(materialType: MaterialRendererKey): this {
    return super.unregister(materialType);
  }

  resolve<M extends Material>(material: M): MaterialRendererRegistration<M> | null {
    return this.resolveRegistration(material) as unknown as MaterialRendererRegistration<M> | null;
  }

  resolveShadowCullMode(material: Material): GPUCullMode | null {
    const registration = this.resolve(material) as MaterialRendererRegistration<Material> | null;
    return registration?.shadowCullMode?.(material) ?? null;
  }

  receivesDirectionalShadow(material: Material): boolean {
    const registration = this.resolve(material) as MaterialRendererRegistration<Material> | null;
    const capability = registration?.receivesDirectionalShadow;
    return typeof capability === 'function' ? capability(material) : capability === true;
  }
}
