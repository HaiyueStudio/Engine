import {
  PostProcessPass,
  getPostProcessTextureView,
  type PostProcessSceneTextures,
} from './PostProcessPass';
import { MOTION_BLUR_SHADER_ARTIFACT } from '../shaders/generated/motion-blur-artifact.generated';
import {
  getPrecompiledShaderPassRuntime,
  PrecompiledUniformBlockWriter,
} from '../shader/PrecompiledShaderRuntime';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';

export interface MotionBlurPassOptions {
  /** Virtual shutter angle in degrees. 180 means half-frame exposure. Defaults to 180. */
  shutterAngle?: number;
  /** Artistic multiplier applied after the physical shutter scale. Defaults to 1. */
  intensity?: number;
  /** Number of color samples in [1, 32]. Defaults to 12. */
  sampleCount?: number;
  /** Maximum end-to-end blur length in display pixels. Defaults to 32. */
  maxBlurPixels?: number;
  /** Output visualization. `split` shows raw/blurred halves; `velocity` shows a direction heatmap. */
  displayMode?: 'blur' | 'split' | 'velocity';
  /** Stable silhouette reconstruction mode. Defaults to the inexpensive centered gather. */
  reconstruction?: 'centered' | 'tile-neighbor-max';
  /** Raw/blurred divider used by split display mode, in normalized screen coordinates. Defaults to 0.5. */
  splitPosition?: number;
  /** @deprecated Retained for source compatibility. Motion blur does not sample linear depth. */
  depthThreshold?: number;
}

const TILE_SIZE = 8;
const VELOCITY_FORMAT: GPUTextureFormat = 'rg16float';

/** Camera, rigid-object, GPU-morph, and skinned motion blur backed by a signed UV velocity buffer. */
export class MotionBlurPass extends PostProcessPass {
  readonly label = 'Motion blur';
  override readonly needsMotionTexture = true;

  shutterAngle: number;
  intensity: number;
  sampleCount: number;
  maxBlurPixels: number;
  displayMode: 'blur' | 'split' | 'velocity';
  reconstruction: 'centered' | 'tile-neighbor-max';
  splitPosition: number;
  /** @deprecated Retained for source compatibility. Motion blur does not sample linear depth. */
  depthThreshold: number;

  private _mainPipeline: GPURenderPipeline | null = null;
  private _tileMaxPipeline: GPURenderPipeline | null = null;
  private _neighborMaxPipeline: GPURenderPipeline | null = null;
  private _mainModule!: GPUShaderModule;
  private _tileMaxModule!: GPUShaderModule;
  private _neighborMaxModule!: GPUShaderModule;
  private _mainLayout!: GPUPipelineLayout;
  private _tileMaxLayout!: GPUPipelineLayout;
  private _neighborMaxLayout!: GPUPipelineLayout;
  private _mainBgl!: GPUBindGroupLayout;
  private _tileMaxBgl!: GPUBindGroupLayout;
  private _neighborMaxBgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _uniformBuffer!: GPUBuffer;
  private _tileParamsBuffer!: GPUBuffer;
  private _uniformWriter!: PrecompiledUniformBlockWriter;
  private _tileParamsWriter!: PrecompiledUniformBlockWriter;
  private _format!: GPUTextureFormat;
  private _width = 1;
  private _height = 1;
  private _tileResourcesFullSize = false;
  private _tileMaxTexture!: GPUTexture;
  private _tileMaxView!: GPUTextureView;
  private _neighborMaxTexture!: GPUTexture;
  private _neighborMaxView!: GPUTextureView;
  private _sceneTextures: PostProcessSceneTextures | null = null;
  private _mainBindGroup: GPUBindGroup | null = null;
  private _tileMaxBindGroup: GPUBindGroup | null = null;
  private _neighborMaxBindGroup!: GPUBindGroup;
  private _bindGroupSource: GPUTexture | null = null;
  private _bindGroupMotion: GPUTexture | null = null;
  private _historyRevision = 0;
  private _appliedFrameCount = 0;
  private _lastFrameId = -1;

