import { recordComputeResourcePass, type RenderCommandContext } from '@haiyue/engine/experimental';
import type { RaySpatialTemporalDenoiser } from '../denoise/index.js';
import type { RayPathSceneFacts, RayPathTracingRenderer } from '../renderer/index.js';
import { samplingDiagnostic } from './diagnostics.js';
import { createRayProgressiveLayouts, RAY_PROGRESSIVE_LAYOUT } from './layout.js';
import { classifyRayProgressiveReset, createRayProgressiveAccumulationKey } from './revision.js';
import { createRayProgressiveSequenceSample } from './sequence.js';
import { RAY_PROGRESSIVE_SHADER_ARTIFACT } from './shaders/progressive-artifact.generated.js';
import type {
  RayProgressiveAccumulationKey,
  RayProgressiveCreateResult,
  RayProgressiveDiagnostic,
  RayProgressiveFrame,
  RayProgressiveMemory,
  RayProgressiveOptions,
  RayProgressiveRenderResult,
  RayProgressiveResetEvent,
  RayProgressiveResetReason,
  RayProgressiveSequenceSample,
  RayProgressiveStageTiming,
  RayProgressiveStatistics,
  RayProgressiveView,
} from './types.js';

interface ValidatedOptions {
  readonly width: number; readonly height: number; readonly baseSeed: number; readonly maxBounces: number;
  readonly qualityRevision: string; readonly exposure: number; readonly toneMapping: 'linear' | 'reinhard' | 'aces';
  readonly view: RayProgressiveView; readonly readback: boolean;
}

