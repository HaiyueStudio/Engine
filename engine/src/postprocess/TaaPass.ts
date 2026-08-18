import {
  PostProcessPass,
  getPostProcessTextureView,
  type PostProcessFrameContext,
  type PostProcessProjectionJitterContext,
  type PostProcessSceneTextures,
} from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';

export interface TaaPassOptions {
  /** History contribution after validation. Defaults to 0.9. */
  feedback?: number;
  /** Normalized linear-depth rejection threshold. Defaults to 0.002. */
  depthThreshold?: number;
  /** Mild post-resolve sharpening in the range [0, 1]. Defaults to 0.15. */
  sharpness?: number;
  /** Halton projection-jitter scale in pixels. Defaults to 1. */
  jitterScale?: number;
}

interface TaaHistory {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly textures: [GPUTexture, GPUTexture];
  readonly views: [GPUTextureView, GPUTextureView];
  readonly bindGroups: [GPUBindGroup | null, GPUBindGroup | null];
  readonly bindGroupSources: [GPUTexture | null, GPUTexture | null];
  readonly bindGroupDepths: [GPUTexture | null, GPUTexture | null];
  readonly previousViewProjection: Float32Array;
  readonly uniformBuffer: GPUBuffer;
  readIndex: 0 | 1;
  valid: boolean;
  lastFrameId: number;
  lastSeenFrameId: number;
  cameraId: number;
  near: number;
  far: number;
  reverseZ: boolean;
  isOrthographic: boolean;
}

/** Temporal anti-aliasing with camera reprojection, depth rejection and neighborhood clipping. */
export class TaaPass extends PostProcessPass {
  readonly label = 'TAA';
  override readonly needsDepthTexture = true;

  feedback: number;
  depthThreshold: number;
  sharpness: number;
  jitterScale: number;

  private _pipeline: GPURenderPipeline | null = null;
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _bgl!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _uniformWriter!: PrecompiledUniformBlockWriter;
  private _format!: GPUTextureFormat;
  private _sceneTextures: PostProcessSceneTextures | null = null;
  private readonly _histories = new Map<string, TaaHistory>();

  constructor(options: TaaPassOptions = {}) {
    super();
    this.feedback = finiteOption(options.feedback, 0.9, 'feedback');
    this.depthThreshold = finiteOption(options.depthThreshold, 0.002, 'depthThreshold');
    this.sharpness = finiteOption(options.sharpness, 0.15, 'sharpness');
    this.jitterScale = finiteOption(options.jitterScale, 1, 'jitterScale');
  }

  get stats(): { readonly historyCount: number; readonly validHistoryCount: number } {
    let validHistoryCount = 0;
    for (const history of this._histories.values()) validHistoryCount += history.valid ? 1 : 0;
    return { historyCount: this._histories.size, validHistoryCount };
  }

  override getProjectionJitter(context: PostProcessProjectionJitterContext, out: Float32Array): boolean {
    const sequenceIndex = context.frameId % 8 + 1;
    const scale = clamp(this.jitterScale, 0, 2);
    out[0] = (halton(sequenceIndex, 2) - 0.5) * scale;
    out[1] = (halton(sequenceIndex, 3) - 0.5) * scale;
    return true;
  }