  constructor(options: MotionBlurPassOptions = {}) {
    super();
    this.shutterAngle = finite(options.shutterAngle ?? 180, 'shutterAngle');
    this.intensity = finite(options.intensity ?? 1, 'intensity');
    this.sampleCount = integer(options.sampleCount ?? 12, 'sampleCount', 1, 32);
    this.maxBlurPixels = finite(options.maxBlurPixels ?? 32, 'maxBlurPixels');
    this.displayMode = enumValue(options.displayMode ?? 'blur', ['blur', 'split', 'velocity'], 'displayMode');
    this.reconstruction = enumValue(
      options.reconstruction ?? 'centered',
      ['centered', 'tile-neighbor-max'],
      'reconstruction',
    );
    this.splitPosition = finite(options.splitPosition ?? 0.5, 'splitPosition');
    this.depthThreshold = finite(options.depthThreshold ?? 0.01, 'depthThreshold');
  }

  get stats(): { readonly appliedFrameCount: number; readonly lastFrameId: number } {
    return Object.freeze({ appliedFrameCount: this._appliedFrameCount, lastFrameId: this._lastFrameId });
  }

  override getMotionHistoryRevision(): number { return this._historyRevision; }

  /** Invalidates previous camera/object transforms after a cut, seek, or teleport. */
  resetHistory(): void {
    this._historyRevision = this._historyRevision >= Number.MAX_SAFE_INTEGER ? 1 : this._historyRevision + 1;
  }

