import {
  PostProcessPass,
  getPostProcessTextureView,
  type PostProcessFrameContext,
  type PostProcessSceneTextures,
} from './PostProcessPass';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getAmbientOcclusionShader } from './AmbientOcclusionShader';
import { PrecompiledUniformBlockWriter } from '../shader/PrecompiledShaderRuntime';
import { mat4 } from 'wgpu-matrix';

type AmbientOcclusionAlgorithm = 'gtao' | 'sao' | 'ssao';
type AmbientOcclusionQuality = 'low' | 'medium' | 'high';
type AmbientOcclusionDisplayMode = 'composite' | 'occlusion';
type AmbientOcclusionScratchFormat = 'r8unorm' | 'r16float';
type AmbientOcclusionResolutionScale = 0.5 | 1;

export interface AmbientOcclusionPassOptions {
  /** View-space sampling radius. Defaults to 1.25. */
  radius?: number;
  /** Occlusion strength. Defaults to 1. */
  intensity?: number;
  /** Self-occlusion rejection bias. Defaults to 0.025. */
  bias?: number;
  /** Contrast applied to the final visibility. Defaults to 1.35. */
  power?: number;
  /** View-space distance at which samples stop contributing. Defaults to 3. */
  distanceFalloff?: number;
  /** Fixed bounded sample tier. Defaults to medium. */
  quality?: 'low' | 'medium' | 'high';
  /** Composite with scene color or show the AO buffer. Defaults to composite. */
  displayMode?: 'composite' | 'occlusion';
  /** Internal AO resolution. Half resolution is the cross-device default. */
  resolutionScale?: 0.5 | 1;
  /** Single-channel AO scratch format. Defaults to the core `r8unorm` format. */
  scratchFormat?: 'r8unorm' | 'r16float';
}

interface AmbientOcclusionPassStats {
  readonly algorithm: AmbientOcclusionAlgorithm;
  readonly frameCount: number;
  readonly sampleCount: number;
  readonly sampleProbeCount: number;
  readonly renderPassCount: 3;
  readonly resolutionScale: AmbientOcclusionResolutionScale;
  readonly scratchFormat: AmbientOcclusionScratchFormat;
  readonly scratchWidth: number;
  readonly scratchHeight: number;
  readonly rawTextureBytes: number;
  readonly denoisedTextureBytes: number;
  readonly scratchTextureBytes: number;
  readonly estimatedBandwidth: Readonly<{
    occlusionBytes: number;
    denoiseBytes: number;
    upscaleBytes: number;
    totalBytes: number;
  }>;
}

/** Shared depth/normal AO runtime. Algorithm shaders are immutable build-time artifacts. */
class AmbientOcclusionPass extends PostProcessPass {
  override readonly needsDepthTexture = true;
  override readonly needsNormalTexture = true;
  readonly label: string;
  readonly algorithm: AmbientOcclusionAlgorithm;

  radius: number;
  intensity: number;
  bias: number;
  power: number;
  distanceFalloff: number;
  quality: AmbientOcclusionQuality;
  displayMode: AmbientOcclusionDisplayMode;
  readonly resolutionScale: AmbientOcclusionResolutionScale;
  readonly scratchFormat: AmbientOcclusionScratchFormat;

  private _occlusionPipeline: GPURenderPipeline | null = null;
  private _denoisePipeline: GPURenderPipeline | null = null;
  private _upscalePipeline: GPURenderPipeline | null = null;
  private _occlusionModule!: GPUShaderModule;
  private _occlusionLayout!: GPUPipelineLayout;
  private _occlusionBindGroupLayout!: GPUBindGroupLayout;
  private _denoiseModule!: GPUShaderModule;
  private _denoiseLayout!: GPUPipelineLayout;
  private _denoiseBindGroupLayout!: GPUBindGroupLayout;
  private _upscaleModule!: GPUShaderModule;
  private _upscaleLayout!: GPUPipelineLayout;
  private _upscaleBindGroupLayout!: GPUBindGroupLayout;
  private _sampler!: GPUSampler;
  private _uniformBuffer!: GPUBuffer;
  private _uniformWriter!: PrecompiledUniformBlockWriter;
  private _rawOcclusionTexture!: GPUTexture;
  private _rawOcclusionView!: GPUTextureView;
  private _denoisedOcclusionTexture!: GPUTexture;
  private _denoisedOcclusionView!: GPUTextureView;
  private _format!: GPUTextureFormat;
  private _width = 1;
  private _height = 1;
  private _scratchWidth = 1;
  private _scratchHeight = 1;
  private _sceneTextures: PostProcessSceneTextures | null = null;
  private _lastSource: GPUTexture | null = null;
  private _lastDepth: GPUTexture | null = null;
  private _lastNormal: GPUTexture | null = null;
  private _occlusionBindGroup: GPUBindGroup | null = null;
  private _denoiseBindGroup: GPUBindGroup | null = null;
  private _upscaleBindGroup: GPUBindGroup | null = null;
  private _frameCount = 0;
  private readonly _inverseProjectionMatrix = mat4.identity() as Float32Array;