  prepare(device: GPUDevice, format: GPUTextureFormat): void {
    const shader = getBuiltinPostprocessShader(device, 'taa');
    this._module = shader.module;
    this._bgl = shader.bindGroupLayout;
    this._pipelineLayout = shader.pipelineLayout;
    this._uniformWriter = new PrecompiledUniformBlockWriter(shader.pass, 'pass.taaParameters');
    this._sampler = device.createSampler({
      label: 'TaaPass.linearSampler',
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this._format = format;
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'main', 'TAA', device, () => this._pipelineDescriptor(),
      () => this._pipeline !== null, pipeline => { this._pipeline = pipeline; });
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void {
    this._sceneTextures = textures;
  }

  apply(encoder: GPUCommandEncoder, src: GPUTexture, dstView: GPUTextureView, device: GPUDevice): void {
    const depth = this._sceneTextures?.depth;
    const frame = this._sceneTextures?.frame;
    if (!depth || !frame) {
      throw new Error('TaaPass requires the scene linear-depth texture and post-process frame context.');
    }

    const history = this._getOrCreateHistory(device, frame);
    const historyIsContinuous = history.valid
      && history.cameraId === frame.cameraId
      && history.lastFrameId + 1 === frame.frameId
      && history.near === frame.near
      && history.far === frame.far
      && history.reverseZ === frame.reverseZ
      && history.isOrthographic === frame.isOrthographic;
    this._writeUniforms(device, frame, history, historyIsContinuous);

    const readIndex = history.readIndex;
    const writeIndex: 0 | 1 = readIndex === 0 ? 1 : 0;
    let bindGroup = history.bindGroups[readIndex];
    if (
      !bindGroup
      || history.bindGroupSources[readIndex] !== src
      || history.bindGroupDepths[readIndex] !== depth
    ) {
      bindGroup = device.createBindGroup({
        label: `TaaPass.${frame.viewKey}.bindGroup${readIndex}`,
        layout: this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: history.views[readIndex] },
          { binding: 2, resource: getPostProcessTextureView(depth) },
          { binding: 3, resource: this._sampler },
          { binding: 4, resource: { buffer: history.uniformBuffer } },
        ],
      });
      history.bindGroups[readIndex] = bindGroup;
      history.bindGroupSources[readIndex] = src;
      history.bindGroupDepths[readIndex] = depth;
    }

    const pass = encoder.beginRenderPass({
      label: 'TaaPass.renderPass',
      colorAttachments: [
        {
          view: dstView,
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
        {
          view: history.views[writeIndex],
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this._pipeline ??= device.createRenderPipeline(this._pipelineDescriptor()));
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();

    history.previousViewProjection.set(frame.viewProjectionMatrix);
    history.readIndex = writeIndex;
    history.valid = true;
    history.lastFrameId = frame.frameId;
    history.cameraId = frame.cameraId;
    history.near = frame.near;
    history.far = frame.far;
    history.reverseZ = frame.reverseZ;
    history.isOrthographic = frame.isOrthographic;
  }

  /** Invalidates one view's history, or every view when no key is provided. */
  resetHistory(viewKey?: string): void {
    if (viewKey !== undefined) {
      const history = this._histories.get(viewKey);
      if (history) history.valid = false;
      return;
    }
    for (const history of this._histories.values()) history.valid = false;
  }

  override resize(_device: GPUDevice, format: GPUTextureFormat): void {
    if (format === this._format) return;
    this._format = format;
    this._pipeline = null;
    this._destroyHistories();
  }

  override destroy(): void {
    this._pipeline = null;
    this._destroyHistories();
    this._sceneTextures = null;
  }

  private _getOrCreateHistory(device: GPUDevice, frame: PostProcessFrameContext): TaaHistory {
    this._sweepStaleHistories(frame.frameId, frame.viewKey);
    const cached = this._histories.get(frame.viewKey);
    if (cached && cached.width === frame.width && cached.height === frame.height && cached.format === this._format) {
      cached.lastSeenFrameId = frame.frameId;
      return cached;
    }
    if (cached) this._destroyHistory(cached);

    const createTexture = (index: number): GPUTexture => device.createTexture({
      label: `TaaPass.${frame.viewKey}.history${index}`,
      size: [frame.width, frame.height],
      format: this._format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const texture0 = createTexture(0);
    const texture1 = createTexture(1);
    const history: TaaHistory = {
      width: frame.width,
      height: frame.height,
      format: this._format,
      textures: [texture0, texture1],
      views: [texture0.createView(), texture1.createView()],
      bindGroups: [null, null],
      bindGroupSources: [null, null],
      bindGroupDepths: [null, null],
      previousViewProjection: new Float32Array(16),
      uniformBuffer: device.createBuffer({
        label: `TaaPass.${frame.viewKey}.params`,
        size: this._uniformWriter.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      readIndex: 0,
      valid: false,
      lastFrameId: -1,
      lastSeenFrameId: frame.frameId,
      cameraId: -1,
      near: Number.NaN,
      far: Number.NaN,
      reverseZ: false,
      isOrthographic: false,
    };
    this._histories.set(frame.viewKey, history);
    return history;
  }

  private _sweepStaleHistories(frameId: number, activeViewKey: string): void {
    for (const [viewKey, history] of this._histories) {
      if (viewKey === activeViewKey) continue;
      if (frameId >= history.lastSeenFrameId && frameId - history.lastSeenFrameId <= 120) continue;
      this._destroyHistory(history);
      this._histories.delete(viewKey);
    }
  }

  private _writeUniforms(
    device: GPUDevice,
    frame: PostProcessFrameContext,
    history: TaaHistory,
    historyIsContinuous: boolean,
  ): void {
    const writer = this._uniformWriter;
    const previous = historyIsContinuous ? history.previousViewProjection : frame.viewProjectionMatrix;
    for (let component = 0; component < 16; component++) {
      writer.setF32('currentInverseViewProjection', component, frame.inverseViewProjectionMatrix[component]!);
      writer.setF32('previousViewProjection', component, previous[component]!);
    }
    writer.setF32('resolutionFeedback', 0, frame.width);
    writer.setF32('resolutionFeedback', 1, frame.height);
    writer.setF32('resolutionFeedback', 2, clamp(this.feedback, 0, 0.99));
    writer.setF32('resolutionFeedback', 3, clamp(this.sharpness, 0, 1));
    writer.setF32('depthHistory', 0, Math.max(0, this.depthThreshold));
    writer.setF32('depthHistory', 1, historyIsContinuous ? 1 : 0);
    writer.setF32('depthHistory', 2, frame.near);
    writer.setF32('depthHistory', 3, frame.far);
    writer.setF32('projection', 0, frame.isOrthographic ? 1 : 0);
    writer.setF32('projection', 1, frame.reverseZ ? 1 : 0);
    writer.setF32('projection', 2, frame.projectionJitter[0] ?? 0);
    writer.setF32('projection', 3, frame.projectionJitter[1] ?? 0);
    device.queue.writeBuffer(history.uniformBuffer, 0, writer.buffer);
  }

  private _pipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: 'TaaPass.pipeline',
      layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: {
        module: this._module,
        entryPoint: 'fs_main',
        targets: [{ format: this._format }, { format: this._format }],
      },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _destroyHistories(): void {
    for (const history of this._histories.values()) this._destroyHistory(history);
    this._histories.clear();
  }

  private _destroyHistory(history: TaaHistory): void {
    history.uniformBuffer.destroy();
    history.textures[0].destroy();
    history.textures[1].destroy();
  }
}

function finiteOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`TaaPass ${name} must be finite.`);
  return resolved;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let remaining = index;
  while (remaining > 0) {
    result += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
    fraction /= base;
  }
  return result;
}