export class RayProgressiveRenderer {
  readonly artifactHash = RAY_PROGRESSIVE_LAYOUT.artifactHash;
  private readonly _device: GPUDevice;
  private _baseRenderer: RayPathTracingRenderer;
  private _denoiser: RaySpatialTemporalDenoiser | null;
  private _layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout] | null;
  private _accumulatePipeline: GPUComputePipeline | null;
  private _presentPipeline: GPUComputePipeline | null;
  private _accumulation: [GPUTexture, GPUTexture] | null = null;
  private _moments: [GPUTexture, GPUTexture] | null = null;
  private _feature: GPUTexture | null = null;
  private _age: GPUTexture | null = null;
  private _output: GPUTexture | null = null;
  private _width = 0; private _height = 0; private _sampleCount = 0; private _resetCount = 0;
  private _key: RayProgressiveAccumulationKey | null = null; private _lastReset: RayProgressiveResetEvent | null = null;
  private readonly _pendingReasons = new Set<RayProgressiveResetReason>();
  private _generation = 0; private _rendering = false; private _destroyed = false; private _lostMessage: string | null = null;
  private readonly _uncapturedErrors: string[] = [];
  private readonly _uncapturedHandler: (event: GPUUncapturedErrorEvent) => void;

  private constructor(device: GPUDevice, baseRenderer: RayPathTracingRenderer, denoiser: RaySpatialTemporalDenoiser | null, layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout], accumulate: GPUComputePipeline, present: GPUComputePipeline) {
    this._device = device; this._baseRenderer = baseRenderer; this._denoiser = denoiser; this._layouts = layouts; this._accumulatePipeline = accumulate; this._presentPipeline = present;
    this._uncapturedHandler = event => this._uncapturedErrors.push(event.error?.message ?? 'Unknown progressive WebGPU error.');
    device.addEventListener('uncapturederror', this._uncapturedHandler);
    void device.lost.then(info => { this._lostMessage = `${info.reason}: ${info.message}`; this._pendingReasons.add('device'); this._generation++; });
  }

  static async create(device: GPUDevice, baseRenderer: RayPathTracingRenderer, denoiser: RaySpatialTemporalDenoiser | null = null): Promise<RayProgressiveCreateResult> {
    const diagnostics: RayProgressiveDiagnostic[] = [];
    if (baseRenderer.destroyed) diagnostics.push(samplingDiagnostic('lifecycle', 'error', 'RAY_PROGRESSIVE_BASE_DESTROYED', 'The G05 path renderer is destroyed.', {}));
    if (denoiser?.destroyed) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_DESTROYED', 'The optional denoiser is destroyed.', {}));
    const limits = device.limits;
    if (limits.maxStorageTexturesPerShaderStage < 4 || limits.maxSampledTexturesPerShaderStage < 3 || limits.maxStorageBuffersPerShaderStage < 1 || limits.maxBindingsPerBindGroup < 9) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_LIMIT_UNSUPPORTED', 'WebGPU limits are below the progressive Artifact V2 requirements.', {}));
    if (diagnostics.some(value => value.severity === 'error')) return freezeCreate(null, diagnostics);
    device.pushErrorScope('validation');
    try {
      const accumulateModule = device.createShaderModule({ label: 'ray-progressive-accumulate-v2', code: RAY_PROGRESSIVE_SHADER_ARTIFACT.passes[RAY_PROGRESSIVE_LAYOUT.accumulatePassId]!.code });
      const presentModule = device.createShaderModule({ label: 'ray-progressive-present-v2', code: RAY_PROGRESSIVE_SHADER_ARTIFACT.passes[RAY_PROGRESSIVE_LAYOUT.presentPassId]!.code });
      const compilation = await Promise.all([accumulateModule.getCompilationInfo(), presentModule.getCompilationInfo()]);
      const errors = compilation.flatMap((info, index) => info.messages.filter(message => message.type === 'error').map(message => `${index === 0 ? 'accumulate' : 'present'}:${message.lineNum}:${message.linePos} ${message.message}`));
      if (errors.length) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_SHADER_COMPILATION_FAILED', errors.join('\n'), { errorCount: errors.length }));
      const layouts = createRayProgressiveLayouts(device);
      const pipelines = await Promise.all([
        device.createComputePipelineAsync({ label: 'ray-progressive-accumulate', layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[0]] }), compute: { module: accumulateModule, entryPoint: 'accumulate_main' } }),
        device.createComputePipelineAsync({ label: 'ray-progressive-present', layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[1]] }), compute: { module: presentModule, entryPoint: 'present_main' } }),
      ]);
      const validation = await device.popErrorScope();
      if (validation) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_GPU_VALIDATION_ERROR', validation.message, {}));
      return diagnostics.some(value => value.severity === 'error') ? freezeCreate(null, diagnostics)
        : freezeCreate(new RayProgressiveRenderer(device, baseRenderer, denoiser, layouts, pipelines[0], pipelines[1]), diagnostics);
    } catch (error) {
      const validation = await device.popErrorScope().catch(() => null);
      if (validation) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_GPU_VALIDATION_ERROR', validation.message, {}));
      diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_PIPELINE_CREATION_FAILED', message(error), {}));
      return freezeCreate(null, diagnostics);
    }
  }

  get destroyed(): boolean { return this._destroyed; }
  get sampleCount(): number { return this._sampleCount; }
  get outputTexture(): GPUTexture | null { return this._destroyed ? null : this._output; }
  get liveResourceCount(): number { return this._destroyed ? 0 : (this._accumulation ? 2 : 0) + (this._moments ? 2 : 0) + (this._feature ? 1 : 0) + (this._age ? 1 : 0) + (this._output ? 1 : 0); }

  reset(reason: RayProgressiveResetReason = 'explicit'): void {
    if (this._destroyed) return; this._pendingReasons.add(reason); this._generation++;
  }
  replaceBaseRenderer(renderer: RayPathTracingRenderer): void {
    if (this._destroyed) throw new Error('RAY_PROGRESSIVE_DESTROYED');
    if (renderer.destroyed) throw new Error('RAY_PROGRESSIVE_BASE_DESTROYED');
    this._baseRenderer = renderer; this._pendingReasons.add('renderer'); this._generation++;
  }
  setDenoiser(denoiser: RaySpatialTemporalDenoiser | null): void {
    if (this._destroyed) throw new Error('RAY_PROGRESSIVE_DESTROYED');
    if (this._denoiser === denoiser) return; this._denoiser = denoiser; this._pendingReasons.add('denoise'); this._generation++;
  }

  async render(frame: RayProgressiveFrame, options: RayProgressiveOptions): Promise<RayProgressiveRenderResult> {
    const diagnostics: RayProgressiveDiagnostic[] = [];
    const validated = validateOptions(this._device, options, this._denoiser, diagnostics);
    const fallbackSequence = createRayProgressiveSequenceSample(0, validSeed(options.baseSeed));
    if (this._destroyed) return failure(options, fallbackSequence, diagnostics.concat(samplingDiagnostic('lifecycle', 'error', 'RAY_PROGRESSIVE_DESTROYED', 'Progressive renderer is destroyed.', {})));
    if (this._lostMessage) return failure(options, fallbackSequence, diagnostics.concat(deviceLost(this._lostMessage)));
    if (this._rendering) return failure(options, fallbackSequence, diagnostics.concat(samplingDiagnostic('lifecycle', 'error', 'RAY_PROGRESSIVE_BUSY', 'Only one progressive sample may be recorded at a time.', {})));
    if (!validated) return failure(options, fallbackSequence, diagnostics);
    const denoiser = this._denoiser;
    if (frame.revision.acceleration !== this._baseRenderer.accelerationFingerprint || frame.revision.material !== this._baseRenderer.materialFingerprint) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_FRAME_STALE', 'Frame revisions do not match the active G05 renderer.', { accelerationMatch: frame.revision.acceleration === this._baseRenderer.accelerationFingerprint, materialMatch: frame.revision.material === this._baseRenderer.materialFingerprint }));
    if (diagnostics.some(value => value.severity === 'error')) return failure(options, fallbackSequence, diagnostics);
    const key = createRayProgressiveAccumulationKey(frame.revision, validated, { revision: validated.qualityRevision, maxBounces: validated.maxBounces }, { baseSeed: validated.baseSeed }, denoiser?.revision ?? 'denoise:off');
    const reasons = classifyRayProgressiveReset(this._key, key, this._pendingReasons);
    const sampleIndex = reasons.length ? 0 : this._sampleCount; const sequence = createRayProgressiveSequenceSample(sampleIndex, validated.baseSeed);
    const generation = this._generation; const baseRenderer = this._baseRenderer; this._rendering = true; this._uncapturedErrors.length = 0;
    const transient: GPUBuffer[] = []; let querySet: GPUQuerySet | null = null; let scope = false;
    try {
      const jitteredFacts = jitterFacts(frame.facts, sequence, validated.width, validated.height);
      const sampled = await baseRenderer.render(jitteredFacts, { width: validated.width, height: validated.height, maxBounces: validated.maxBounces, seed: sequence.pathSeed, exposure: 1, toneMapping: 'linear', readback: false });
      diagnostics.push(...sampled.diagnostics);
      if (sampled.status !== 'ok' || !sampled.outputTexture) return failure(options, sequence, diagnostics);
      if (generation !== this._generation || this._destroyed) return failure(options, sequence, diagnostics.concat(samplingDiagnostic('lifecycle', 'error', 'RAY_PROGRESSIVE_STALE_SAMPLE', 'A late G05 sample was discarded after reset or owner destruction.', {})));
      this.resize(validated.width, validated.height);
      this._device.pushErrorScope('validation'); scope = true;
      const paramsBuffer = uploaded(this._device, 'ray-progressive-params', packParams(validated, sequence, sampleIndex, reasons.length > 0), GPUBufferUsage.UNIFORM);
      const diagnosticBuffer = this._device.createBuffer({ label: 'ray-progressive-diagnostics', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const diagnosticReadback = this._device.createBuffer({ label: 'ray-progressive-diagnostic-readback', size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      transient.push(paramsBuffer, diagnosticBuffer, diagnosticReadback); this._device.queue.writeBuffer(diagnosticBuffer, 0, new Uint32Array(4));
      const bytesPerRow = Math.ceil(validated.width * 4 / 256) * 256; let pixelReadback: GPUBuffer | null = null;
      if (validated.readback) { pixelReadback = this._device.createBuffer({ label: 'ray-progressive-pixel-readback', size: bytesPerRow * validated.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); transient.push(pixelReadback); }
      const timestamp = this._device.features.has('timestamp-query'); const queryCount = denoiser ? 8 : 4;
      let timestampResolve: GPUBuffer | null = null; let timestampReadback: GPUBuffer | null = null;
      if (timestamp) {
        querySet = this._device.createQuerySet({ type: 'timestamp', count: queryCount });
        timestampResolve = this._device.createBuffer({ size: queryCount * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        timestampReadback = this._device.createBuffer({ size: queryCount * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); transient.push(timestampResolve, timestampReadback);
      } else diagnostics.push(samplingDiagnostic('path-tracing', 'info', 'RAY_PROGRESSIVE_TIMESTAMP_UNSUPPORTED', 'timestamp-query is unavailable; progressive rendering continues.', {}));
      const current = sampleIndex & 1; const previous = 1 - current;
      const accumulateGroup = this._device.createBindGroup({ label: 'ray-progressive-accumulate-group', layout: this._layouts![0], entries: [
        { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: sampled.outputTexture.createView() },
        { binding: 2, resource: this._accumulation![previous]!.createView() }, { binding: 3, resource: this._moments![previous]!.createView() },
        { binding: 4, resource: this._accumulation![current]!.createView() }, { binding: 5, resource: this._moments![current]!.createView() },
        { binding: 6, resource: this._feature!.createView() }, { binding: 7, resource: this._age!.createView() }, { binding: 8, resource: { buffer: diagnosticBuffer } },
      ] });
      const encoder = this._device.createCommandEncoder({ label: 'ray-progressive-frame' }); const context: RenderCommandContext = { device: this._device, encoder };
      const accumulateToken = recordComputeResourcePass(context, { label: 'ray.progressive.accumulate', path: 'rayProgressive.accumulate', accesses: [
        { resource: sampled.outputTexture, use: 'render-read', path: 'rayProgressive.sample' }, { resource: this._accumulation![previous]!, use: 'render-read', path: 'rayProgressive.previous' },
        { resource: this._accumulation![current]!, use: 'storage-write', path: 'rayProgressive.current' }, { resource: this._moments![current]!, use: 'storage-write', path: 'rayProgressive.moments' },
        { resource: this._feature!, use: 'storage-write', path: 'rayProgressive.feature' }, { resource: this._age!, use: 'storage-write', path: 'rayProgressive.age' },
      ] });
      const accumulatePass = encoder.beginComputePass(timestamp ? { label: 'ray-progressive-accumulate', timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : { label: 'ray-progressive-accumulate' });
      accumulatePass.setPipeline(this._accumulatePipeline!); accumulatePass.setBindGroup(0, accumulateGroup); accumulatePass.dispatchWorkgroups(Math.ceil(validated.width / 8), Math.ceil(validated.height / 8)); accumulatePass.end();
      let presentSource = this._accumulation![current]!; let priorToken = accumulateToken;
      if (denoiser) {
        const temporalToken = recordComputeResourcePass(context, { label: 'ray.progressive.denoise.temporal', path: 'rayProgressive.denoise.temporal', after: [accumulateToken], accesses: [
          { resource: this._accumulation![current]!, use: 'render-read', path: 'rayProgressive.denoise.accumulation' }, { resource: this._feature!, use: 'render-read', path: 'rayProgressive.denoise.feature' },
        ] });
        const spatialToken = recordComputeResourcePass(context, { label: 'ray.progressive.denoise.spatial', path: 'rayProgressive.denoise.spatial', after: [temporalToken], accesses: [{ resource: this._feature!, use: 'render-read', path: 'rayProgressive.denoise.spatial.feature' }] });
        const denoised = denoiser.record({ encoder, accumulation: this._accumulation![current]!, moments: this._moments![current]!, feature: this._feature!, width: validated.width, height: validated.height, sampleIndex, reset: reasons.length > 0, querySet, temporalTimestampStart: 2, spatialTimestampStart: 4 });
        transient.push(...denoised.transientBuffers); if (validated.view === 'denoised') presentSource = denoised.output; priorToken = spatialToken;
      }
      const presentToken = recordComputeResourcePass(context, { label: 'ray.progressive.present', path: 'rayProgressive.present', after: [priorToken], accesses: [
        { resource: presentSource, use: 'render-read', path: 'rayProgressive.present.source' }, { resource: this._output!, use: 'storage-write', path: 'rayProgressive.present.output' },
      ] });
      const presentGroup = this._device.createBindGroup({ label: 'ray-progressive-present-group', layout: this._layouts![1], entries: [
        { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: presentSource.createView() }, { binding: 2, resource: this._moments![current]!.createView() },
        { binding: 3, resource: this._feature!.createView() }, { binding: 4, resource: this._age!.createView() }, { binding: 5, resource: this._output!.createView() },
      ] });
      const presentStart = denoiser ? 6 : 2;
      const presentPass = encoder.beginComputePass(timestamp ? { label: 'ray-progressive-present', timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: presentStart, endOfPassWriteIndex: presentStart + 1 } } : { label: 'ray-progressive-present' });
      presentPass.setPipeline(this._presentPipeline!); presentPass.setBindGroup(0, presentGroup); presentPass.dispatchWorkgroups(Math.ceil(validated.width / 8), Math.ceil(validated.height / 8)); presentPass.end();
      recordComputeResourcePass(context, { label: 'ray.progressive.consumer', path: 'rayProgressive.consumer', after: [presentToken], accesses: [{ resource: this._output!, use: 'copy-read', path: 'rayProgressive.output' }] });
      encoder.copyBufferToBuffer(diagnosticBuffer, 0, diagnosticReadback, 0, 16);
      if (pixelReadback) encoder.copyTextureToBuffer({ texture: this._output! }, { buffer: pixelReadback, bytesPerRow, rowsPerImage: validated.height }, { width: validated.width, height: validated.height });
      if (timestamp) { encoder.resolveQuerySet(querySet!, 0, queryCount, timestampResolve!, 0); encoder.copyBufferToBuffer(timestampResolve!, 0, timestampReadback!, 0, queryCount * 8); }
      this._device.queue.submit([encoder.finish()]);
      await Promise.all([diagnosticReadback.mapAsync(GPUMapMode.READ), pixelReadback?.mapAsync(GPUMapMode.READ), timestampReadback?.mapAsync(GPUMapMode.READ)]);
      if (generation !== this._generation || this._destroyed) throw new Error(this._lostMessage ? `device-lost:${this._lostMessage}` : 'stale-generation');
      const counters = new Uint32Array(diagnosticReadback.getMappedRange()).slice(); diagnosticReadback.unmap();
      if (counters[3] !== validated.width * validated.height) diagnostics.push(samplingDiagnostic('readback', 'error', 'RAY_PROGRESSIVE_READBACK_INVALID', 'Accumulation diagnostics did not cover every pixel.', { expected: validated.width * validated.height, actual: counters[3] ?? 0 }));
      let pixels: Uint8Array | null = null; if (pixelReadback) { pixels = unpackRows(new Uint8Array(pixelReadback.getMappedRange()), validated.width, validated.height, bytesPerRow); pixelReadback.unmap(); }
      const wrapperTiming = timestampReadback ? readTiming(timestampReadback, denoiser !== null) : null; timestampReadback?.unmap();
      const validation = await this._device.popErrorScope(); scope = false;
      if (validation) diagnostics.push(samplingDiagnostic('path-tracing', 'error', 'RAY_PROGRESSIVE_GPU_VALIDATION_ERROR', validation.message, {}));
      for (const error of this._uncapturedErrors) diagnostics.push(samplingDiagnostic('path-tracing', 'error', 'RAY_PROGRESSIVE_GPU_UNCAPTURED_ERROR', error, {}));
      if (diagnostics.some(value => value.severity === 'error')) return failure(options, sequence, diagnostics);
      const revision = keyRevision(key); let resetEvent = this._lastReset;
      if (reasons.length) { resetEvent = Object.freeze({ resetIndex: this._resetCount + 1, reasons: Object.freeze(reasons), previousSampleCount: this._sampleCount, revision }); this._resetCount++; this._lastReset = resetEvent; }
      this._key = key; this._sampleCount = sampleIndex + 1; this._pendingReasons.clear();
      const statistics = freezeStatistics(sampleIndex, this._sampleCount, this._resetCount, resetEvent, counters, sequence);
      const timing: RayProgressiveStageTiming = Object.freeze({ samplingNs: sampled.gpuTimeNs, accumulationNs: wrapperTiming?.accumulationNs ?? null, denoiseTemporalNs: wrapperTiming?.denoiseTemporalNs ?? null, denoiseSpatialNs: wrapperTiming?.denoiseSpatialNs ?? null, presentNs: wrapperTiming?.presentNs ?? null, kind: timestamp ? 'timestamp-query' : 'unavailable' });
      const memory = this.memory(validated, denoiser, timestamp ? queryCount : 0);
      return Object.freeze({ status: 'ok', width: validated.width, height: validated.height, revision, view: validated.view, outputTexture: this._output, pixels, statistics, timing, memory, diagnostics: Object.freeze([...diagnostics]) });
    } catch (error) {
      if (scope) await this._device.popErrorScope().catch(() => null);
      const value = message(error); diagnostics.push(value.startsWith('device-lost:') || this._lostMessage ? deviceLost(this._lostMessage ?? value)
        : samplingDiagnostic('lifecycle', 'error', value === 'stale-generation' ? 'RAY_PROGRESSIVE_STALE_SAMPLE' : value.startsWith('RAY_DENOISE_') ? value : 'RAY_PROGRESSIVE_RENDER_FAILED', value, {}));
      return failure(options, sequence, diagnostics);
    } finally { querySet?.destroy(); for (const buffer of transient) buffer.destroy(); this._rendering = false; }
  }

  destroy(): void {
    if (this._destroyed) return; this._destroyed = true; this._generation++; this._device.removeEventListener('uncapturederror', this._uncapturedHandler);
    this.destroyTextures(); this._layouts = null; this._accumulatePipeline = null; this._presentPipeline = null; this._denoiser = null;
  }

  private resize(width: number, height: number): void {
    if (this._width === width && this._height === height && this._accumulation && this._moments && this._feature && this._age && this._output) return;
    this.destroyTextures();
    const floatUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING;
    const create = (label: string, format: GPUTextureFormat, usage = floatUsage) => this._device.createTexture({ label, size: { width, height }, format, usage });
    this._accumulation = [create('ray-progressive-accumulation-0', 'rgba16float'), create('ray-progressive-accumulation-1', 'rgba16float')];
    this._moments = [create('ray-progressive-moments-0', 'rgba16float'), create('ray-progressive-moments-1', 'rgba16float')];
    this._feature = create('ray-progressive-feature', 'rgba16float'); this._age = create('ray-progressive-age', 'r32uint');
    this._output = create('ray-progressive-output', 'rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC);
    this._width = width; this._height = height;
  }
  private destroyTextures(): void {
    this._accumulation?.forEach(texture => texture.destroy()); this._moments?.forEach(texture => texture.destroy()); this._feature?.destroy(); this._age?.destroy(); this._output?.destroy();
    this._accumulation = null; this._moments = null; this._feature = null; this._age = null; this._output = null; this._width = 0; this._height = 0;
  }
  private memory(options: ValidatedOptions, denoiser: RaySpatialTemporalDenoiser | null, queryCount: number): RayProgressiveMemory {
    const pixels = options.width * options.height; const historyBytes = pixels * 48; const denoiseScratchBytes = denoiser?.scratchBytes ?? 0;
    const readbackBytes = 32 + (options.readback ? Math.ceil(options.width * 4 / 256) * 256 * options.height : 0) + queryCount * 16;
    return Object.freeze({ historyBytes, denoiseScratchBytes, readbackBytes, peakBytes: historyBytes + denoiseScratchBytes + readbackBytes + 64, liveResourceCount: this.liveResourceCount + (denoiser?.liveResourceCount ?? 0) });
  }
}

function validateOptions(device: GPUDevice, options: RayProgressiveOptions, denoiser: RaySpatialTemporalDenoiser | null, diagnostics: RayProgressiveDiagnostic[]): ValidatedOptions | null {
  const baseSeed = options.baseSeed ?? 1; const maxBounces = options.maxBounces ?? 3; const qualityRevision = options.qualityRevision ?? 'quality:default';
  const exposure = options.exposure ?? 1; const toneMapping = options.toneMapping ?? 'aces'; const view = options.view ?? (denoiser ? 'denoised' : 'raw');
  if (!Number.isInteger(options.width) || options.width < 1 || !Number.isInteger(options.height) || options.height < 1) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_SIZE_INVALID', 'Progressive dimensions must be positive integers.', {}));
  if (options.width > device.limits.maxTextureDimension2D || options.height > device.limits.maxTextureDimension2D) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_SIZE_UNSUPPORTED', 'Progressive dimensions exceed maxTextureDimension2D.', {}));
  if (!Number.isInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffff_ffff) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_SEED_INVALID', 'baseSeed must be a uint32.', { baseSeed }));
  if (!Number.isInteger(maxBounces) || maxBounces < 1 || maxBounces > 8) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_QUALITY_INVALID', 'maxBounces must be in [1, 8].', { maxBounces }));
  if (!qualityRevision || qualityRevision.length > 256) diagnostics.push(samplingDiagnostic('upload', 'error', 'RAY_PROGRESSIVE_QUALITY_REVISION_INVALID', 'qualityRevision must be a non-empty bounded string.', {}));
  if (!Number.isFinite(exposure) || exposure < 0) diagnostics.push(samplingDiagnostic('tone-mapping', 'error', 'RAY_PROGRESSIVE_EXPOSURE_INVALID', 'exposure must be finite and non-negative.', { exposure }));
  if (!['linear', 'reinhard', 'aces'].includes(toneMapping)) diagnostics.push(samplingDiagnostic('tone-mapping', 'error', 'RAY_PROGRESSIVE_TONE_MAPPING_UNSUPPORTED', 'Unknown tone mapping operator.', { toneMapping }));
  if (!['raw', 'denoised', 'variance', 'history-age', 'feature'].includes(view)) diagnostics.push(samplingDiagnostic('tone-mapping', 'error', 'RAY_PROGRESSIVE_VIEW_UNSUPPORTED', 'Unknown progressive output view.', { view }));
  if (view === 'denoised' && !denoiser) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_REQUIRED', 'The denoised view requires an attached denoiser module.', {}));
  if (denoiser?.destroyed) diagnostics.push(samplingDiagnostic('denoise', 'error', 'RAY_DENOISE_DESTROYED', 'The attached denoiser is destroyed.', {}));
  return diagnostics.some(value => value.severity === 'error') ? null : { width: options.width, height: options.height, baseSeed, maxBounces, qualityRevision, exposure, toneMapping, view, readback: options.readback ?? false };
}
function jitterFacts(facts: RayPathSceneFacts, sequence: RayProgressiveSequenceSample, width: number, height: number): RayPathSceneFacts {
  const camera = facts.camera; const dx = (sequence.jitter[0] - 0.5) * 2; const dy = (sequence.jitter[1] - 0.5) * 2;
  let origin = camera.origin; let forward = camera.forward;
  if (camera.projection === 'orthographic') origin = vectorAdd(origin, vectorAdd(vectorScale(camera.right, dx * camera.orthographicHeight * width / height * 0.5 / width), vectorScale(camera.up, -dy * camera.orthographicHeight * 0.5 / height)));
  else { const tangent = Math.tan(camera.verticalFov / 2); forward = normalize(vectorAdd(forward, vectorAdd(vectorScale(camera.right, dx * tangent * width / height / width), vectorScale(camera.up, -dy * tangent / height)))); }
  const jitteredCamera = Object.freeze({ ...camera, origin, forward, revision: `${camera.revision}:sample:${sequence.sampleIndex}:${sequence.pathSeed}` });
  return Object.freeze({ ...facts, camera: jitteredCamera, revision: `${facts.revision}:sample:${sequence.sampleIndex}:${sequence.pathSeed}` });
}
function packParams(options: ValidatedOptions, sequence: RayProgressiveSequenceSample, sampleIndex: number, reset: boolean): ArrayBuffer {
  const data = new ArrayBuffer(64); const view = new DataView(data); const viewId = { raw: 0, denoised: 1, variance: 2, 'history-age': 3, feature: 4 }[options.view]; const tone = options.toneMapping === 'linear' ? 0 : options.toneMapping === 'reinhard' ? 1 : 2;
  [options.width, options.height, sampleIndex, viewId].forEach((value, index) => view.setUint32(index * 4, value, true));
  [sequence.baseSeed, sequence.pathSeed, reset ? 1 : 0, tone].forEach((value, index) => view.setUint32(16 + index * 4, value, true));
  [options.exposure, sequence.jitter[0], sequence.jitter[1], 0].forEach((value, index) => view.setFloat32(32 + index * 4, value, true));
  [32, 256, 8, 0].forEach((value, index) => view.setFloat32(48 + index * 4, value, true)); return data;
}
function readTiming(buffer: GPUBuffer, denoise: boolean): { accumulationNs: number; denoiseTemporalNs: number | null; denoiseSpatialNs: number | null; presentNs: number } {
  const values = new BigUint64Array(buffer.getMappedRange()); const delta = (start: number) => Number(values[start + 1]! - values[start]!);
  return denoise ? { accumulationNs: delta(0), denoiseTemporalNs: delta(2), denoiseSpatialNs: delta(4), presentNs: delta(6) } : { accumulationNs: delta(0), denoiseTemporalNs: null, denoiseSpatialNs: null, presentNs: delta(2) };
}
function freezeStatistics(sampleIndex: number, sampleCount: number, resetCount: number, lastReset: RayProgressiveResetEvent | null, counters: Uint32Array, sequence: RayProgressiveSequenceSample): RayProgressiveStatistics {
  const count = counters[0] ?? 0; return Object.freeze({ sampleIndex, sampleCount, historyAge: sampleCount, resetCount, lastReset, varianceMean: count ? (counters[1] ?? 0) / count / 65535 : 0, varianceMax: (counters[2] ?? 0) / 65535, varianceSampleCount: count, sequence });
}
function keyRevision(key: RayProgressiveAccumulationKey): string { return `${key.sceneOwner}:${key.acceleration}:${key.geometry}:${key.membership}:${key.transform}:${key.material}:${key.camera}:${key.light}:${key.viewport}:${key.quality}:${key.sampling}:${key.denoise}`; }
function uploaded(device: GPUDevice, label: string, data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer { const buffer = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer; }
function unpackRows(source: Uint8Array, width: number, height: number, bytesPerRow: number): Uint8Array { const result = new Uint8Array(width * height * 4); for (let row = 0; row < height; row++) result.set(source.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4); return result; }
function failure(options: RayProgressiveOptions, sequence: RayProgressiveSequenceSample, diagnostics: readonly RayProgressiveDiagnostic[]): RayProgressiveRenderResult {
  const view = options.view ?? 'raw'; const statistics = freezeStatistics(0, 0, 0, null, new Uint32Array(4), sequence); const timing: RayProgressiveStageTiming = Object.freeze({ samplingNs: null, accumulationNs: null, denoiseTemporalNs: null, denoiseSpatialNs: null, presentNs: null, kind: 'unavailable' }); const memory: RayProgressiveMemory = Object.freeze({ historyBytes: 0, denoiseScratchBytes: 0, readbackBytes: 0, peakBytes: 0, liveResourceCount: 0 });
  return Object.freeze({ status: 'failed', width: options.width, height: options.height, revision: '', view, outputTexture: null, pixels: null, statistics, timing, memory, diagnostics: Object.freeze([...diagnostics]) });
}
function freezeCreate(renderer: RayProgressiveRenderer | null, diagnostics: readonly RayProgressiveDiagnostic[]): RayProgressiveCreateResult { return Object.freeze({ renderer, diagnostics: Object.freeze([...diagnostics]) }); }
function deviceLost(value: string): RayProgressiveDiagnostic { return samplingDiagnostic('lifecycle', 'error', 'RAY_PROGRESSIVE_DEVICE_LOST', 'WebGPU device was lost; progressive history was not reused.', { message: value }); }
function validSeed(value: number | undefined): number { return Number.isInteger(value) && value! >= 0 && value! <= 0xffff_ffff ? value! : 1; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function vectorScale(value: readonly [number, number, number], scale: number): readonly [number, number, number] { return Object.freeze([value[0] * scale, value[1] * scale, value[2] * scale]); }
function vectorAdd(a: readonly [number, number, number], b: readonly [number, number, number]): readonly [number, number, number] { return Object.freeze([a[0] + b[0], a[1] + b[1], a[2] + b[2]]); }
function normalize(value: readonly [number, number, number]): readonly [number, number, number] { const length = Math.hypot(...value); return Object.freeze([value[0] / length, value[1] / length, value[2] / length]); }