  constructor(algorithm: AmbientOcclusionAlgorithm, options: AmbientOcclusionPassOptions = {}) {
    super();
    if (algorithm !== 'gtao' && algorithm !== 'sao' && algorithm !== 'ssao') {
      throw new RangeError(`AmbientOcclusionPass algorithm must be gtao, sao, or ssao; received ${String(algorithm)}.`);
    }
    this.algorithm = algorithm;
    this.label = algorithm.toUpperCase();
    this.radius = finite(options.radius, 1.25, 'radius', 0.01, 100);
    this.intensity = finite(options.intensity, 1, 'intensity', 0, 4);
    this.bias = finite(options.bias, 0.025, 'bias', 0, 0.5);
    this.power = finite(options.power, 1.35, 'power', 0.1, 4);
    this.distanceFalloff = finite(options.distanceFalloff, 3, 'distanceFalloff', 0.01, 100);
    this.quality = quality(options.quality ?? 'medium');
    this.displayMode = displayMode(options.displayMode ?? 'composite');
    this.resolutionScale = resolutionScale(options.resolutionScale ?? 0.5);
    this.scratchFormat = scratchFormat(options.scratchFormat ?? 'r8unorm');
  }

  get stats(): AmbientOcclusionPassStats {
    const samples = sampleCount(this.quality);
    const probes = sampleProbeCount(this.algorithm, samples);
    const bytesPerPixel = scratchBytesPerPixel(this.scratchFormat);
    const rawTextureBytes = this._scratchWidth * this._scratchHeight * bytesPerPixel;
    const estimatedBandwidth = estimateBandwidthBytes(
      this._width,
      this._height,
      this._scratchWidth,
      this._scratchHeight,
      bytesPerPixel,
      probes,
    );
    return Object.freeze({
      algorithm: this.algorithm,
      frameCount: this._frameCount,
      sampleCount: samples,
      sampleProbeCount: probes,
      renderPassCount: 3,
      resolutionScale: this.resolutionScale,
      scratchFormat: this.scratchFormat,
      scratchWidth: this._scratchWidth,
      scratchHeight: this._scratchHeight,
      rawTextureBytes,
      denoisedTextureBytes: rawTextureBytes,
      scratchTextureBytes: rawTextureBytes * 2,
      estimatedBandwidth,
    });
  }

