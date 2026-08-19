import { recordComputeResourcePass, type RenderCommandContext } from '@haiyue/engine/experimental';
import { RAY_ACCELERATION_ABI_FINGERPRINT, validatePackedAcceleration } from '../acceleration/index.js';
import type { RayPackedAcceleration, RayPackedBufferName } from '../acceleration/index.js';
import { traceRayBruteForce } from '../reference/index.js';
import type { CanonicalRay, RayInput, RayReferenceScene, RayVec3 } from '../reference/index.js';
import { RAY_TRAVERSAL_SHADER_ARTIFACT } from '../shaders/ray-traversal-artifact.generated.js';
import { traversalDiagnostic } from './diagnostics.js';
import { createRayTraversalBindGroupLayout, RAY_TRAVERSAL_LAYOUT } from './layout.js';
import { createRayTraversalDispatchPlan } from './plan.js';
import type {
  RayTraversalCounters,
  RayTraversalCreateResult,
  RayTraversalDiagnostic,
  RayTraversalExecuteOptions,
  RayTraversalHit,
  RayTraversalMemory,
  RayTraversalMode,
  RayTraversalResult,
} from './types.js';

const EMPTY_SCENE: RayReferenceScene = Object.freeze({ geometries: Object.freeze([]), instances: Object.freeze([]), analyticPrimitives: Object.freeze([]) });
const PACKED_INPUTS = Object.freeze(['blasNodes', 'blasTable', 'tlasNodes', 'primitives', 'instances'] as const satisfies readonly RayPackedBufferName[]);
const ZERO_COUNTERS: RayTraversalCounters = Object.freeze({ rays: 0, tlasNodeTests: 0, blasNodeTests: 0, primitiveTests: 0, hits: 0, misses: 0, stackOverflows: 0, invalidAccesses: 0 });

interface OwnedBuffer { readonly buffer: GPUBuffer; readonly allocatedBytes: number }

export class RayTraversalRuntime {
  readonly artifactHash = RAY_TRAVERSAL_LAYOUT.artifactHash;
  readonly accelerationFingerprint: string;

  private readonly _device: GPUDevice;
  private readonly _packed: RayPackedAcceleration;
  private readonly _buffers: ReadonlyMap<RayPackedBufferName, OwnedBuffer>;
  private _bindGroupLayout: GPUBindGroupLayout | null;
  private _pipeline: GPUComputePipeline | null;
  private _destroyed = false;
  private _executing = false;
  private _generation = 0;
  private _lostMessage: string | null = null;
  private readonly _uncapturedErrors: string[] = [];
  private readonly _uncapturedHandler: (event: GPUUncapturedErrorEvent) => void;

  private constructor(
    device: GPUDevice,
    packed: RayPackedAcceleration,
    buffers: ReadonlyMap<RayPackedBufferName, OwnedBuffer>,
    bindGroupLayout: GPUBindGroupLayout,
    pipeline: GPUComputePipeline,
  ) {
    this._device = device;
    this._packed = packed;
    this._buffers = buffers;
    this._bindGroupLayout = bindGroupLayout;
    this._pipeline = pipeline;
    this.accelerationFingerprint = packed.fingerprint;
    this._uncapturedHandler = event => this._uncapturedErrors.push(event.error?.message ?? 'Unknown uncaptured WebGPU error.');
    device.addEventListener('uncapturederror', this._uncapturedHandler);
    void device.lost.then(info => {
      this._lostMessage = `${info.reason}: ${info.message}`;
      this._generation++;
    });
  }

