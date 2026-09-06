import {
  PostProcessPass, getPostProcessTextureView,
  type PostProcessFrameContext, type PostProcessProjectionJitterContext, type PostProcessSceneTextures,
} from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getBuiltinPostprocessShader } from './BuiltinPostprocessShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';
import { TaaHistoryStore, type TaaHistory } from './TaaHistoryStore';

export interface TaaPassOptions {
  /** Maximum history contribution after validation. Defaults to 0.9. */
  feedback?: number;
  /** Normalized linear-depth rejection threshold. Defaults to 0.002. */
  depthThreshold?: number;
  /** Mild post-resolve sharpening in the range [0, 1]. Defaults to 0.15. */
  sharpness?: number;
  /** Halton projection-jitter scale in pixels. Defaults to 1. */
  jitterScale?: number;
}

/** Motion-reprojected temporal resolve with per-view HDR color and depth history. */
export class TaaPass extends PostProcessPass {
  readonly label = 'TAA';
  override readonly needsDepthTexture = true;
  override readonly needsMotionTexture = true;
  feedback: number;
  depthThreshold: number;
  sharpness: number;
  jitterScale: number;

  private readonly _pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private _module!: GPUShaderModule;
  private _pipelineLayout!: GPUPipelineLayout;
  private _bgl!: GPUBindGroupLayout;
  private _uniformWriter!: PrecompiledUniformBlockWriter;
  private _format!: GPUTextureFormat;
  private _device: GPUDevice | null = null;
  private _sceneTextures: PostProcessSceneTextures | null = null;
  private readonly _historyStore = new TaaHistoryStore();
  private readonly _projection = new Float32Array(16);
  private _resetSerial = 0;
  private _globalResetRevision = 0;
  private readonly _viewResetRevisions = new Map<string, number>();

  constructor(options: TaaPassOptions = {}) {
    super();
    this.feedback = finiteOption(options.feedback, 0.9, 'feedback');
    this.depthThreshold = finiteOption(options.depthThreshold, 0.002, 'depthThreshold');
    this.sharpness = finiteOption(options.sharpness, 0.15, 'sharpness');
    this.jitterScale = finiteOption(options.jitterScale, 1, 'jitterScale');
  }

  get stats(): { readonly historyCount: number; readonly validHistoryCount: number } {
    let validHistoryCount = 0;
    for (const history of this._historyStore.histories.values()) validHistoryCount += history.valid ? 1 : 0;
    return { historyCount: this._historyStore.histories.size, validHistoryCount };
  }

  override getProjectionJitter(context: PostProcessProjectionJitterContext, out: Float32Array): boolean {
    const sequenceIndex = context.frameId % 8 + 1;
    const scale = clamp(this.jitterScale, 0, 2);
    out[0] = (halton(sequenceIndex, 2) - 0.5) * scale;
    out[1] = (halton(sequenceIndex, 3) - 0.5) * scale;
    return true;
  }

  override getMotionHistoryRevision(viewKey?: string): number {
    return viewKey === undefined ? this._globalResetRevision : this._viewResetRevisions.get(viewKey) ?? this._globalResetRevision;
  }

  /** Cuts, seeks and teleports reset both color and object-motion history for the selected view. */
  resetHistory(viewKey?: string): void {
    this._resetSerial++;
    if (viewKey !== undefined) {
      this._viewResetRevisions.set(viewKey, this._resetSerial);
      const history = this._historyStore.histories.get(viewKey);
      if (history) history.valid = false;
    } else {
      this._globalResetRevision = this._resetSerial;
      this._viewResetRevisions.clear();
      for (const history of this._historyStore.histories.values()) history.valid = false;
    }
  }