  prepare(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    const shader = getAmbientOcclusionShader(device, this.algorithm);
    const denoise = getAmbientOcclusionShader(device, 'ao-denoise');
    const upscale = getAmbientOcclusionShader(device, 'ao-upscale');
    this._occlusionModule = shader.module;
    this._occlusionLayout = shader.pipelineLayout;
    this._occlusionBindGroupLayout = shader.bindGroupLayout;
    this._denoiseModule = denoise.module;
    this._denoiseLayout = denoise.pipelineLayout;
    this._denoiseBindGroupLayout = denoise.bindGroupLayout;
    this._upscaleModule = upscale.module;
    this._upscaleLayout = upscale.pipelineLayout;
    this._upscaleBindGroupLayout = upscale.bindGroupLayout;
    this._uniformWriter = new PrecompiledUniformBlockWriter(shader.pass, 'pass.ambientOcclusionParameters');
    this._format = format;
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._createOcclusionTextures(device);
    this._sampler = device.createSampler({
      label: `${this.label}Pass.linearSampler`,
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this._uniformBuffer = device.createBuffer({
      label: `${this.label}Pass.parameters`,
      size: this._uniformWriter.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  override contributePipelineWarmup(plan: PipelineWarmupPlan, device: GPUDevice): void {
    this.addPipelineWarmup(plan, 'occlusion', `${this.label} occlusion`, device, () => this._occlusionPipelineDescriptor(),
      () => this._occlusionPipeline !== null, pipeline => { this._occlusionPipeline = pipeline; });
    this.addPipelineWarmup(plan, 'denoise', `${this.label} denoise`, device, () => this._denoisePipelineDescriptor(),
      () => this._denoisePipeline !== null, pipeline => { this._denoisePipeline = pipeline; });
    this.addPipelineWarmup(plan, 'upscale', `${this.label} upscale`, device, () => this._upscalePipelineDescriptor(),
      () => this._upscalePipeline !== null, pipeline => { this._upscalePipeline = pipeline; });
  }

  override setSceneTextures(textures: PostProcessSceneTextures): void {
    this._sceneTextures = textures;
  }

  apply(encoder: GPUCommandEncoder, src: GPUTexture, dstView: GPUTextureView, device: GPUDevice): void {
    const depth = this._sceneTextures?.depth;
    const normal = this._sceneTextures?.normal;
    const frame = this._sceneTextures?.frame;
    if (!depth || !normal || !frame) {
      throw new Error(`${this.label}Pass requires linear-depth, view-normal, and post-process frame context.`);
    }
    this._writeUniforms(device, frame);
    if (src !== this._lastSource || depth !== this._lastDepth || normal !== this._lastNormal) {
      this._occlusionBindGroup = device.createBindGroup({
        label: `${this.label}Pass.occlusionBindGroup`,
        layout: this._occlusionBindGroupLayout,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: getPostProcessTextureView(depth) },
          { binding: 2, resource: getPostProcessTextureView(normal) },
          { binding: 3, resource: this._sampler },
          { binding: 4, resource: { buffer: this._uniformBuffer } },
        ],
      });
      this._denoiseBindGroup = device.createBindGroup({
        label: `${this.label}Pass.denoiseBindGroup`,
        layout: this._denoiseBindGroupLayout,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._rawOcclusionView },
          { binding: 2, resource: getPostProcessTextureView(depth) },
          { binding: 3, resource: getPostProcessTextureView(normal) },
          { binding: 4, resource: this._sampler },
          { binding: 5, resource: { buffer: this._uniformBuffer } },
        ],
      });
      this._upscaleBindGroup = device.createBindGroup({
        label: `${this.label}Pass.upscaleBindGroup`,
        layout: this._upscaleBindGroupLayout,
        entries: [
          { binding: 0, resource: getPostProcessTextureView(src) },
          { binding: 1, resource: this._denoisedOcclusionView },
          { binding: 2, resource: getPostProcessTextureView(depth) },
          { binding: 3, resource: getPostProcessTextureView(normal) },
          { binding: 4, resource: this._sampler },
          { binding: 5, resource: { buffer: this._uniformBuffer } },
        ],
      });
      this._lastSource = src;
      this._lastDepth = depth;
      this._lastNormal = normal;
    }
    const occlusionPass = encoder.beginRenderPass({
      label: `${this.label}Pass.occlusionPass`,
      colorAttachments: [{
        view: this._rawOcclusionView,
        loadOp: 'clear',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        storeOp: 'store',
      }],
    });
    occlusionPass.setPipeline(this._occlusionPipeline ??= device.createRenderPipeline(this._occlusionPipelineDescriptor()));
    occlusionPass.setBindGroup(0, this._occlusionBindGroup!);
    occlusionPass.draw(3);
    occlusionPass.end();
    const denoisePass = encoder.beginRenderPass({
      label: `${this.label}Pass.denoisePass`,
      colorAttachments: [{
        view: this._denoisedOcclusionView,
        loadOp: 'clear',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        storeOp: 'store',
      }],
    });
    denoisePass.setPipeline(this._denoisePipeline ??= device.createRenderPipeline(this._denoisePipelineDescriptor()));
    denoisePass.setBindGroup(0, this._denoiseBindGroup!);
    denoisePass.draw(3);
    denoisePass.end();
    const upscalePass = encoder.beginRenderPass({
      label: `${this.label}Pass.upscalePass`,
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        clearValue: { r: 1, g: 1, b: 1, a: 1 },
        storeOp: 'store',
      }],
    });
    upscalePass.setPipeline(this._upscalePipeline ??= device.createRenderPipeline(this._upscalePipelineDescriptor()));
    upscalePass.setBindGroup(0, this._upscaleBindGroup!);
    upscalePass.draw(3);
    upscalePass.end();
    this._frameCount++;
  }

  override resize(device: GPUDevice, format: GPUTextureFormat, width: number, height: number): void {
    if (format !== this._format) this._upscalePipeline = null;
    this._format = format;
    this._width = Math.max(1, width);
    this._height = Math.max(1, height);
    this._rawOcclusionTexture.destroy();
    this._denoisedOcclusionTexture.destroy();
    this._createOcclusionTextures(device);
    this._invalidateBindings();
  }

  override destroy(): void {
    this._occlusionPipeline = null;
    this._denoisePipeline = null;
    this._upscalePipeline = null;
    this._rawOcclusionTexture?.destroy();
    this._denoisedOcclusionTexture?.destroy();
    this._uniformBuffer?.destroy();
    this._sceneTextures = null;
    this._invalidateBindings();
  }

  private _writeUniforms(device: GPUDevice, frame: PostProcessFrameContext): void {
    const writer = this._uniformWriter;
    writer.setF32('resolution', 0, this._width);
    writer.setF32('resolution', 1, this._height);
    writer.setF32('resolution', 2, 1 / this._width);
    writer.setF32('resolution', 3, 1 / this._height);
    writer.setF32('radiusIntensityBiasPower', 0, finite(this.radius, 1.25, 'radius', 0.01, 100));
    writer.setF32('radiusIntensityBiasPower', 1, finite(this.intensity, 1, 'intensity', 0, 4));
    writer.setF32('radiusIntensityBiasPower', 2, finite(this.bias, 0.025, 'bias', 0, 0.5));
    writer.setF32('radiusIntensityBiasPower', 3, finite(this.power, 1.35, 'power', 0.1, 4));
    writer.setF32('camera', 0, frame.near);
    writer.setF32('camera', 1, frame.far);
    writer.setF32('camera', 2, frame.reverseZ ? 1 : 0);
    writer.setF32('camera', 3, frame.isOrthographic ? 1 : 0);
    writer.setF32('settings', 0, finite(this.distanceFalloff, 3, 'distanceFalloff', 0.01, 100));
    writer.setF32('settings', 1, displayMode(this.displayMode) === 'occlusion' ? 1 : 0);
    writer.setF32('settings', 2, sampleCount(quality(this.quality)));
    writer.setF32('settings', 3, 0);
    mat4.inverse(frame.projectionMatrix, this._inverseProjectionMatrix);
    for (let index = 0; index < 16; index++) {
      writer.setF32('projectionMatrix', index, frame.projectionMatrix[index] ?? 0);
      writer.setF32('inverseProjectionMatrix', index, this._inverseProjectionMatrix[index] ?? 0);
    }
    device.queue.writeBuffer(this._uniformBuffer, 0, writer.buffer);
  }

  private _occlusionPipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: `${this.label}Pass.occlusionPipeline`,
      layout: this._occlusionLayout,
      vertex: { module: this._occlusionModule, entryPoint: 'vs_main' },
      fragment: { module: this._occlusionModule, entryPoint: 'fs_main', targets: [{ format: this.scratchFormat }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _denoisePipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: `${this.label}Pass.denoisePipeline`,
      layout: this._denoiseLayout,
      vertex: { module: this._denoiseModule, entryPoint: 'vs_main' },
      fragment: { module: this._denoiseModule, entryPoint: 'fs_main', targets: [{ format: this.scratchFormat }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _upscalePipelineDescriptor(): GPURenderPipelineDescriptor {
    return {
      label: `${this.label}Pass.upscalePipeline`,
      layout: this._upscaleLayout,
      vertex: { module: this._upscaleModule, entryPoint: 'vs_main' },
      fragment: { module: this._upscaleModule, entryPoint: 'fs_main', targets: [{ format: this._format }] },
      primitive: { topology: 'triangle-list' },
    };
  }

  private _createOcclusionTextures(device: GPUDevice): void {
    this._scratchWidth = Math.max(1, Math.ceil(this._width * this.resolutionScale));
    this._scratchHeight = Math.max(1, Math.ceil(this._height * this.resolutionScale));
    this._rawOcclusionTexture = device.createTexture({
      label: `${this.label}Pass.rawOcclusionTexture`,
      size: [this._scratchWidth, this._scratchHeight],
      format: this.scratchFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._rawOcclusionView = this._rawOcclusionTexture.createView();
    this._denoisedOcclusionTexture = device.createTexture({
      label: `${this.label}Pass.denoisedOcclusionTexture`,
      size: [this._scratchWidth, this._scratchHeight],
      format: this.scratchFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this._denoisedOcclusionView = this._denoisedOcclusionTexture.createView();
  }

  private _invalidateBindings(): void {
    this._lastSource = null;
    this._lastDepth = null;
    this._lastNormal = null;
    this._occlusionBindGroup = null;
    this._denoiseBindGroup = null;
    this._upscaleBindGroup = null;
  }
}

export class SsaoPass extends AmbientOcclusionPass {
  constructor(options: AmbientOcclusionPassOptions = {}) { super('ssao', options); }
}

export class SaoPass extends AmbientOcclusionPass {
  constructor(options: AmbientOcclusionPassOptions = {}) { super('sao', options); }
}

export class GtaoPass extends AmbientOcclusionPass {
  constructor(options: AmbientOcclusionPassOptions = {}) { super('gtao', options); }
}

function sampleCount(value: AmbientOcclusionQuality): number {
  return value === 'low' ? 8 : value === 'high' ? 32 : 16;
}

function quality(value: AmbientOcclusionQuality): AmbientOcclusionQuality {
  if (value !== 'low' && value !== 'medium' && value !== 'high') {
    throw new RangeError(`Ambient occlusion quality must be low, medium, or high; received ${String(value)}.`);
  }
  return value;
}

function displayMode(value: AmbientOcclusionDisplayMode): AmbientOcclusionDisplayMode {
  if (value !== 'composite' && value !== 'occlusion') {
    throw new RangeError(`Ambient occlusion displayMode must be composite or occlusion; received ${String(value)}.`);
  }
  return value;
}

function resolutionScale(value: AmbientOcclusionResolutionScale): AmbientOcclusionResolutionScale {
  if (value !== 0.5 && value !== 1) {
    throw new RangeError(`Ambient occlusion resolutionScale must be 0.5 or 1; received ${String(value)}.`);
  }
  return value;
}

function scratchFormat(value: AmbientOcclusionScratchFormat): AmbientOcclusionScratchFormat {
  if (value !== 'r8unorm' && value !== 'r16float') {
    throw new RangeError(`Ambient occlusion scratchFormat must be r8unorm or r16float; received ${String(value)}.`);
  }
  return value;
}

function scratchBytesPerPixel(value: AmbientOcclusionScratchFormat): number {
  return value === 'r8unorm' ? 1 : 2;
}

function sampleProbeCount(algorithm: AmbientOcclusionAlgorithm, samples: number): number {
  if (algorithm !== 'gtao') return samples;
  const directionCount = samples >= 30 ? 5 : 3;
  return directionCount * Math.ceil(samples / directionCount) * 2;
}

function estimateBandwidthBytes(
  width: number,
  height: number,
  scratchWidth: number,
  scratchHeight: number,
  scratchBytes: number,
  sampleProbes: number,
): Readonly<{ occlusionBytes: number; denoiseBytes: number; upscaleBytes: number; totalBytes: number }> {
  const scratchPixels = scratchWidth * scratchHeight;
  const outputPixels = width * height;
  const occlusionBytes = scratchPixels * ((sampleProbes + 1) * 4 + 8 + scratchBytes);
  const denoiseBytes = scratchPixels * (17 * (4 + 8 + scratchBytes) + scratchBytes);
  const upscaleBytes = outputPixels * (4 + 4 + 8 + 4 * (scratchBytes + 4 + 8) + 4);
  return Object.freeze({
    occlusionBytes,
    denoiseBytes,
    upscaleBytes,
    totalBytes: occlusionBytes + denoiseBytes + upscaleBytes,
  });
}

function finite(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`AmbientOcclusionPass ${name} must be finite.`);
  return Math.min(max, Math.max(min, resolved));
}