  prepare(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    this._format = format;
    const main = getPrecompiledShaderPassRuntime(device, MOTION_BLUR_SHADER_ARTIFACT, 'motion-blur-resolve');
    const tileMax = getPrecompiledShaderPassRuntime(device, MOTION_BLUR_SHADER_ARTIFACT, 'motion-tile-max');
    const neighborMax = getPrecompiledShaderPassRuntime(device, MOTION_BLUR_SHADER_ARTIFACT, 'motion-neighbor-max');
    this._mainModule = main.module;
    this._mainBgl = main.bindGroupLayout;
    this._mainLayout = main.pipelineLayout;
    this._tileMaxModule = tileMax.module;
    this._tileMaxBgl = tileMax.bindGroupLayout;
    this._tileMaxLayout = tileMax.pipelineLayout;
    this._neighborMaxModule = neighborMax.module;
    this._neighborMaxBgl = neighborMax.bindGroupLayout;
    this._neighborMaxLayout = neighborMax.pipelineLayout;
    this._uniformWriter = new PrecompiledUniformBlockWriter(main.pass, 'pass.motionBlurParameters');
    this._tileParamsWriter = new PrecompiledUniformBlockWriter(tileMax.pass, 'pass.motionTileParameters');
    this._sampler = device.createSampler({
      label: 'MotionBlurPass.linearSampler',
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this._uniformBuffer = device.createBuffer({
      label: 'MotionBlurPass.params',
      size: this._uniformWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._tileParamsBuffer = device.createBuffer({
      label: 'MotionBlurPass.tileParams',
      size: this._tileParamsWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._createSizedResources(device, width, height);
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', 'Motion blur reconstruction', device, () => this._mainPipelineDescriptor(),
      () => this._mainPipeline !== null, pipeline => { this._mainPipeline = pipeline; });
    if (this.reconstruction !== 'tile-neighbor-max') return;
    this.addPipelineWarmup(plan, 'tile-max', 'Motion blur tile max', device, () => this._tileMaxPipelineDescriptor(),
      () => this._tileMaxPipeline !== null, pipeline => { this._tileMaxPipeline = pipeline; });
    this.addPipelineWarmup(plan, 'neighbor-max', 'Motion blur neighbor max', device, () => this._neighborMaxPipelineDescriptor(),
      () => this._neighborMaxPipeline !== null, pipeline => { this._neighborMaxPipeline = pipeline; });
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void { this._sceneTextures = textures; }

  apply(encoder: GPUCommandEncoder, src: GPUTexture, dstView: GPUTextureView, device: GPUDevice): void {
    const motion = this._sceneTextures?.motion;
    const frame = this._sceneTextures?.frame;
    if (!motion || !frame) throw new Error('MotionBlurPass requires motion and frame context textures.');

    this._writeUniforms(device, frame.width, frame.height);
    if (this.reconstruction === 'tile-neighbor-max' && !this._tileResourcesFullSize) {
      this._createSizedResources(device, this._width, this._height, true);
    }
    this._ensureBindGroups(device, src, motion);

    if (this.reconstruction === 'tile-neighbor-max') {
      const tileMaxPass = encoder.beginRenderPass({
        label: 'MotionBlurPass.tileMax',
        colorAttachments: [{
          view: this._tileMaxView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        }],
      });
      tileMaxPass.setPipeline(this._tileMaxPipeline ??= device.createRenderPipeline(this._tileMaxPipelineDescriptor()));
      tileMaxPass.setBindGroup(0, this._tileMaxBindGroup!);
      tileMaxPass.draw(3);
      tileMaxPass.end();

      const neighborMaxPass = encoder.beginRenderPass({
        label: 'MotionBlurPass.neighborMax',
        colorAttachments: [{
          view: this._neighborMaxView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        }],
      });
      neighborMaxPass.setPipeline(this._neighborMaxPipeline ??= device.createRenderPipeline(this._neighborMaxPipelineDescriptor()));
      neighborMaxPass.setBindGroup(0, this._neighborMaxBindGroup);
      neighborMaxPass.draw(3);
      neighborMaxPass.end();
    }

    const pass = encoder.beginRenderPass({
      label: 'MotionBlurPass.reconstruct',
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this._mainPipeline ??= device.createRenderPipeline(this._mainPipelineDescriptor()));
    pass.setBindGroup(0, this._mainBindGroup!);
    pass.draw(3);
    pass.end();
    this._appliedFrameCount++;
    this._lastFrameId = frame.frameId;
  }

  override resize(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    if (format !== this._format) {
      this._format = format;
      this._mainPipeline = null;
    }
    this._createSizedResources(device, width, height, this.reconstruction === 'tile-neighbor-max');
  }

  override destroy(): void {
    this._mainPipeline = null;
    this._tileMaxPipeline = null;
    this._neighborMaxPipeline = null;
    this._uniformBuffer?.destroy();
    this._tileParamsBuffer?.destroy();
    this._tileMaxTexture?.destroy();
    this._neighborMaxTexture?.destroy();
    this._sceneTextures = null;
    this._clearBindGroups();
  }

  private _writeUniforms(device: GPUDevice, width: number, height: number): void {
    const writer = this._uniformWriter;
    writer.setF32('resolution', 0, width);
    writer.setF32('resolution', 1, height);
    writer.setF32('resolution', 2, 1 / Math.max(1, width));
    writer.setF32('resolution', 3, 1 / Math.max(1, height));
    writer.setF32('settings', 0, clamp(this.shutterAngle, 0, 360) / 360);
    writer.setF32('settings', 1, Math.max(0, this.intensity));
    writer.setF32('settings', 2, Math.max(0, this.maxBlurPixels));
    writer.setF32('settings', 3, clamp(Math.round(this.sampleCount), 1, 32));
    writer.setF32('display', 0, this.displayMode === 'velocity' ? 2 : this.displayMode === 'split' ? 1 : 0);
    writer.setF32('display', 1, this.reconstruction === 'tile-neighbor-max' ? 1 : 0);
    writer.setF32('display', 2, clamp(this.splitPosition, 0, 1));
    writer.setF32('display', 3, TILE_SIZE);
    device.queue.writeBuffer(this._uniformBuffer, 0, writer.buffer);
  }

  private _createSizedResources(
    device: GPUDevice,
    width: number,
    height: number,
    fullSize = this.reconstruction === 'tile-neighbor-max',
  ): void {
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._tileResourcesFullSize = fullSize;
    this._tileMaxTexture?.destroy();
    this._neighborMaxTexture?.destroy();
    const tileWidth = fullSize ? Math.ceil(this._width / TILE_SIZE) : 1;
    const tileHeight = fullSize ? Math.ceil(this._height / TILE_SIZE) : 1;
    const descriptor = {
      size: [tileWidth, tileHeight] as [number, number],
      format: VELOCITY_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };
    this._tileMaxTexture = device.createTexture({ ...descriptor, label: 'MotionBlurPass.tileMaxTexture' });
    this._tileMaxView = this._tileMaxTexture.createView();
    this._neighborMaxTexture = device.createTexture({ ...descriptor, label: 'MotionBlurPass.neighborMaxTexture' });
    this._neighborMaxView = this._neighborMaxTexture.createView();
    this._tileParamsWriter.setU32('sourceSize', 0, this._width);
    this._tileParamsWriter.setU32('sourceSize', 1, this._height);
    this._tileParamsWriter.setU32('tileSize', 0, TILE_SIZE);
    this._tileParamsWriter.setU32('padding', 0, 0);
    device.queue.writeBuffer(this._tileParamsBuffer, 0, this._tileParamsWriter.buffer);
    this._neighborMaxBindGroup = device.createBindGroup({
      label: 'MotionBlurPass.neighborMaxBindGroup',
      layout: this._neighborMaxBgl,
      entries: [{ binding: 0, resource: this._tileMaxView }],
    });
    this._clearBindGroups();
  }

  private _ensureBindGroups(device: GPUDevice, src: GPUTexture, motion: GPUTexture): void {
    if (this._bindGroupMotion !== motion || !this._tileMaxBindGroup) {
      this._tileMaxBindGroup = device.createBindGroup({
        label: 'MotionBlurPass.tileMaxBindGroup',
        layout: this._tileMaxBgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(motion) },
          { binding: 1, resource: { buffer: this._tileParamsBuffer } },
        ],
      });
    }
    if (
      !this._mainBindGroup
      || this._bindGroupSource !== src
      || this._bindGroupMotion !== motion
    ) {
      this._mainBindGroup = device.createBindGroup({
        label: 'MotionBlurPass.mainBindGroup',
        layout: this._mainBgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: getPostProcessTextureView(motion) },
          { binding: 2, resource: this._neighborMaxView },
          { binding: 3, resource: this._sampler },
          { binding: 4, resource: { buffer: this._uniformBuffer } },
        ],
      });
    }
    this._bindGroupSource = src;
    this._bindGroupMotion = motion;
  }

  private _clearBindGroups(): void {
    this._mainBindGroup = null;
    this._tileMaxBindGroup = null;
    this._bindGroupSource = null;
    this._bindGroupMotion = null;
  }

  private _mainPipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'MotionBlurPass.mainPipeline',
      layout: this._mainLayout,
      vertex: { module: this._mainModule, entryPoint: 'vs_main' },
      fragment: { module: this._mainModule, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _tileMaxPipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'MotionBlurPass.tileMaxPipeline',
      layout: this._tileMaxLayout,
      vertex: { module: this._tileMaxModule, entryPoint: 'vs_main' },
      fragment: { module: this._tileMaxModule, entryPoint: 'fs_main', targets: [{ format: VELOCITY_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _neighborMaxPipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'MotionBlurPass.neighborMaxPipeline',
      layout: this._neighborMaxLayout,
      vertex: { module: this._neighborMaxModule, entryPoint: 'vs_main' },
      fragment: { module: this._neighborMaxModule, entryPoint: 'fs_main', targets: [{ format: VELOCITY_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    };
  }
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`MotionBlurPass ${label} must be finite.`);
  return value;
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`MotionBlurPass ${label} must be an integer in [${minimum}, ${maximum}].`);
  }
  return value;
}

function enumValue<const T extends string>(value: string, values: readonly T[], label: string): T {
  if (!values.includes(value as T)) throw new RangeError(`MotionBlurPass ${label} must be one of ${values.join(', ')}.`);
  return value as T;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