  static async create(device: GPUDevice, packed: RayPackedAcceleration): Promise<RayTraversalCreateResult> {
    const diagnostics: RayTraversalDiagnostic[] = [];
    if (packed.abiFingerprint !== RAY_ACCELERATION_ABI_FINGERPRINT) {
      diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_ABI_UNSUPPORTED', 'Packed acceleration ABI does not match the traversal shader.', {
        expected: RAY_ACCELERATION_ABI_FINGERPRINT, actual: packed.abiFingerprint,
      }));
    }
    for (const entry of validatePackedAcceleration(packed)) {
      diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_PACKED_ACCELERATION_INVALID', entry.message, { accelerationCode: entry.code }));
    }
    validateDeviceLimits(device, packed, diagnostics);
    if (diagnostics.some(entry => entry.severity === 'error')) return freezeCreate(null, diagnostics);

    const owned = new Map<RayPackedBufferName, OwnedBuffer>();
    let bindGroupLayout: GPUBindGroupLayout | null = null;
    device.pushErrorScope('validation');
    try {
      const pass = RAY_TRAVERSAL_SHADER_ARTIFACT.passes['ray-traversal'];
      if (!pass || RAY_TRAVERSAL_SHADER_ARTIFACT.version !== 2) throw new Error('Ray traversal Artifact V2 pass is unavailable.');
      const module = device.createShaderModule({ label: 'ray-traversal-artifact-v2', code: pass.code });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === 'error');
      if (errors.length > 0) {
        diagnostics.push(traversalDiagnostic('shader', 'error', 'RAY_GPU_SHADER_COMPILATION_FAILED', errors.map(message => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'), { errorCount: errors.length }));
      }
      bindGroupLayout = createRayTraversalBindGroupLayout(device);
      const pipelineLayout = device.createPipelineLayout({ label: 'ray-traversal-pipeline-layout', bindGroupLayouts: [bindGroupLayout] });
      const pipeline = await device.createComputePipelineAsync({
        label: 'ray-traversal-compute', layout: pipelineLayout,
        compute: { module, entryPoint: pass.entryPoints.compute! },
      });
      for (const name of PACKED_INPUTS) {
        const source = packed.buffers[name];
        const allocatedBytes = Math.max(4, source.stride, source.data.byteLength);
        const buffer = device.createBuffer({ label: `ray-${name}`, size: allocatedBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        if (source.data.byteLength > 0) device.queue.writeBuffer(buffer, 0, source.data);
        owned.set(name, { buffer, allocatedBytes });
      }
      const validationError = await device.popErrorScope();
      if (validationError) diagnostics.push(traversalDiagnostic('shader', 'error', 'RAY_GPU_VALIDATION_ERROR', validationError.message, {}));
      if (diagnostics.some(entry => entry.severity === 'error')) {
        for (const value of owned.values()) value.buffer.destroy();
        return freezeCreate(null, diagnostics);
      }
      return freezeCreate(new RayTraversalRuntime(device, packed, owned, bindGroupLayout, pipeline), diagnostics);
    } catch (error) {
      const validationError = await device.popErrorScope().catch(() => null);
      if (validationError) diagnostics.push(traversalDiagnostic('shader', 'error', 'RAY_GPU_VALIDATION_ERROR', validationError.message, {}));
      diagnostics.push(traversalDiagnostic('shader', 'error', 'RAY_GPU_PIPELINE_CREATION_FAILED', errorMessage(error), {}));
      for (const value of owned.values()) value.buffer.destroy();
      return freezeCreate(null, diagnostics);
    }
  }

  get destroyed(): boolean { return this._destroyed; }
  get liveResourceCount(): number { return this._destroyed ? 0 : this._buffers.size; }

  async execute(inputs: readonly RayInput[], options: RayTraversalExecuteOptions = {}): Promise<RayTraversalResult> {
    const mode = options.mode ?? 'closest-hit';
    const diagnostics: RayTraversalDiagnostic[] = [];
    if (this._destroyed) return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics.concat(traversalDiagnostic('lifecycle', 'error', 'RAY_GPU_RUNTIME_DESTROYED', 'Ray traversal runtime is destroyed.', {})));
    if (this._lostMessage) return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics.concat(deviceLost(this._lostMessage)));
    if (this._executing) return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics.concat(traversalDiagnostic('lifecycle', 'error', 'RAY_GPU_EXECUTION_BUSY', 'Ray traversal runtime permits one owned readback at a time.', {})));
    if (mode !== 'closest-hit' && mode !== 'any-hit') return failureResult('closest-hit', inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics.concat(traversalDiagnostic('traversal', 'error', 'RAY_GPU_MODE_INVALID', `Unsupported traversal mode ${String(mode)}.`, {})));
    const stackLimit = options.stackLimit ?? RAY_TRAVERSAL_LAYOUT.stackCapacity;
    if (!Number.isInteger(stackLimit) || stackLimit < 1 || stackLimit > RAY_TRAVERSAL_LAYOUT.stackCapacity) {
      return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics.concat(traversalDiagnostic('traversal', 'error', 'RAY_GPU_STACK_LIMIT_INVALID', 'stackLimit must be an integer in [1, 64].', { stackLimit })));
    }
    const canonical = canonicalize(inputs, diagnostics);
    if (!canonical) return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics);
    if (canonical.length === 0) return successEmpty(mode, this._staticBytes(), diagnostics);
    const defaultBatch = Math.min(4096, this._device.limits.maxComputeWorkgroupsPerDimension * RAY_TRAVERSAL_LAYOUT.workgroupSize);
    const maxRaysPerDispatch = options.maxRaysPerDispatch ?? defaultBatch;
    if (!Number.isInteger(maxRaysPerDispatch) || maxRaysPerDispatch < 1) {
      diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_DISPATCH_SIZE_INVALID', 'maxRaysPerDispatch must be a positive integer.', { maxRaysPerDispatch }));
      return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics);
    }
    const plan = createRayTraversalDispatchPlan(canonical.length, maxRaysPerDispatch);
    const rayBytesRequired = canonical.length * RAY_TRAVERSAL_LAYOUT.rayStride;
    const hitBytesRequired = canonical.length * RAY_TRAVERSAL_LAYOUT.hitStride;
    const dispatchRayCount = Math.min(canonical.length, maxRaysPerDispatch);
    const dispatchWorkgroups = Math.ceil(dispatchRayCount / RAY_TRAVERSAL_LAYOUT.workgroupSize);
    if (!Number.isSafeInteger(rayBytesRequired) || !Number.isSafeInteger(hitBytesRequired)
      || rayBytesRequired > this._device.limits.maxStorageBufferBindingSize
      || hitBytesRequired > this._device.limits.maxStorageBufferBindingSize
      || rayBytesRequired > this._device.limits.maxBufferSize || hitBytesRequired > this._device.limits.maxBufferSize) {
      diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_BUFFER_LIMIT_UNSUPPORTED', 'Ray or hit storage exceeds the device buffer limits.', {
        rayBytes: rayBytesRequired, hitBytes: hitBytesRequired,
        maxBufferSize: this._device.limits.maxBufferSize,
        maxStorageBufferBindingSize: this._device.limits.maxStorageBufferBindingSize,
      }));
      return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics);
    }
    if (dispatchWorkgroups > this._device.limits.maxComputeWorkgroupsPerDimension) {
      diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_DISPATCH_LIMIT_UNSUPPORTED', 'Requested batch exceeds maxComputeWorkgroupsPerDimension.', {
        dispatchWorkgroups, maxComputeWorkgroupsPerDimension: this._device.limits.maxComputeWorkgroupsPerDimension,
      }));
      return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics);
    }
    const generation = this._generation;
    this._executing = true;
    this._uncapturedErrors.length = 0;
    const transient: GPUBuffer[] = [];
    let querySet: GPUQuerySet | null = null;
    this._device.pushErrorScope('validation');
    try {
      const rayData = packRays(canonical);
      const hitBytes = canonical.length * RAY_TRAVERSAL_LAYOUT.hitStride;
      const rayBuffer = createUploadedBuffer(this._device, 'ray-inputs', rayData, GPUBufferUsage.STORAGE);
      const hitBuffer = this._device.createBuffer({ label: 'ray-hits', size: hitBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const diagnosticBuffer = this._device.createBuffer({ label: 'ray-diagnostics', size: RAY_TRAVERSAL_LAYOUT.diagnosticSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const hitReadback = this._device.createBuffer({ label: 'ray-hit-readback', size: hitBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const diagnosticReadback = this._device.createBuffer({ label: 'ray-diagnostic-readback', size: RAY_TRAVERSAL_LAYOUT.diagnosticSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      transient.push(rayBuffer, hitBuffer, diagnosticBuffer, hitReadback, diagnosticReadback);
      this._device.queue.writeBuffer(diagnosticBuffer, 0, new Uint32Array(8));

      const timestampSupported = this._device.features.has('timestamp-query');
      let timestampReadback: GPUBuffer | null = null;
      let timestampResolve: GPUBuffer | null = null;
      if (timestampSupported) {
        querySet = this._device.createQuerySet({ type: 'timestamp', count: 2 });
        timestampResolve = this._device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        timestampReadback = this._device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        transient.push(timestampResolve, timestampReadback);
      } else {
        diagnostics.push(traversalDiagnostic('traversal', 'info', 'RAY_GPU_TIMESTAMP_UNSUPPORTED', 'timestamp-query is unavailable; correctness execution continues without GPU timestamps.', {}));
      }

      const encoder = this._device.createCommandEncoder({ label: 'ray-traversal-plan' });
      const context: RenderCommandContext = { device: this._device, encoder };
      const staticBuffers = PACKED_INPUTS.map(name => this._buffers.get(name)!.buffer);
      const uploadToken = recordComputeResourcePass(context, {
        label: 'ray.upload', path: 'rayTraversal.upload',
        accesses: [rayBuffer, hitBuffer, diagnosticBuffer, ...staticBuffers].map((resource, index) => ({ resource, use: 'copy-write' as const, path: `rayTraversal.upload.resources[${index}]` })),
      });
      const computeDescriptor: GPUComputePassDescriptor = timestampSupported
        ? { label: 'ray-traversal', timestampWrites: { querySet: querySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
        : { label: 'ray-traversal' };
      const pass = encoder.beginComputePass(computeDescriptor);
      pass.setPipeline(this._pipeline!);
      let priorToken = uploadToken;
      const paramsBuffers: GPUBuffer[] = [];
      for (let dispatchIndex = 0; dispatchIndex < plan.dispatchCount; dispatchIndex++) {
        const rayOffset = dispatchIndex * maxRaysPerDispatch;
        const rayCount = Math.min(maxRaysPerDispatch, canonical.length - rayOffset);
        const paramsBuffer = createUploadedBuffer(this._device, `ray-params-${dispatchIndex}`, new Uint32Array([
          rayCount, rayOffset, rayOffset, mode === 'any-hit' ? 1 : 0,
          this._packed.tlasRootNode, stackLimit, this._packed.buffers.instances.count, 0,
        ]), GPUBufferUsage.UNIFORM);
        transient.push(paramsBuffer); paramsBuffers.push(paramsBuffer);
        const bindGroup = this._device.createBindGroup({
          label: `ray-traversal-${dispatchIndex}`, layout: this._bindGroupLayout!, entries: [
            { binding: 0, resource: { buffer: paramsBuffer } }, { binding: 1, resource: { buffer: rayBuffer } },
            { binding: 2, resource: { buffer: this._buffers.get('blasNodes')!.buffer } }, { binding: 3, resource: { buffer: this._buffers.get('blasTable')!.buffer } },
            { binding: 4, resource: { buffer: this._buffers.get('tlasNodes')!.buffer } }, { binding: 5, resource: { buffer: this._buffers.get('primitives')!.buffer } },
            { binding: 6, resource: { buffer: this._buffers.get('instances')!.buffer } }, { binding: 7, resource: { buffer: hitBuffer } },
            { binding: 8, resource: { buffer: diagnosticBuffer } },
          ],
        });
        const token = recordComputeResourcePass(context, {
          label: `ray.traversal.${dispatchIndex}`, path: `rayTraversal.dispatches[${dispatchIndex}]`, after: [priorToken],
          accesses: [
            { resource: rayBuffer, use: 'storage-read', path: 'rayTraversal.rays' },
            ...staticBuffers.map((resource, index) => ({ resource, use: 'storage-read' as const, path: `rayTraversal.acceleration[${index}]` })),
            { resource: hitBuffer, use: 'storage-write', path: 'rayTraversal.hits' },
            { resource: diagnosticBuffer, use: 'storage-read-write', path: 'rayTraversal.diagnostics' },
          ],
        });
        priorToken = token;
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(rayCount / RAY_TRAVERSAL_LAYOUT.workgroupSize));
      }
      pass.end();
      recordComputeResourcePass(context, {
        label: 'ray.consumer', path: 'rayTraversal.consumer', after: [priorToken], accesses: [
          { resource: hitBuffer, use: 'copy-read', path: 'rayTraversal.consumer.hits' },
          { resource: diagnosticBuffer, use: 'copy-read', path: 'rayTraversal.consumer.diagnostics' },
        ],
      });
      encoder.copyBufferToBuffer(hitBuffer, 0, hitReadback, 0, hitBytes);
      encoder.copyBufferToBuffer(diagnosticBuffer, 0, diagnosticReadback, 0, RAY_TRAVERSAL_LAYOUT.diagnosticSize);
      if (timestampSupported) {
        encoder.resolveQuerySet(querySet!, 0, 2, timestampResolve!, 0);
        encoder.copyBufferToBuffer(timestampResolve!, 0, timestampReadback!, 0, 16);
      }
      this._device.queue.submit([encoder.finish()]);
      await Promise.all([hitReadback.mapAsync(GPUMapMode.READ), diagnosticReadback.mapAsync(GPUMapMode.READ), timestampReadback?.mapAsync(GPUMapMode.READ)]);
      if (generation !== this._generation || this._destroyed) throw new Error(this._lostMessage ? `device-lost:${this._lostMessage}` : 'stale-generation');
      const hitCopy = new Uint8Array(hitReadback.getMappedRange()).slice();
      const counterCopy = new Uint32Array(diagnosticReadback.getMappedRange()).slice();
      let gpuTimeNs: number | null = null;
      if (timestampReadback) {
        const timestamps = new BigUint64Array(timestampReadback.getMappedRange());
        gpuTimeNs = Number(timestamps[1]! - timestamps[0]!);
      }
      hitReadback.unmap(); diagnosticReadback.unmap(); timestampReadback?.unmap();
      const counters = freezeCounters(counterCopy);
      const parsedHits = parseHits(hitCopy.buffer, canonical.length, this._packed);
      validateReadback(parsedHits, counters, canonical.length, diagnostics);
      if (counters.stackOverflows > 0) diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_STACK_OVERFLOW', 'One or more rays exceeded the bounded traversal stack.', { count: counters.stackOverflows, stackLimit }));
      if (counters.invalidAccesses > 0) diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_PACKED_ACCESS_INVALID', 'Traversal detected an out-of-range packed indirection.', { count: counters.invalidAccesses }));
      const validationError = await this._device.popErrorScope();
      if (validationError) diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_VALIDATION_ERROR', validationError.message, {}));
      for (const message of this._uncapturedErrors) diagnostics.push(traversalDiagnostic('traversal', 'error', 'RAY_GPU_UNCAPTURED_ERROR', message, {}));
      const memory = memorySnapshot(this._staticBytes(), rayData.byteLength, hitBytes, paramsBuffers.length * 32, timestampSupported, this._buffers.size);
      return Object.freeze({
        status: diagnostics.some(entry => entry.severity === 'error') ? 'failed' : 'ok', mode,
        hits: Object.freeze(parsedHits), counters, dispatchCount: plan.dispatchCount,
        gpuTimeNs, gpuTimeKind: timestampSupported ? 'timestamp-query' : 'unavailable', memory,
        diagnostics: Object.freeze([...diagnostics]),
      });
    } catch (error) {
      await this._device.popErrorScope().catch(() => null);
      const message = errorMessage(error);
      diagnostics.push(message.startsWith('device-lost:') || this._lostMessage ? deviceLost(this._lostMessage ?? message) : traversalDiagnostic('readback', 'error', message === 'stale-generation' ? 'RAY_GPU_READBACK_STALE' : 'RAY_GPU_EXECUTION_FAILED', message, {}));
      return failureResult(mode, inputs.length, this._staticBytes(), this.liveResourceCount, diagnostics);
    } finally {
      querySet?.destroy();
      for (const buffer of transient) buffer.destroy();
      this._executing = false;
    }
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._generation++;
    this._device.removeEventListener('uncapturederror', this._uncapturedHandler);
    for (const value of this._buffers.values()) value.buffer.destroy();
    this._pipeline = null;
    this._bindGroupLayout = null;
  }

  private _staticBytes(): number { return [...this._buffers.values()].reduce((sum, value) => sum + value.allocatedBytes, 0); }
}

function validateDeviceLimits(device: GPUDevice, packed: RayPackedAcceleration, diagnostics: RayTraversalDiagnostic[]): void {
  const limits = device.limits;
  const failures: Array<[string, number, number]> = [
    ['maxStorageBuffersPerShaderStage', RAY_TRAVERSAL_LAYOUT.requiredStorageBuffersPerShaderStage, limits.maxStorageBuffersPerShaderStage],
    ['maxBindingsPerBindGroup', RAY_TRAVERSAL_LAYOUT.requiredBindingsPerBindGroup, limits.maxBindingsPerBindGroup],
    ['maxComputeInvocationsPerWorkgroup', RAY_TRAVERSAL_LAYOUT.workgroupSize, limits.maxComputeInvocationsPerWorkgroup],
    ['maxComputeWorkgroupSizeX', RAY_TRAVERSAL_LAYOUT.workgroupSize, limits.maxComputeWorkgroupSizeX],
  ];
  for (const [limit, required, actual] of failures) if (actual < required) diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_LIMIT_UNSUPPORTED', `WebGPU ${limit} is below the ray traversal requirement.`, { limit, required, actual }));
  for (const name of PACKED_INPUTS) {
    const bytes = Math.max(4, packed.buffers[name].stride, packed.buffers[name].data.byteLength);
    if (bytes > limits.maxBufferSize || bytes > limits.maxStorageBufferBindingSize) diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_BUFFER_LIMIT_UNSUPPORTED', `${name} exceeds WebGPU buffer limits.`, { buffer: name, bytes, maxBufferSize: limits.maxBufferSize, maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize }));
  }
}

function canonicalize(inputs: readonly RayInput[], diagnostics: RayTraversalDiagnostic[]): readonly CanonicalRay[] | null {
  const result: CanonicalRay[] = [];
  inputs.forEach((input, index) => {
    const traced = traceRayBruteForce(EMPTY_SCENE, input);
    if (!traced.ray) diagnostics.push(traversalDiagnostic('upload', 'error', 'RAY_GPU_RAY_INVALID', 'Ray failed canonical CPU validation and was not uploaded.', { rayIndex: index, referenceCode: traced.diagnostics[0]?.code ?? 'unknown' }));
    else result.push(traced.ray);
  });
  return diagnostics.some(entry => entry.severity === 'error') ? null : Object.freeze(result);
}
function packRays(rays: readonly CanonicalRay[]): Float32Array {
  const result = new Float32Array(rays.length * 8);
  rays.forEach((ray, index) => result.set([ray.origin[0], ray.origin[1], ray.origin[2], ray.tMin, ray.direction[0], ray.direction[1], ray.direction[2], ray.tMax], index * 8));
  return result;
}
function createUploadedBuffer(device: GPUDevice, label: string, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
  const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
  if (data.byteLength > 0) device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}
function parseHits(buffer: ArrayBuffer, count: number, packed: RayPackedAcceleration): Array<RayTraversalHit | null> {
  const view = new DataView(buffer);
  const result: Array<RayTraversalHit | null> = [];
  for (let index = 0; index < count; index++) {
    const offset = index * RAY_TRAVERSAL_LAYOUT.hitStride;
    const flags = view.getUint32(offset + 28, true);
    if ((flags & 1) === 0) { result.push(null); continue; }
    const instanceIdentityIndex = view.getUint32(offset + 16, true);
    const geometryIdentityIndex = view.getUint32(offset + 20, true);
    const kind = view.getUint32(offset + 12, true);
    const u = view.getFloat32(offset + 4, true); const v = view.getFloat32(offset + 8, true);
    const normal = readVec3(view, offset + 48);
    result.push(Object.freeze({
      primitiveKind: kind === 0 ? 'triangle' : 'sphere', instanceIdentityIndex,
      instanceIdentity: packed.instanceIdentities[instanceIdentityIndex] ?? `invalid:${instanceIdentityIndex}`,
      geometryIdentityIndex, geometryIdentity: packed.geometryIdentities[geometryIdentityIndex] ?? `invalid:${geometryIdentityIndex}`,
      primitiveIndex: view.getUint32(offset + 24, true), t: view.getFloat32(offset, true),
      position: readVec3(view, offset + 32), barycentric: kind === 0 ? freezeVec3(1 - u - v, u, v) : null,
      frontFace: (flags & 2) !== 0, geometricNormal: normal, shadingNormal: readVec3(view, offset + 64), facingNormal: readVec3(view, offset + 80),
    }));
  }
  return result;
}
function validateReadback(hits: readonly (RayTraversalHit | null)[], counters: RayTraversalCounters, rayCount: number, diagnostics: RayTraversalDiagnostic[]): void {
  const decodedHits = hits.filter((hit): hit is RayTraversalHit => hit !== null);
  const terminalCount = counters.hits + counters.misses + counters.stackOverflows + counters.invalidAccesses;
  const invalidHit = decodedHits.find(hit => !Number.isFinite(hit.t)
    || hit.instanceIdentity.startsWith('invalid:') || hit.geometryIdentity.startsWith('invalid:')
    || [...hit.position, ...hit.geometricNormal, ...hit.shadingNormal, ...hit.facingNormal].some(value => !Number.isFinite(value)));
  if (hits.length !== rayCount || counters.rays !== rayCount || terminalCount !== rayCount
    || decodedHits.length !== counters.hits || invalidHit) {
    diagnostics.push(traversalDiagnostic('readback', 'error', 'RAY_GPU_READBACK_INVALID', 'GPU readback records do not match traversal counters or frozen identity/layout invariants.', {
      rayCount, decodedRecordCount: hits.length, counterRays: counters.rays, counterTerminal: terminalCount,
      decodedHits: decodedHits.length, counterHits: counters.hits, invalidIdentity: Boolean(invalidHit),
    }));
  }
}
function readVec3(view: DataView, offset: number): RayVec3 { return freezeVec3(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)); }
function freezeVec3(x: number, y: number, z: number): RayVec3 { return Object.freeze([x, y, z]); }
function freezeCounters(values: Uint32Array): RayTraversalCounters { return Object.freeze({ rays: values[0] ?? 0, tlasNodeTests: values[1] ?? 0, blasNodeTests: values[2] ?? 0, primitiveTests: values[3] ?? 0, hits: values[4] ?? 0, misses: values[5] ?? 0, stackOverflows: values[6] ?? 0, invalidAccesses: values[7] ?? 0 }); }
function memorySnapshot(staticBytes: number, rayBytes: number, hitBytes: number, parameterBytes: number, timestamp: boolean, liveResourceCount: number): RayTraversalMemory {
  const diagnosticBytes = 32; const readbackBytes = hitBytes + diagnosticBytes + (timestamp ? 16 : 0);
  return Object.freeze({ accelerationBytes: staticBytes, rayBytes, hitBytes, diagnosticBytes, parameterBytes, readbackBytes, peakBytes: staticBytes + rayBytes + hitBytes + diagnosticBytes + parameterBytes + readbackBytes + (timestamp ? 32 : 0), liveResourceCount });
}
function failureResult(mode: RayTraversalMode, count: number, staticBytes: number, liveResourceCount: number, diagnostics: readonly RayTraversalDiagnostic[]): RayTraversalResult { return Object.freeze({ status: 'failed', mode, hits: Object.freeze(Array<null>(count).fill(null)), counters: ZERO_COUNTERS, dispatchCount: 0, gpuTimeNs: null, gpuTimeKind: 'unavailable', memory: memorySnapshot(staticBytes, 0, 0, 0, false, liveResourceCount), diagnostics: Object.freeze([...diagnostics]) }); }
function successEmpty(mode: RayTraversalMode, staticBytes: number, diagnostics: readonly RayTraversalDiagnostic[]): RayTraversalResult { return Object.freeze({ status: 'ok', mode, hits: Object.freeze([]), counters: ZERO_COUNTERS, dispatchCount: 0, gpuTimeNs: null, gpuTimeKind: 'unavailable', memory: memorySnapshot(staticBytes, 0, 0, 0, false, 5), diagnostics: Object.freeze([...diagnostics]) }); }
function freezeCreate(runtime: RayTraversalRuntime | null, diagnostics: readonly RayTraversalDiagnostic[]): RayTraversalCreateResult { return Object.freeze({ runtime, diagnostics: Object.freeze([...diagnostics]) }); }
function deviceLost(message: string): RayTraversalDiagnostic { return traversalDiagnostic('lifecycle', 'error', 'RAY_GPU_DEVICE_LOST', 'WebGPU device was lost; traversal did not fall back to CPU.', { message }); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
