import type { RayProgressiveDiagnostic } from '../sampling/types.js';
import { samplingDiagnostic } from '../sampling/diagnostics.js';
import { createRayDenoiseLayouts, RAY_DENOISE_LAYOUT } from './layout.js';
import { RAY_DENOISE_SHADER_ARTIFACT } from './shaders/denoise-artifact.generated.js';
import type { RayDenoiseCreateResult, RayDenoiseOptions, RayDenoiseRecordOptions, RayDenoiseRecordResult } from './types.js';

interface ResolvedOptions { readonly temporalFeedback: number; readonly phiColor: number; readonly phiFeature: number; readonly varianceBoost: number }

export class RaySpatialTemporalDenoiser {
  readonly artifactHash = RAY_DENOISE_LAYOUT.artifactHash;
  readonly revision: string;
  private readonly _device: GPUDevice;
  private readonly _options: ResolvedOptions;
  private _layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout] | null;
  private _temporalPipeline: GPUComputePipeline | null;
  private _spatialPipeline: GPUComputePipeline | null;
  private _history: [GPUTexture, GPUTexture] | null = null;
  private _scratch: GPUTexture | null = null;
  private _width = 0;
  private _height = 0;
  private _destroyed = false;

  private constructor(device: GPUDevice, options: ResolvedOptions, layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout], temporal: GPUComputePipeline, spatial: GPUComputePipeline) {
    this._device = device; this._options = options; this._layouts = layouts; this._temporalPipeline = temporal; this._spatialPipeline = spatial;
    this.revision = `${this.artifactHash}:${options.temporalFeedback}:${options.phiColor}:${options.phiFeature}:${options.varianceBoost}`;
  }

  static async create(device: GPUDevice, options: RayDenoiseOptions = {}): Promise<RayDenoiseCreateResult> {
    const diagnostics: RayProgressiveDiagnostic[] = [];
    const resolved = resolveOptions(options, diagnostics);
    if (device.limits.maxBindingsPerBindGroup < 6 || device.limits.maxSampledTexturesPerShaderStage < 4 || device.limits.maxStorageTexturesPerShaderStage < 1) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_LIMIT_UNSUPPORTED', 'WebGPU limits are below the denoiser Artifact V2 requirements.', {}));
    if (!resolved || diagnostics.some(value => value.severity === 'error')) return freezeCreate(null, diagnostics);
    device.pushErrorScope('validation');
    try {
      const temporalModule = device.createShaderModule({ label: 'ray-denoise-temporal-v2', code: RAY_DENOISE_SHADER_ARTIFACT.passes[RAY_DENOISE_LAYOUT.temporalPassId]!.code });
      const spatialModule = device.createShaderModule({ label: 'ray-denoise-spatial-v2', code: RAY_DENOISE_SHADER_ARTIFACT.passes[RAY_DENOISE_LAYOUT.spatialPassId]!.code });
      const compilation = await Promise.all([temporalModule.getCompilationInfo(), spatialModule.getCompilationInfo()]);
      const errors = compilation.flatMap((info, index) => info.messages.filter(message => message.type === 'error').map(message => `${index === 0 ? 'temporal' : 'spatial'}:${message.lineNum}:${message.linePos} ${message.message}`));
      if (errors.length) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_SHADER_COMPILATION_FAILED', errors.join('\n'), { errorCount: errors.length }));
      const layouts = createRayDenoiseLayouts(device);
      const pipelines = await Promise.all([
        device.createComputePipelineAsync({ label: 'ray-denoise-temporal', layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[0]] }), compute: { module: temporalModule, entryPoint: 'temporal_main' } }),
        device.createComputePipelineAsync({ label: 'ray-denoise-spatial', layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[1]] }), compute: { module: spatialModule, entryPoint: 'spatial_main' } }),
      ]);
      const validation = await device.popErrorScope();
      if (validation) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_GPU_VALIDATION_ERROR', validation.message, {}));
      return diagnostics.some(value => value.severity === 'error') ? freezeCreate(null, diagnostics)
        : freezeCreate(new RaySpatialTemporalDenoiser(device, resolved, layouts, pipelines[0], pipelines[1]), diagnostics);
    } catch (error) {
      const validation = await device.popErrorScope().catch(() => null);
      if (validation) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_GPU_VALIDATION_ERROR', validation.message, {}));
      diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_PIPELINE_CREATION_FAILED', message(error), {}));
      return freezeCreate(null, diagnostics);
    }
  }

  get destroyed(): boolean { return this._destroyed; }
  get liveResourceCount(): number { return this._destroyed ? 0 : (this._history ? 2 : 0) + (this._scratch ? 1 : 0); }
  get scratchBytes(): number { return this._destroyed ? 0 : this._width * this._height * 8 * 3; }

  record(options: RayDenoiseRecordOptions): RayDenoiseRecordResult {
    if (this._destroyed || !this._layouts || !this._temporalPipeline || !this._spatialPipeline) throw new Error('RAY_DENOISE_DESTROYED');
    this.resize(options.width, options.height);
    const params = new ArrayBuffer(RAY_DENOISE_LAYOUT.parameterBytes); const view = new DataView(params);
    [options.width, options.height, options.sampleIndex, options.reset ? 1 : 0].forEach((value, index) => view.setUint32(index * 4, value, true));
    [this._options.temporalFeedback, this._options.phiColor, this._options.phiFeature, this._options.varianceBoost].forEach((value, index) => view.setFloat32(16 + index * 4, value, true));
    const uniform = this._device.createBuffer({ label: 'ray-denoise-params', size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._device.queue.writeBuffer(uniform, 0, params);
    const current = options.sampleIndex & 1; const previous = 1 - current;
    const temporalGroup = this._device.createBindGroup({ label: 'ray-denoise-temporal-group', layout: this._layouts[0], entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: options.accumulation.createView() },
      { binding: 2, resource: options.moments.createView() }, { binding: 3, resource: options.feature.createView() },
      { binding: 4, resource: this._history![previous]!.createView() }, { binding: 5, resource: this._scratch!.createView() },
    ] });
    const spatialGroup = this._device.createBindGroup({ label: 'ray-denoise-spatial-group', layout: this._layouts[1], entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: this._scratch!.createView() },
      { binding: 2, resource: options.moments.createView() }, { binding: 3, resource: options.feature.createView() },
      { binding: 4, resource: this._history![current]!.createView() },
    ] });
    const temporal = options.encoder.beginComputePass(options.querySet ? { label: 'ray-denoise-temporal', timestampWrites: { querySet: options.querySet, beginningOfPassWriteIndex: options.temporalTimestampStart, endOfPassWriteIndex: options.temporalTimestampStart + 1 } } : { label: 'ray-denoise-temporal' });
    temporal.setPipeline(this._temporalPipeline); temporal.setBindGroup(0, temporalGroup); temporal.dispatchWorkgroups(Math.ceil(options.width / 8), Math.ceil(options.height / 8)); temporal.end();
    const spatial = options.encoder.beginComputePass(options.querySet ? { label: 'ray-denoise-spatial', timestampWrites: { querySet: options.querySet, beginningOfPassWriteIndex: options.spatialTimestampStart, endOfPassWriteIndex: options.spatialTimestampStart + 1 } } : { label: 'ray-denoise-spatial' });
    spatial.setPipeline(this._spatialPipeline); spatial.setBindGroup(0, spatialGroup); spatial.dispatchWorkgroups(Math.ceil(options.width / 8), Math.ceil(options.height / 8)); spatial.end();
    return Object.freeze({ output: this._history![current]!, transientBuffers: Object.freeze([uniform]) });
  }

  destroy(): void {
    if (this._destroyed) return; this._destroyed = true;
    this._history?.forEach(texture => texture.destroy()); this._scratch?.destroy();
    this._history = null; this._scratch = null; this._layouts = null; this._temporalPipeline = null; this._spatialPipeline = null; this._width = 0; this._height = 0;
  }

  private resize(width: number, height: number): void {
    if (width === this._width && height === this._height && this._history && this._scratch) return;
    if (width > this._device.limits.maxTextureDimension2D || height > this._device.limits.maxTextureDimension2D) throw new Error('RAY_DENOISE_SIZE_UNSUPPORTED');
    this._history?.forEach(texture => texture.destroy()); this._scratch?.destroy();
    const descriptor: GPUTextureDescriptor = { size: { width, height }, format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING };
    this._history = [this._device.createTexture({ ...descriptor, label: 'ray-denoise-history-0' }), this._device.createTexture({ ...descriptor, label: 'ray-denoise-history-1' })];
    this._scratch = this._device.createTexture({ ...descriptor, label: 'ray-denoise-temporal-scratch' }); this._width = width; this._height = height;
  }
}

function resolveOptions(options: RayDenoiseOptions, diagnostics: RayProgressiveDiagnostic[]): ResolvedOptions | null {
  const values = { temporalFeedback: options.temporalFeedback ?? 0.18, phiColor: options.phiColor ?? 0.08, phiFeature: options.phiFeature ?? 0.12, varianceBoost: options.varianceBoost ?? 2.5 };
  if (!Number.isFinite(values.temporalFeedback) || values.temporalFeedback < 0 || values.temporalFeedback > 0.95) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_FEEDBACK_INVALID', 'temporalFeedback must be in [0, 0.95].', { value: values.temporalFeedback }));
  for (const name of ['phiColor', 'phiFeature', 'varianceBoost'] as const) if (!Number.isFinite(values[name]) || values[name] <= 0) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_PARAMETER_INVALID', `${name} must be finite and positive.`, { parameter: name, value: values[name] }));
  return diagnostics.some(value => value.severity === 'error') ? null : Object.freeze(values);
}
function freezeCreate(denoiser: RaySpatialTemporalDenoiser | null, diagnostics: readonly RayProgressiveDiagnostic[]): RayDenoiseCreateResult { return Object.freeze({ denoiser, diagnostics: Object.freeze([...diagnostics]) }); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
