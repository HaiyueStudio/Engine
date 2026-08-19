import { recordComputeResourcePass, type RenderCommandContext } from '@haiyue/engine/experimental';
import { RAY_ACCELERATION_ABI_FINGERPRINT, validatePackedAcceleration } from '../acceleration/index.js';
import type { RayPackedAcceleration, RayPackedBufferName } from '../acceleration/index.js';
import type { RayPackedMaterialScene } from '../material/index.js';
import { pathDiagnostic } from './diagnostics.js';
import { createRayPathBindGroupLayouts, RAY_PATH_LAYOUT } from './layout.js';
import { createRayPathRenderPlan } from './plan.js';
import { RAY_PATH_TRACING_SHADER_ARTIFACT } from './shaders/path-tracing-artifact.generated.js';
import type {
  RayPathCounters,
  RayPathDiagnostic,
  RayPathMemory,
  RayPathRendererCreateResult,
  RayPathRenderOptions,
  RayPathRenderResult,
  RayPathSceneFacts,
  RayToneMapping,
} from './types.js';

const ACCELERATION_BUFFERS = Object.freeze(['blasNodes', 'blasTable', 'tlasNodes', 'primitives', 'instances'] as const satisfies readonly RayPackedBufferName[]);
const ZERO_COUNTERS: RayPathCounters = Object.freeze({ pixels: 0, rays: 0, bounces: 0, hits: 0, misses: 0, shadowRays: 0, emissiveHits: 0, stackOverflows: 0, invalidAccesses: 0 });
interface OwnedBuffer { readonly buffer: GPUBuffer; readonly allocatedBytes: number }

export class RayPathTracingRenderer {
  readonly artifactHash = RAY_PATH_LAYOUT.artifactHash;
  readonly accelerationFingerprint: string;
  readonly materialFingerprint: string;

