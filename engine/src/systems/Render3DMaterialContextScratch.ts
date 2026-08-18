import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { Material } from '../material/Material';
import type { InternalMaterialRenderContext, MaterialGpuDrivenBatch } from '../renderer/MaterialRendererRegistry';
import type { SceneRenderEnvironment } from '../frame/SceneRenderEnvironment';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';

const EMPTY_DIRECTIONAL_SHADOWS = Object.freeze([]);
const RELEASED_REFERENCES = {
  passEncoder: null as unknown as GPURenderPassEncoder,
  geometry: null as unknown as Geometry3D,
  material: null as unknown as Material,
  clippingPlanes: null,
  worldMatrix: null as unknown as Float32Array,
  viewProj: null as unknown as Float32Array,
  viewMatrix: null as unknown as Float32Array,
  fog: null,
  sceneEnvironment: null as unknown as SceneRenderEnvironment,
  sceneFrameUniforms: null as unknown as SceneFrameUniformSnapshot,
  directionalShadow: null,
  directionalShadows: EMPTY_DIRECTIONAL_SHADOWS,
  commandContext: null as unknown as RenderCommandContext,
  gpuDrivenBatch: undefined,
  gpuDrivenBatchBuffer: null,
} satisfies Partial<InternalMaterialRenderContext>;

/** Call-reset scratch for the draw-local material context used by Render3DSubmitter. */
export class Render3DMaterialContextScratch {
  readonly context: InternalMaterialRenderContext;

  constructor(getGpuDrivenBatch: (batchIndex: number) => MaterialGpuDrivenBatch | undefined) {
    this.context = {
      engine: null as unknown as IEngine,
      viewKey: '',
      entityId: 0,
      viewSlot: 0,
      eyePosition: [0, 0, 0],
      reverseZ: false,
      msaaSamples: 1,
      ...RELEASED_REFERENCES,
      getGpuDrivenBatch,
    };
  }

  reset(): void {
    Object.assign(this.context, RELEASED_REFERENCES);
  }
}