  prepare(device: GPUDevice, format: GPUTextureFormat): void {
    if (this._device === device) { this._format = format; return; }
    if (this._device) this.destroy();
    const shader = getBuiltinPostprocessShader(device, 'taa');
    this._module = shader.module;
    this._bgl = shader.bindGroupLayout;
    this._pipelineLayout = shader.pipelineLayout;
    this._uniformWriter = new PrecompiledUniformBlockWriter(shader.pass, 'pass.taaParameters');
    this._format = format;
    this._device = device;
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    const format = this._format;
    this.addPipelineWarmup(plan, format, 'TAA', device, () => this._pipelineDescriptor(format),
      () => this._pipelines.has(format), pipeline => { this._pipelines.set(format, pipeline); });
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void { this._sceneTextures = textures; }

  apply(encoder: GPUCommandEncoder, src: GPUTexture, dstView: GPUTextureView, device: GPUDevice): void {
    const { depth, motion, frame } = this._sceneTextures ?? {};
    if (!depth || !motion || !frame) throw new Error('TaaPass requires linear depth, temporal motion and post-process frame context.');
    if (motion.format !== 'rgba16float') throw new Error('TaaPass requires temporal motion v2 (rgba16float: UV velocity, previous depth, validity).');
    for (const texture of [src, depth, motion]) {
      if (texture.width !== frame.width || texture.height !== frame.height) throw new Error('TaaPass scene textures must match the view dimensions.');
    }
    const history = this._historyStore.ensure(this, device, frame, this._format, this._uniformWriter.byteLength);
    unjitterProjection(frame, this._projection);
    const continuous = history.valid && history.cameraId === frame.cameraId && history.lastFrameId + 1 === frame.frameId
      && history.near === frame.near && history.far === frame.far && history.reverseZ === frame.reverseZ
      && history.isOrthographic === frame.isOrthographic && projectionEquals(history.projection, this._projection);
    this._writeUniforms(device, frame, history, continuous);

    const readIndex = history.readIndex;
    const writeIndex: 0 | 1 = readIndex === 0 ? 1 : 0;
    let bindGroup = history.bindGroups[readIndex];
    if (!bindGroup || history.bindGroupSources[readIndex] !== src || history.bindGroupDepths[readIndex] !== depth
      || history.bindGroupMotions[readIndex] !== motion) {
      bindGroup = device.createBindGroup({
        label: `TaaPass.${frame.viewKey}.bindGroup${readIndex}`, layout: this._bgl,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: history.colorViews[readIndex] },
          { binding: 2, resource: getPostProcessTextureView(depth) },
          { binding: 3, resource: history.depthViews[readIndex] },
          { binding: 4, resource: { buffer: history.uniformBuffer } },
          { binding: 5, resource: getPostProcessTextureView(motion) },
        ],
      });
      history.bindGroups[readIndex] = bindGroup;
      history.bindGroupSources[readIndex] = src;
      history.bindGroupDepths[readIndex] = depth;
      history.bindGroupMotions[readIndex] = motion;
    }
    let pipeline = this._pipelines.get(this._format);
    if (!pipeline) {
      pipeline = device.createRenderPipeline(this._pipelineDescriptor(this._format));
      this._pipelines.set(this._format, pipeline);
    }
    const pass = encoder.beginRenderPass({
      label: 'TaaPass.renderPass',
      colorAttachments: [dstView, history.colorViews[writeIndex], history.depthViews[writeIndex]].map(view => ({
        view, loadOp: 'clear' as const, clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' as const,
      })),
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    history.previousViewProjection.set(frame.viewProjectionMatrix);
    history.projection.set(this._projection);
    history.jitter.set(frame.projectionJitter);
    history.readIndex = writeIndex;
    history.valid = true;
    history.lastFrameId = frame.frameId;
    history.cameraId = frame.cameraId;
    history.near = frame.near;
    history.far = frame.far;
    history.reverseZ = frame.reverseZ;
    history.isOrthographic = frame.isOrthographic;
  }

  override resize(_device: GPUDevice, format: GPUTextureFormat): void {
    // Alternating output formats/sizes must not invalidate other views.
    this._format = format;
  }

  override destroy(): void {
    this._historyStore.destroy(this);
    this._pipelines.clear();
    this._sceneTextures = null;
    this._device = null;
    this._viewResetRevisions.clear();
  }

  private _writeUniforms(device: GPUDevice, frame: PostProcessFrameContext, history: TaaHistory, continuous: boolean): void {
    const writer = this._uniformWriter;
    const previous = continuous ? history.previousViewProjection : frame.viewProjectionMatrix;
    for (let component = 0; component < 16; component++) {
      writer.setF32('currentInverseViewProjection', component, frame.inverseViewProjectionMatrix[component]!);
      writer.setF32('previousViewProjection', component, previous[component]!);
    }
    writer.setF32('resolutionFeedback', 0, frame.width);
    writer.setF32('resolutionFeedback', 1, frame.height);
    writer.setF32('resolutionFeedback', 2, clamp(this.feedback, 0, 0.99));
    writer.setF32('resolutionFeedback', 3, clamp(this.sharpness, 0, 1));
    writer.setF32('depthHistory', 0, Math.max(0, this.depthThreshold));
    writer.setF32('depthHistory', 1, continuous ? 1 : 0);
    writer.setF32('depthHistory', 2, frame.near);
    writer.setF32('depthHistory', 3, frame.far);
    writer.setF32('projection', 0, frame.isOrthographic ? 1 : 0);
    writer.setF32('projection', 1, frame.reverseZ ? 1 : 0);
    writer.setF32('projection', 2, continuous ? ((frame.projectionJitter[0] ?? 0) - history.jitter[0]!) / frame.width : 0);
    writer.setF32('projection', 3, continuous ? ((frame.projectionJitter[1] ?? 0) - history.jitter[1]!) / frame.height : 0);
    device.queue.writeBuffer(history.uniformBuffer, 0, writer.buffer);
  }

  private _pipelineDescriptor(format: GPUTextureFormat): GPURenderPipelineDescriptor {
    return {
      label: 'TaaPass.pipeline', layout: this._pipelineLayout,
      vertex: { module: this._module, entryPoint: 'vs_main' },
      fragment: { module: this._module, entryPoint: 'fs_main', targets: [{ format }, { format: 'rgba16float' }, { format: 'r32float' }] },
      primitive: { topology: 'triangle-list' },
    };
  }
}

function unjitterProjection(frame: PostProcessFrameContext, out: Float32Array): void {
  out.set(frame.projectionMatrix);
  const x = 2 * (frame.projectionJitter[0] ?? 0) / frame.width;
  const y = -2 * (frame.projectionJitter[1] ?? 0) / frame.height;
  for (let column = 0; column < 4; column++) {
    const base = column * 4;
    out[base] = out[base]! - x * out[base + 3]!;
    out[base + 1] = out[base + 1]! - y * out[base + 3]!;
  }
}

function projectionEquals(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i]! - b[i]!) > 0.00001) return false;
  return true;
}

function finiteOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`TaaPass ${name} must be finite.`);
  return resolved;
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

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