  private readonly _device: GPUDevice;
  private readonly _acceleration: RayPackedAcceleration;
  private readonly _materials: RayPackedMaterialScene;
  private readonly _buffers: ReadonlyMap<string, OwnedBuffer>;
  private _layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout] | null;
  private _tracePipeline: GPUComputePipeline | null;
  private _tonePipeline: GPUComputePipeline | null;
  private _materialTexture: GPUTexture | null;
  private _defaultEnvironment: GPUTexture | null;
  private _materialSampler: GPUSampler | null;
  private _environmentSampler: GPUSampler | null;
  private _hdrTexture: GPUTexture | null = null;
  private _outputTexture: GPUTexture | null = null;
  private _width = 0;
  private _height = 0;
  private _destroyed = false;
  private _rendering = false;
  private _generation = 0;
  private _lostMessage: string | null = null;
  private readonly _uncapturedErrors: string[] = [];
  private readonly _uncapturedHandler: (event: GPUUncapturedErrorEvent) => void;

  private constructor(
    device: GPUDevice,
    acceleration: RayPackedAcceleration,
    materials: RayPackedMaterialScene,
    buffers: ReadonlyMap<string, OwnedBuffer>,
    layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout],
    tracePipeline: GPUComputePipeline,
    tonePipeline: GPUComputePipeline,
    materialTexture: GPUTexture,
    defaultEnvironment: GPUTexture,
    materialSampler: GPUSampler,
    environmentSampler: GPUSampler,
  ) {
    this._device = device; this._acceleration = acceleration; this._materials = materials; this._buffers = buffers;
    this._layouts = layouts; this._tracePipeline = tracePipeline; this._tonePipeline = tonePipeline;
    this._materialTexture = materialTexture; this._defaultEnvironment = defaultEnvironment;
    this._materialSampler = materialSampler; this._environmentSampler = environmentSampler;
    this.accelerationFingerprint = acceleration.fingerprint; this.materialFingerprint = materials.fingerprint;
    this._uncapturedHandler = event => this._uncapturedErrors.push(event.error?.message ?? 'Unknown uncaptured WebGPU error.');
    device.addEventListener('uncapturederror', this._uncapturedHandler);
    void device.lost.then(info => { this._lostMessage = `${info.reason}: ${info.message}`; this._generation++; });
  }

  static async create(
    device: GPUDevice,
    acceleration: RayPackedAcceleration,
    materials: RayPackedMaterialScene,
  ): Promise<RayPathRendererCreateResult> {
    const diagnostics: RayPathDiagnostic[] = [];
    if (acceleration.abiFingerprint !== RAY_ACCELERATION_ABI_FINGERPRINT) diagnostics.push(pathDiagnostic('upload', 'error',
      'RAY_PATH_ACCELERATION_ABI_UNSUPPORTED', 'Acceleration ABI does not match the path shader.',
      { expected: RAY_ACCELERATION_ABI_FINGERPRINT, actual: acceleration.abiFingerprint }));
    if (materials.accelerationFingerprint !== acceleration.fingerprint) diagnostics.push(pathDiagnostic('upload', 'error',
      'RAY_PATH_MATERIAL_ACCELERATION_STALE', 'Packed materials were derived from a different acceleration revision.',
      { expected: acceleration.fingerprint, actual: materials.accelerationFingerprint }));
    if (materials.materials.stride !== RAY_PATH_LAYOUT.materialStride || materials.surfaces.stride !== RAY_PATH_LAYOUT.surfaceStride) diagnostics.push(pathDiagnostic('upload', 'error',
      'RAY_PATH_MATERIAL_ABI_UNSUPPORTED', 'Packed material or surface stride does not match Artifact V2.', {}));
    for (const entry of validatePackedAcceleration(acceleration)) diagnostics.push(pathDiagnostic('upload', 'error',
      'RAY_PATH_ACCELERATION_INVALID', entry.message, { accelerationCode: entry.code }));
    validateLimits(device, acceleration, materials, diagnostics);
    if (diagnostics.some(entry => entry.severity === 'error')) return freezeCreate(null, diagnostics);
    const owned = new Map<string, OwnedBuffer>();
    let materialTexture: GPUTexture | null = null; let defaultEnvironment: GPUTexture | null = null;
    device.pushErrorScope('validation');
    try {
      const traceModule = device.createShaderModule({ label: 'ray-path-tracing-artifact-v2', code: RAY_PATH_TRACING_SHADER_ARTIFACT.passes[RAY_PATH_LAYOUT.tracePassId]!.code });
      const toneModule = device.createShaderModule({ label: 'ray-tone-mapping-artifact-v2', code: RAY_PATH_TRACING_SHADER_ARTIFACT.passes[RAY_PATH_LAYOUT.tonePassId]!.code });
      const compilations = await Promise.all([traceModule.getCompilationInfo(), toneModule.getCompilationInfo()]);
      const errors = compilations.flatMap((compilation, index) => compilation.messages
        .filter(message => message.type === 'error')
        .map(message => ({ ...message, module: index === 0 ? 'trace' : 'tone' })));
      if (errors.length > 0) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_SHADER_COMPILATION_FAILED',
        errors.map(message => `${message.module}:${message.lineNum}:${message.linePos} ${message.message}`).join('\n'), { errorCount: errors.length }));
      const layouts = createRayPathBindGroupLayouts(device);
      const tracePipelineLayout = device.createPipelineLayout({ label: 'ray-path-trace-pipeline-layout', bindGroupLayouts: [layouts[0]] });
      const tonePipelineLayout = device.createPipelineLayout({ label: 'ray-path-tone-pipeline-layout', bindGroupLayouts: [layouts[1]] });
      const [tracePipeline, tonePipeline] = await Promise.all([
        device.createComputePipelineAsync({ label: 'ray-path-trace', layout: tracePipelineLayout, compute: { module: traceModule, entryPoint: 'path_main' } }),
        device.createComputePipelineAsync({ label: 'ray-path-tone', layout: tonePipelineLayout, compute: { module: toneModule, entryPoint: 'tone_main' } }),
      ]);
      for (const name of ACCELERATION_BUFFERS) owned.set(name, createStaticBuffer(device, `ray-path-${name}`, acceleration.buffers[name].data, acceleration.buffers[name].stride));
      owned.set('materials', createStaticBuffer(device, 'ray-path-materials', materials.materials.data, materials.materials.stride));
      owned.set('surfaces', createStaticBuffer(device, 'ray-path-surfaces', materials.surfaces.data, materials.surfaces.stride));
      materialTexture = device.createTexture({ label: 'ray-path-material-atlas',
        size: { width: materials.textures.width, height: materials.textures.height, depthOrArrayLayers: materials.textures.layerCount },
        format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: materialTexture }, materials.textures.data.slice(),
        { offset: 0, bytesPerRow: materials.textures.bytesPerRow, rowsPerImage: materials.textures.height },
        { width: materials.textures.width, height: materials.textures.height, depthOrArrayLayers: materials.textures.layerCount });
      defaultEnvironment = createDefaultEnvironment(device);
      const materialSampler = device.createSampler({ label: 'ray-path-material-sampler', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
      const environmentSampler = device.createSampler({ label: 'ray-path-environment-sampler', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
      const validationError = await device.popErrorScope();
      if (validationError) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_GPU_VALIDATION_ERROR', validationError.message, {}));
      if (diagnostics.some(entry => entry.severity === 'error')) {
        for (const value of owned.values()) value.buffer.destroy(); materialTexture.destroy(); defaultEnvironment.destroy();
        return freezeCreate(null, diagnostics);
      }
      return freezeCreate(new RayPathTracingRenderer(device, acceleration, materials, owned, layouts, tracePipeline, tonePipeline,
        materialTexture, defaultEnvironment, materialSampler, environmentSampler), diagnostics);
    } catch (error) {
      const validationError = await device.popErrorScope().catch(() => null);
      if (validationError) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_GPU_VALIDATION_ERROR', validationError.message, {}));
      diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_PIPELINE_CREATION_FAILED', errorMessage(error), {}));
      for (const value of owned.values()) value.buffer.destroy(); materialTexture?.destroy(); defaultEnvironment?.destroy();
      return freezeCreate(null, diagnostics);
    }
  }

  get destroyed(): boolean { return this._destroyed; }
  get outputTexture(): GPUTexture | null { return this._destroyed ? null : this._outputTexture; }
  get liveResourceCount(): number { return this._destroyed ? 0 : this._buffers.size + 2 + (this._hdrTexture ? 1 : 0) + (this._outputTexture ? 1 : 0); }

  async render(facts: RayPathSceneFacts, options: RayPathRenderOptions): Promise<RayPathRenderResult> {
    const diagnostics: RayPathDiagnostic[] = [];
    if (this._destroyed) return failure(options, this.liveResourceCount, diagnostics.concat(pathDiagnostic('lifecycle', 'error', 'RAY_PATH_RENDERER_DESTROYED', 'Path renderer is destroyed.', {})));
    if (this._lostMessage) return failure(options, this.liveResourceCount, diagnostics.concat(deviceLost(this._lostMessage)));
    if (this._rendering) return failure(options, this.liveResourceCount, diagnostics.concat(pathDiagnostic('lifecycle', 'error', 'RAY_PATH_RENDER_BUSY', 'Only one owned path readback may be active.', {})));
    const validated = validateRenderOptions(this._device, options, diagnostics);
    if (!validated) return failure(options, this.liveResourceCount, diagnostics);
    if (facts.lights.length > RAY_PATH_LAYOUT.maxLights) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_LIGHT_LIMIT_UNSUPPORTED', 'Scene facts exceed the light uniform capacity.', { required: facts.lights.length, limit: RAY_PATH_LAYOUT.maxLights }));
    if (diagnostics.some(entry => entry.severity === 'error')) return failure(options, this.liveResourceCount, diagnostics);
    this.resize(validated.width, validated.height);
    const generation = this._generation; this._rendering = true; this._uncapturedErrors.length = 0;
    const transient: GPUBuffer[] = []; let querySet: GPUQuerySet | null = null;
    this._device.pushErrorScope('validation');
    try {
      const paramsData = packParams(facts, validated, this._acceleration);
      const lightsData = packLights(facts);
      const paramsBuffer = createUploaded(this._device, 'ray-path-params', paramsData, GPUBufferUsage.UNIFORM);
      const lightsBuffer = createUploaded(this._device, 'ray-path-lights', lightsData, GPUBufferUsage.UNIFORM);
      const diagnosticBuffer = this._device.createBuffer({ label: 'ray-path-diagnostics', size: RAY_PATH_LAYOUT.diagnosticBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const diagnosticReadback = this._device.createBuffer({ label: 'ray-path-diagnostic-readback', size: RAY_PATH_LAYOUT.diagnosticBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      transient.push(paramsBuffer, lightsBuffer, diagnosticBuffer, diagnosticReadback);
      this._device.queue.writeBuffer(diagnosticBuffer, 0, new Uint32Array(RAY_PATH_LAYOUT.diagnosticBytes / 4));
      const bytesPerRow = Math.ceil(validated.width * 4 / 256) * 256;
      let pixelReadback: GPUBuffer | null = null;
      if (validated.readback) {
        pixelReadback = this._device.createBuffer({ label: 'ray-path-pixel-readback', size: bytesPerRow * validated.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        transient.push(pixelReadback);
      }
      const timestamp = this._device.features.has('timestamp-query');
      let timestampResolve: GPUBuffer | null = null; let timestampReadback: GPUBuffer | null = null;
      if (timestamp) {
        querySet = this._device.createQuerySet({ type: 'timestamp', count: 4 });
        timestampResolve = this._device.createBuffer({ size: 32, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        timestampReadback = this._device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        transient.push(timestampResolve, timestampReadback);
      } else diagnostics.push(pathDiagnostic('path-tracing', 'info', 'RAY_PATH_TIMESTAMP_UNSUPPORTED', 'timestamp-query is unavailable; rendering continues.', {}));
      const environment = facts.environment.texture ?? this._defaultEnvironment!;
      const traceGroup = this._device.createBindGroup({ label: 'ray-path-trace-group', layout: this._layouts![0], entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        ...ACCELERATION_BUFFERS.map((name, index) => ({ binding: index + 1, resource: { buffer: this._buffers.get(name)!.buffer } })),
        { binding: 6, resource: { buffer: this._buffers.get('materials')!.buffer } }, { binding: 7, resource: { buffer: this._buffers.get('surfaces')!.buffer } },
        { binding: 8, resource: { buffer: lightsBuffer } }, { binding: 9, resource: { buffer: diagnosticBuffer } },
        { binding: 10, resource: this._materialTexture!.createView({ dimension: '2d-array' }) }, { binding: 11, resource: this._materialSampler! },
        { binding: 12, resource: environment.createView({ dimension: 'cube' }) }, { binding: 13, resource: this._environmentSampler! },
        { binding: 14, resource: this._hdrTexture!.createView() },
      ] });
      const toneGroup = this._device.createBindGroup({ label: 'ray-path-tone-group', layout: this._layouts![1], entries: [
        { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: this._hdrTexture!.createView() }, { binding: 2, resource: this._outputTexture!.createView() },
      ] });
      const encoder = this._device.createCommandEncoder({ label: 'ray-path-render-plan' });
      const context: RenderCommandContext = { device: this._device, encoder };
      const staticBuffers = [...this._buffers.values()].map(value => value.buffer);
      const upload = recordComputeResourcePass(context, { label: 'ray.path.upload', path: 'rayPath.upload', accesses: [
        ...staticBuffers.map((resource, index) => ({ resource, use: 'copy-write' as const, path: `rayPath.static[${index}]` })),
        { resource: paramsBuffer, use: 'copy-write', path: 'rayPath.params' }, { resource: lightsBuffer, use: 'copy-write', path: 'rayPath.lights' },
      ] });
      const traceToken = recordComputeResourcePass(context, { label: 'ray.path.trace', path: 'rayPath.trace', after: [upload], accesses: [
        ...staticBuffers.map((resource, index) => ({ resource, use: 'storage-read' as const, path: `rayPath.trace.static[${index}]` })),
        { resource: diagnosticBuffer, use: 'storage-read-write', path: 'rayPath.trace.diagnostics' }, { resource: this._hdrTexture!, use: 'storage-write', path: 'rayPath.trace.hdr' },
      ] });
      const tracePass = encoder.beginComputePass(timestamp ? { label: 'ray-path-trace', timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : { label: 'ray-path-trace' });
      tracePass.setPipeline(this._tracePipeline!); tracePass.setBindGroup(0, traceGroup);
      tracePass.dispatchWorkgroups(Math.ceil(validated.width / RAY_PATH_LAYOUT.workgroupSizeX), Math.ceil(validated.height / RAY_PATH_LAYOUT.workgroupSizeY)); tracePass.end();
      const toneToken = recordComputeResourcePass(context, { label: 'ray.path.tone-map', path: 'rayPath.toneMap', after: [traceToken], accesses: [
        { resource: this._hdrTexture!, use: 'render-read', path: 'rayPath.toneMap.hdr' }, { resource: this._outputTexture!, use: 'storage-write', path: 'rayPath.toneMap.output' },
      ] });
      const tonePass = encoder.beginComputePass(timestamp ? { label: 'ray-path-tone', timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 } } : { label: 'ray-path-tone' });
      tonePass.setPipeline(this._tonePipeline!); tonePass.setBindGroup(0, toneGroup);
      tonePass.dispatchWorkgroups(Math.ceil(validated.width / RAY_PATH_LAYOUT.workgroupSizeX), Math.ceil(validated.height / RAY_PATH_LAYOUT.workgroupSizeY)); tonePass.end();
      recordComputeResourcePass(context, { label: 'ray.path.consumer', path: 'rayPath.consumer', after: [toneToken, traceToken], accesses: [
        { resource: this._outputTexture!, use: 'copy-read', path: 'rayPath.consumer.output' }, { resource: diagnosticBuffer, use: 'copy-read', path: 'rayPath.consumer.diagnostics' },
      ] });
      encoder.copyBufferToBuffer(diagnosticBuffer, 0, diagnosticReadback, 0, RAY_PATH_LAYOUT.diagnosticBytes);
      if (pixelReadback) encoder.copyTextureToBuffer({ texture: this._outputTexture! }, { buffer: pixelReadback, bytesPerRow, rowsPerImage: validated.height }, { width: validated.width, height: validated.height });
      if (timestamp) { encoder.resolveQuerySet(querySet!, 0, 4, timestampResolve!, 0); encoder.copyBufferToBuffer(timestampResolve!, 0, timestampReadback!, 0, 32); }
      this._device.queue.submit([encoder.finish()]);
      await Promise.all([diagnosticReadback.mapAsync(GPUMapMode.READ), pixelReadback?.mapAsync(GPUMapMode.READ), timestampReadback?.mapAsync(GPUMapMode.READ)]);
      if (generation !== this._generation || this._destroyed) throw new Error(this._lostMessage ? `device-lost:${this._lostMessage}` : 'stale-generation');
      const counterCopy = new Uint32Array(diagnosticReadback.getMappedRange()).slice(); diagnosticReadback.unmap();
      const counters = countersFrom(counterCopy); validateCounters(counters, validated.width * validated.height, diagnostics);
      let pixels: Uint8Array | null = null;
      if (pixelReadback) { pixels = unpackRows(new Uint8Array(pixelReadback.getMappedRange()), validated.width, validated.height, bytesPerRow); pixelReadback.unmap(); }
      let gpuTimeNs: number | null = null;
      if (timestampReadback) { const values = new BigUint64Array(timestampReadback.getMappedRange()); gpuTimeNs = Number(values[1]! - values[0]! + values[3]! - values[2]!); timestampReadback.unmap(); }
      const validationError = await this._device.popErrorScope();
      if (validationError) diagnostics.push(pathDiagnostic('path-tracing', 'error', 'RAY_PATH_GPU_VALIDATION_ERROR', validationError.message, {}));
      for (const message of this._uncapturedErrors) diagnostics.push(pathDiagnostic('path-tracing', 'error', 'RAY_PATH_GPU_UNCAPTURED_ERROR', message, {}));
      const memory = this.memory(validated.width, validated.height, validated.readback, timestamp);
      return Object.freeze({ status: diagnostics.some(entry => entry.severity === 'error') ? 'failed' : 'ok', width: validated.width, height: validated.height,
        revision: `${facts.revision}:${this.materialFingerprint}:${validated.seed}:${validated.maxBounces}:${validated.toneMapping}:${validated.exposure}`,
        outputTexture: this._outputTexture, pixels, counters, gpuTimeNs, gpuTimeKind: timestamp ? 'timestamp-query' : 'unavailable', memory,
        diagnostics: Object.freeze([...diagnostics]) });
    } catch (error) {
      await this._device.popErrorScope().catch(() => null);
      const message = errorMessage(error);
      diagnostics.push(message.startsWith('device-lost:') || this._lostMessage ? deviceLost(this._lostMessage ?? message)
        : pathDiagnostic('lifecycle', 'error', message === 'stale-generation' ? 'RAY_PATH_READBACK_STALE' : 'RAY_PATH_RENDER_FAILED', message, {}));
      return failure(options, this.liveResourceCount, diagnostics);
    } finally {
      querySet?.destroy(); for (const buffer of transient) buffer.destroy(); this._rendering = false;
    }
  }

  destroy(): void {
    if (this._destroyed) return; this._destroyed = true; this._generation++;
    this._device.removeEventListener('uncapturederror', this._uncapturedHandler);
    for (const value of this._buffers.values()) value.buffer.destroy();
    this._materialTexture?.destroy(); this._defaultEnvironment?.destroy(); this._hdrTexture?.destroy(); this._outputTexture?.destroy();
    this._materialTexture = null; this._defaultEnvironment = null; this._hdrTexture = null; this._outputTexture = null;
    this._materialSampler = null; this._environmentSampler = null; this._tracePipeline = null; this._tonePipeline = null; this._layouts = null;
  }

  private resize(width: number, height: number): void {
    if (this._width === width && this._height === height && this._hdrTexture && this._outputTexture) return;
    this._hdrTexture?.destroy(); this._outputTexture?.destroy();
    this._hdrTexture = this._device.createTexture({ label: 'ray-path-hdr', size: { width, height }, format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    this._outputTexture = this._device.createTexture({ label: 'ray-path-output', size: { width, height }, format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this._width = width; this._height = height;
  }
  private staticBytes(): number { return [...this._buffers.values()].reduce((sum, value) => sum + value.allocatedBytes, 0); }
  private memory(width: number, height: number, readback: boolean, timestamp: boolean): RayPathMemory {
    const accelerationBytes = ACCELERATION_BUFFERS.reduce((sum, name) => sum + this._buffers.get(name)!.allocatedBytes, 0);
    const materialBytes = this._buffers.get('materials')!.allocatedBytes + this._buffers.get('surfaces')!.allocatedBytes;
    const textureBytes = this._materials.textures.bytesPerRow * this._materials.textures.height * this._materials.textures.layerCount;
    const outputBytes = width * height * 12; const diagnosticBytes = RAY_PATH_LAYOUT.diagnosticBytes;
    const readbackBytes = diagnosticBytes + (readback ? Math.ceil(width * 4 / 256) * 256 * height : 0) + (timestamp ? 32 : 0);
    return Object.freeze({ accelerationBytes, materialBytes, textureBytes, outputBytes, diagnosticBytes, readbackBytes,
      peakBytes: accelerationBytes + materialBytes + textureBytes + outputBytes + diagnosticBytes + readbackBytes + 640,
      liveResourceCount: this.liveResourceCount });
  }
}

interface ValidatedOptions { width: number; height: number; maxBounces: number; seed: number; exposure: number; toneMapping: RayToneMapping; readback: boolean }
function validateRenderOptions(device: GPUDevice, options: RayPathRenderOptions, diagnostics: RayPathDiagnostic[]): ValidatedOptions | null {
  const maxBounces = options.maxBounces ?? 3; const seed = options.seed ?? 1; const exposure = options.exposure ?? 1; const toneMapping = options.toneMapping ?? 'aces';
  if (!Number.isInteger(options.width) || options.width < 1 || !Number.isInteger(options.height) || options.height < 1) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_SIZE_INVALID', 'Render dimensions must be positive integers.', { width: options.width, height: options.height }));
  if (options.width > device.limits.maxTextureDimension2D || options.height > device.limits.maxTextureDimension2D) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_SIZE_UNSUPPORTED', 'Render dimensions exceed maxTextureDimension2D.', { width: options.width, height: options.height, limit: device.limits.maxTextureDimension2D }));
  if (Math.ceil(options.width / 8) > device.limits.maxComputeWorkgroupsPerDimension || Math.ceil(options.height / 8) > device.limits.maxComputeWorkgroupsPerDimension) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_DISPATCH_UNSUPPORTED', 'Render dimensions exceed compute dispatch limits.', {}));
  if (!Number.isInteger(maxBounces) || maxBounces < 1 || maxBounces > RAY_PATH_LAYOUT.maxBounces) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_BOUNCE_LIMIT_INVALID', 'maxBounces must be in [1, 8].', { maxBounces }));
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_SEED_INVALID', 'seed must be a uint32.', { seed }));
  if (!Number.isFinite(exposure) || exposure < 0) diagnostics.push(pathDiagnostic('tone-mapping', 'error', 'RAY_PATH_EXPOSURE_INVALID', 'exposure must be finite and non-negative.', { exposure }));
  if (!['linear', 'reinhard', 'aces'].includes(toneMapping)) diagnostics.push(pathDiagnostic('tone-mapping', 'error', 'RAY_PATH_TONE_MAPPING_UNSUPPORTED', 'Unknown tone mapping operator.', { toneMapping }));
  return diagnostics.some(entry => entry.severity === 'error') ? null : { width: options.width, height: options.height, maxBounces, seed, exposure, toneMapping, readback: options.readback ?? false };
}
function validateLimits(device: GPUDevice, acceleration: RayPackedAcceleration, materials: RayPackedMaterialScene, diagnostics: RayPathDiagnostic[]): void {
  const limits = device.limits;
  const required: Array<[keyof GPUSupportedLimits, number]> = [
    ['maxStorageBuffersPerShaderStage', 8], ['maxBindingsPerBindGroup', 15], ['maxStorageTexturesPerShaderStage', 1],
    ['maxSampledTexturesPerShaderStage', 2], ['maxSamplersPerShaderStage', 2], ['maxComputeInvocationsPerWorkgroup', 64],
    ['maxComputeWorkgroupSizeX', 8], ['maxComputeWorkgroupSizeY', 8], ['maxUniformBufferBindingSize', 512],
  ];
  for (const [name, expected] of required) { const actual = limits[name] as number; if (actual < expected) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_LIMIT_UNSUPPORTED', `WebGPU ${name} is below the path renderer requirement.`, { limit: name, required: expected, actual })); }
  if (materials.textures.width > limits.maxTextureDimension2D || materials.textures.height > limits.maxTextureDimension2D || materials.textures.layerCount > limits.maxTextureArrayLayers) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_TEXTURE_LIMIT_UNSUPPORTED', 'Packed texture atlas exceeds device limits.', { width: materials.textures.width, height: materials.textures.height, layers: materials.textures.layerCount }));
  for (const name of ACCELERATION_BUFFERS) validateBufferSize(name, Math.max(acceleration.buffers[name].stride, acceleration.buffers[name].data.byteLength), limits, diagnostics);
  validateBufferSize('materials', Math.max(materials.materials.stride, materials.materials.data.byteLength), limits, diagnostics);
  validateBufferSize('surfaces', Math.max(materials.surfaces.stride, materials.surfaces.data.byteLength), limits, diagnostics);
}
function validateBufferSize(name: string, bytes: number, limits: GPUSupportedLimits, diagnostics: RayPathDiagnostic[]): void {
  if (bytes > limits.maxBufferSize || bytes > limits.maxStorageBufferBindingSize) diagnostics.push(pathDiagnostic('upload', 'error', 'RAY_PATH_BUFFER_LIMIT_UNSUPPORTED', `${name} exceeds WebGPU storage buffer limits.`, { buffer: name, bytes, maxBufferSize: limits.maxBufferSize, maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize }));
}
function packParams(facts: RayPathSceneFacts, options: ValidatedOptions, acceleration: RayPackedAcceleration): ArrayBuffer {
  const data = new ArrayBuffer(128); const view = new DataView(data);
  [options.width, options.height, options.maxBounces, options.seed].forEach((value, index) => view.setUint32(index * 4, value, true));
  let flags = (facts.environment.texture ? 1 : 0) | (facts.camera.projection === 'orthographic' ? 2 : 0) | (options.toneMapping === 'reinhard' ? 4 : 0) | (options.toneMapping === 'aces' ? 8 : 0);
  [acceleration.tlasRootNode, acceleration.buffers.instances.count, facts.lights.length, flags].forEach((value, index) => view.setUint32(16 + index * 4, value, true));
  writeVec4(view, 32, facts.camera.origin, facts.camera.near);
  writeVec4(view, 48, facts.camera.right, facts.camera.projection === 'perspective' ? Math.tan(facts.camera.verticalFov / 2) : facts.camera.orthographicHeight);
  writeVec4(view, 64, facts.camera.up, 0); writeVec4(view, 80, facts.camera.forward, facts.camera.far);
  writeVec4(view, 96, facts.environment.color, facts.environment.intensity);
  writeVec4(view, 112, [options.width / options.height, options.exposure, facts.environment.rotation] as const, 0);
  return data;
}
function packLights(facts: RayPathSceneFacts): ArrayBuffer {
  const data = new ArrayBuffer(RAY_PATH_LAYOUT.lightBytes); const view = new DataView(data);
  facts.lights.forEach((light, index) => { const offset = index * 64; view.setUint32(offset, light.type === 'ambient' ? 0 : light.type === 'directional' ? 1 : 2, true); writeVec4(view, offset + 16, light.color, light.intensity); writeVec4(view, offset + 32, light.direction, light.range); writeVec4(view, offset + 48, light.position, 0); });
  return data;
}
function writeVec4(view: DataView, offset: number, values: readonly number[], w: number): void { view.setFloat32(offset, values[0]!, true); view.setFloat32(offset + 4, values[1]!, true); view.setFloat32(offset + 8, values[2]!, true); view.setFloat32(offset + 12, w, true); }
function createStaticBuffer(device: GPUDevice, label: string, data: ArrayBuffer, stride: number): OwnedBuffer { const allocatedBytes = Math.max(4, stride, data.byteLength); const buffer = device.createBuffer({ label, size: allocatedBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); if (data.byteLength) device.queue.writeBuffer(buffer, 0, data); return { buffer, allocatedBytes }; }
function createUploaded(device: GPUDevice, label: string, data: ArrayBuffer, usage: GPUBufferUsageFlags): GPUBuffer { const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(buffer, 0, data); return buffer; }
function createDefaultEnvironment(device: GPUDevice): GPUTexture { const texture = device.createTexture({ label: 'ray-path-default-environment', size: { width: 1, height: 1, depthOrArrayLayers: 6 }, dimension: '2d', format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); const data = new Uint8Array(256 * 6); for (let layer = 0; layer < 6; layer++) data[layer * 256 + 3] = 255; device.queue.writeTexture({ texture }, data, { bytesPerRow: 256, rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: 6 }); return texture; }
function countersFrom(values: Uint32Array): RayPathCounters { return Object.freeze({ pixels: values[0] ?? 0, rays: values[1] ?? 0, bounces: values[2] ?? 0, hits: values[3] ?? 0, misses: values[4] ?? 0, shadowRays: values[5] ?? 0, emissiveHits: values[6] ?? 0, stackOverflows: values[7] ?? 0, invalidAccesses: values[8] ?? 0 }); }
function validateCounters(counters: RayPathCounters, pixelCount: number, diagnostics: RayPathDiagnostic[]): void { if (counters.pixels !== pixelCount || counters.bounces < counters.pixels || counters.rays < counters.bounces) diagnostics.push(pathDiagnostic('readback', 'error', 'RAY_PATH_READBACK_INVALID', 'GPU counters violate path-render invariants.', { pixelCount, counterPixels: counters.pixels, rays: counters.rays, bounces: counters.bounces })); if (counters.stackOverflows) diagnostics.push(pathDiagnostic('path-tracing', 'error', 'RAY_PATH_STACK_OVERFLOW', 'One or more path or shadow rays exceeded the frozen stack.', { count: counters.stackOverflows })); if (counters.invalidAccesses) diagnostics.push(pathDiagnostic('path-tracing', 'error', 'RAY_PATH_PACKED_ACCESS_INVALID', 'Path shader detected an invalid packed indirection.', { count: counters.invalidAccesses })); }
function unpackRows(source: Uint8Array, width: number, height: number, bytesPerRow: number): Uint8Array { const result = new Uint8Array(width * height * 4); for (let row = 0; row < height; row++) result.set(source.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4); return result; }
function failure(options: RayPathRenderOptions, liveResourceCount: number, diagnostics: readonly RayPathDiagnostic[]): RayPathRenderResult { return Object.freeze({ status: 'failed', width: options.width, height: options.height, revision: '', outputTexture: null, pixels: null, counters: ZERO_COUNTERS, gpuTimeNs: null, gpuTimeKind: 'unavailable', memory: Object.freeze({ accelerationBytes: 0, materialBytes: 0, textureBytes: 0, outputBytes: 0, diagnosticBytes: 0, readbackBytes: 0, peakBytes: 0, liveResourceCount }), diagnostics: Object.freeze([...diagnostics]) }); }
function freezeCreate(renderer: RayPathTracingRenderer | null, diagnostics: readonly RayPathDiagnostic[]): RayPathRendererCreateResult { return Object.freeze({ renderer, diagnostics: Object.freeze([...diagnostics]) }); }
function deviceLost(message: string): RayPathDiagnostic { return pathDiagnostic('lifecycle', 'error', 'RAY_PATH_DEVICE_LOST', 'WebGPU device was lost; the path renderer did not fall back to CPU.', { message }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
