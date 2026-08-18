import fullscreenVertWgsl from '../shaders/generated/postprocess-fullscreen.generated.wgsl';
import { createRenderPipelineAsync, type PipelineWarmupPlan } from '../renderer/PipelineWarmup';
/**
 * Abstract base for all post-processing passes.
 *
 * Implement `prepare()` to create GPU resources and `apply()` to encode
 * the render pass that reads `src` and writes to `dstView`.
 *
 * The standard fullscreen-triangle vertex shader is already compiled by
 * each concrete pass.  `src` / `dstView` are managed by PostProcessRenderer.
 */
export interface PostProcessSceneTextures {
  depth?: GPUTexture | undefined;
  normal?: GPUTexture | undefined;
  motion?: GPUTexture | undefined;
  outlineMask?: GPUTexture | undefined;
  outlineVisibleMask?: GPUTexture | undefined;
  frame?: PostProcessFrameContext | undefined;
}

export interface PostProcessProjectionJitterContext {
  readonly viewKey: string;
  readonly frameId: number;
  readonly width: number;
  readonly height: number;
}

export interface PostProcessFrameContext extends PostProcessProjectionJitterContext {
  readonly cameraId: number;
  readonly reverseZ: boolean;
  readonly near: number;
  readonly far: number;
  readonly isOrthographic: boolean;
  readonly projectionJitter: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly inverseViewProjectionMatrix: Float32Array;
}

export abstract class PostProcessPass {
  private readonly _pipelineWarmupId = ++postProcessWarmupId;
  abstract readonly label: string;

  /** Set true when the pass needs a linear-depth scene texture. */
  readonly needsDepthTexture?: boolean;

  /** Set true when the pass needs a view-space normal scene texture. */
  readonly needsNormalTexture?: boolean;

  /** Set true when the pass needs a signed UV-space motion-vector texture. */
  readonly needsMotionTexture?: boolean;

  /** Set true when the pass needs a selected-object outline mask texture. */
  readonly needsOutlineMask?: boolean;

  /**
   * Called once (or after `resize`) to create pipelines, buffers, and
   * samplers.  Always called before the first `apply()`.
   */
  abstract prepare(
    device: GPUDevice,
    format: GPUTextureFormat,
    width: number,
    height: number,
  ): void;

  /** Adds this pass's render pipelines after prepare() has created layouts/modules. */
  contributePipelineWarmup(_plan: PipelineWarmupPlan, _device: GPUDevice): void {}

  /**
   * Encode the pass into `encoder`.
   * - `src`     — the texture written by the previous pass (or the 3-D scene)
   * - `dstView` — the view to render into (intermediate buffer or swapchain)
   */
  abstract apply(
    encoder: GPUCommandEncoder,
    src: GPUTexture,
    dstView: GPUTextureView,
    device: GPUDevice,
  ): void;

  /** Called before `apply()` when the pass declares scene-buffer dependencies. */
  setSceneTextures(_textures: PostProcessSceneTextures): void {}

  /** Writes a view-local sub-pixel projection offset. The first participating pass wins. */
  getProjectionJitter(
    _context: PostProcessProjectionJitterContext,
    _out: Float32Array,
  ): boolean { return false; }

  /** Revision used to invalidate renderer-owned motion history after cuts or teleports. */
  getMotionHistoryRevision(): number { return 0; }

  /** Called when the viewport dimensions change.  Override to recreate sized resources. */
  resize(
    device: GPUDevice,
    format: GPUTextureFormat,
    width: number,
    height: number,
  ): void { void device; void format; void width; void height; }

  destroy(): void {}

  protected addPipelineWarmup(
    plan: PipelineWarmupPlan,
    key: string,
    label: string,
    device: GPUDevice,
    descriptor: () => GPURenderPipelineDescriptor,
    isReady: () => boolean,
    assign: (pipeline: GPURenderPipeline) => void,
  ): void {
    plan.add({
      id: `${this.constructor.name}#${this._pipelineWarmupId}:${key}`,
      label,
      compile: async () => {
        if (isReady()) return;
        assign(await createRenderPipelineAsync(device, descriptor(), {
          renderer: this.constructor.name,
          key,
          label,
        }));
      },
    });
  }
}

let postProcessWarmupId = 0;

const postProcessTextureViewCache = new WeakMap<GPUTexture, GPUTextureView>();

export function getPostProcessTextureView(texture: GPUTexture): GPUTextureView {
  let view = postProcessTextureViewCache.get(texture);
  if (!view) {
    view = texture.createView();
    postProcessTextureViewCache.set(texture, view);
  }
  return view;
}

// CustomPass is the intentional raw-WGSL escape hatch, but its vertex contract
// still comes from the generated builtin postprocess standard library.
export const FULLSCREEN_VERT_WGSL = fullscreenVertWgsl;
