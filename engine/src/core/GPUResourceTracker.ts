export type GPUResourceOwnerKind = 'engine' | 'scene' | 'system' | 'plugin' | 'asset' | 'frame';
export type GPUTrackedResourceType =
  | 'buffer'
  | 'texture'
  | 'sampler'
  | 'bind-group'
  | 'bind-group-layout'
  | 'pipeline-layout'
  | 'render-pipeline'
  | 'compute-pipeline'
  | 'query-set';

export interface GPUResourceTrackerOptions {
  /** Detailed records are opt-in so production builds pay only ownership bookkeeping. */
  debug?: boolean;
  /** Capturing stacks is deliberately separate because Error.stack is relatively expensive. */
  captureStacks?: boolean;
  frameDiagnostics?: import('./FrameDiagnostics').FrameDiagnostics;
}

export interface GPUResourceOwner {
  readonly kind: GPUResourceOwnerKind;
  readonly id: string;
  readonly label: string;
}

export interface GPUResourceUsage {
  buffers: number;
  textures: number;
  querySets: number;
  estimatedBytes: number;
}

export interface GPUResourceRecord {
  readonly id: number;
  readonly owner: GPUResourceOwner;
  readonly label: string;
  readonly type: GPUTrackedResourceType;
  readonly estimatedBytes: number;
  readonly createdAtFrame: number;
  readonly lastUsedFrame: number;
  readonly creationStack?: string | undefined;
}

interface TrackedResource extends GPUResourceRecord {
  readonly resource: GPUTrackedResource;
  lastUsedFrame: number;
}

interface MutableResourceTypeStats {
  current: number;
  created: number;
  destroyed: number;
  peak: number;
  estimatedBytes: number;
  peakEstimatedBytes: number;
  frameCreated: number;
  frameDestroyed: number;
}

interface MutableCacheStats {
  label: string;
  owner: GPUResourceOwner;
  entries: number;
  peakEntries: number;
  hits: number;
  misses: number;
}

type GPUTrackedResource =
  | GPUBuffer
  | GPUTexture
  | GPUSampler
  | GPUBindGroup
  | GPUBindGroupLayout
  | GPUPipelineLayout
  | GPURenderPipeline
  | GPUComputePipeline
  | GPUQuerySet;

export interface GPUResourceTypeStats {
  readonly current: number;
  readonly created: number;
  readonly destroyed: number;
  readonly peak: number;
  readonly estimatedBytes: number;
  readonly peakEstimatedBytes: number;
  readonly frameCreated: number;
  readonly frameDestroyed: number;
}

export interface GPUCacheStats {
  readonly label: string;
  readonly owner: GPUResourceOwner;
  readonly entries: number;
  readonly peakEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly hitRate: number;
}

export interface GPUResourceDebugSnapshot {
  readonly enabled: boolean;
  readonly frame: number;
  readonly resources: readonly GPUResourceRecord[];
  readonly byType: Readonly<Partial<Record<GPUTrackedResourceType, GPUResourceTypeStats>>>;
  readonly owners: ReadonlyArray<{ owner: GPUResourceOwner; usage: GPUResourceUsage; resources: number }>;
  readonly caches: readonly GPUCacheStats[];
  /** A non-zero value indicates an ownership invariant violation. */
  readonly releasedOwnerResiduals: number;
}

export interface GPUResourceTrackOptions {
  owner?: GPUResourceOwner;
  label: string;
  estimatedBytes?: number;
}

let ownerId = 0;

export function createGPUResourceOwner(kind: GPUResourceOwnerKind, label: string): GPUResourceOwner {
  return Object.freeze({ kind, label, id: `${kind}:${++ownerId}` });
}

const DEFAULT_OWNER = createGPUResourceOwner('engine', 'unscoped');
const trackerByDevice = new WeakMap<GPUDevice, GPUResourceTracker>();

export function getInstrumentedGPUResourceTracker(device: GPUDevice): GPUResourceTracker | undefined {
  return trackerByDevice.get(device);
}

export class GPUResourceScope {
  readonly owner: GPUResourceOwner;
  private _released = false;

  constructor(
    private readonly _tracker: GPUResourceTracker,
    kind: GPUResourceOwnerKind,
    label: string,
  ) {
    this.owner = createGPUResourceOwner(kind, label);
  }

  get released(): boolean { return this._released; }
  get usage(): GPUResourceUsage { return this._tracker.getUsage(this.owner); }

  trackBuffer(buffer: GPUBuffer, label: string, bytes: number): GPUBuffer {
    this._assertActive();
    return this._tracker.trackBuffer(buffer, { owner: this.owner, label, estimatedBytes: bytes });
  }

  trackTexture(texture: GPUTexture, label: string, bytes: number): GPUTexture {
    this._assertActive();
    return this._tracker.trackTexture(texture, { owner: this.owner, label, estimatedBytes: bytes });
  }

  trackQuerySet(querySet: GPUQuerySet, label: string): GPUQuerySet {
    this._assertActive();
    return this._tracker.trackQuerySet(querySet, { owner: this.owner, label });
  }

  trackSampler(sampler: GPUSampler, label: string): GPUSampler {
    this._assertActive();
    return this._tracker.trackObject(sampler, 'sampler', { owner: this.owner, label });
  }

  trackBindGroup(bindGroup: GPUBindGroup, label: string): GPUBindGroup {
    this._assertActive();
    return this._tracker.trackObject(bindGroup, 'bind-group', { owner: this.owner, label });
  }

  trackRenderPipeline(pipeline: GPURenderPipeline, label: string): GPURenderPipeline {
    this._assertActive();
    return this._tracker.trackObject(pipeline, 'render-pipeline', { owner: this.owner, label });
  }

  release(): void {
    if (this._released) return;
    this._released = true;
    this._tracker.releaseOwner(this.owner);
  }

  private _assertActive(): void {
    if (this._released) {
      throw new EngineError(
        EngineErrorCode.ResourceOwnerReleased,
        `GPU resource scope "${this.owner.label}" has been released.`,
        {
          recovery: ErrorRecovery.ReleaseResource,
          context: { ownerId: this.owner.id, ownerKind: this.owner.kind, ownerLabel: this.owner.label },
        },
      );
    }
  }
}

export class GPUResourceTracker {
  private readonly _resources = new Map<GPUTrackedResource, TrackedResource>();
  private readonly _resourcesByOwner = new Map<GPUResourceOwner, Set<GPUTrackedResource>>();
  private readonly _instrumentedDevices = new WeakSet<GPUDevice>();
  private readonly _instrumentedQueues = new WeakSet<GPUQueue>();
  private readonly _stats = new Map<GPUTrackedResourceType, MutableResourceTypeStats>();
  private readonly _caches = new Map<string, MutableCacheStats>();
  private readonly _releasedOwners = new Set<GPUResourceOwner>();
  private _activeOwner: GPUResourceOwner | null = null;
  private _frame = 0;
  private _nextResourceId = 0;
  readonly debug: boolean;
  readonly captureStacks: boolean;
  private readonly _frameDiagnostics: import('./FrameDiagnostics').FrameDiagnostics | undefined;

  constructor(options: GPUResourceTrackerOptions = {}) {
    this.debug = options.debug === true;
    this.captureStacks = this.debug && options.captureStacks === true;
    this._frameDiagnostics = options.frameDiagnostics;
  }

  beginFrame(frame?: number): void {
    this._frame = frame ?? this._frame + 1;
    for (const stats of this._stats.values()) {
      stats.frameCreated = 0;
      stats.frameDestroyed = 0;
    }
  }

  get frame(): number { return this._frame; }

  createScope(kind: GPUResourceOwnerKind, label: string): GPUResourceScope {
    const scope = new GPUResourceScope(this, kind, label);
    this._releasedOwners.delete(scope.owner);
    return scope;
  }

  withOwner<T>(owner: GPUResourceOwner, action: () => T): T {
    const previous = this.enterOwner(owner);
    try {
      return action();
    } finally {
      this.leaveOwner(previous);
    }
  }

  /** Enters an allocation owner scope without creating a callback closure. */
  enterOwner(owner: GPUResourceOwner): GPUResourceOwner | null {
    const previous = this._activeOwner;
    this._activeOwner = owner;
    return previous;
  }

  /** Restores the token returned by enterOwner(). */
  leaveOwner(previous: GPUResourceOwner | null): void {
    this._activeOwner = previous;
  }

  /**
   * Instruments the allocation entry points on a real GPUDevice. Returned GPU
   * resources remain native objects, so WebGPU brand checks keep working.
   */
  instrumentDevice(device: GPUDevice, owner: GPUResourceOwner): GPUDevice {
    if (this._instrumentedDevices.has(device)) return device;
    const createBuffer = device.createBuffer.bind(device);
    const createTexture = device.createTexture.bind(device);
    const createSampler = typeof device.createSampler === 'function' ? device.createSampler.bind(device) : null;
    const createBindGroup = typeof device.createBindGroup === 'function' ? device.createBindGroup.bind(device) : null;
    const createBindGroupLayout = typeof device.createBindGroupLayout === 'function' ? device.createBindGroupLayout.bind(device) : null;
    const createPipelineLayout = typeof device.createPipelineLayout === 'function' ? device.createPipelineLayout.bind(device) : null;
    const createRenderPipeline = typeof device.createRenderPipeline === 'function' ? device.createRenderPipeline.bind(device) : null;
    const createComputePipeline = typeof device.createComputePipeline === 'function' ? device.createComputePipeline.bind(device) : null;
    const createRenderPipelineAsync = typeof device.createRenderPipelineAsync === 'function' ? device.createRenderPipelineAsync.bind(device) : null;
    const createComputePipelineAsync = typeof device.createComputePipelineAsync === 'function' ? device.createComputePipelineAsync.bind(device) : null;
    const createQuerySet = device.createQuerySet.bind(device);
    const createCommandEncoder = typeof device.createCommandEncoder === 'function' ? device.createCommandEncoder.bind(device) : null;
    try {
      Object.defineProperties(device, {
        createBuffer: {
          configurable: true,
          value: (descriptor: GPUBufferDescriptor): GPUBuffer => {
            const resource = createBuffer(descriptor);
            return this.trackBuffer(resource, {
              owner: this._activeOwner ?? owner,
              label: descriptor.label ?? 'GPUBuffer',
              estimatedBytes: Number(descriptor.size),
            });
          },
        },
        createTexture: {
          configurable: true,
          value: (descriptor: GPUTextureDescriptor): GPUTexture => {
            const resource = createTexture(descriptor);
            return this.trackTexture(resource, {
              owner: this._activeOwner ?? owner,
              label: descriptor.label ?? 'GPUTexture',
              estimatedBytes: estimateTextureBytes(
                descriptor.size as GPUExtent3DStrict,
                descriptor.format,
                descriptor.sampleCount ?? 1,
              ),
            });
          },
        },
        ...(this.debug && createSampler ? { createSampler: {
          configurable: true,
          value: (descriptor: GPUSamplerDescriptor = {}): GPUSampler => this.trackObject(
            createSampler(descriptor),
            'sampler',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUSampler' },
          ),
        } } : {}),
        ...(this.debug && createBindGroup ? { createBindGroup: {
          configurable: true,
          value: (descriptor: GPUBindGroupDescriptor): GPUBindGroup => this.trackObject(
            createBindGroup(descriptor),
            'bind-group',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUBindGroup' },
          ),
        } } : {}),
        ...(this.debug && createBindGroupLayout ? { createBindGroupLayout: {
          configurable: true,
          value: (descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout => this.trackObject(
            createBindGroupLayout(descriptor),
            'bind-group-layout',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUBindGroupLayout' },
          ),
        } } : {}),
        ...(this.debug && createPipelineLayout ? { createPipelineLayout: {
          configurable: true,
          value: (descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout => this.trackObject(
            createPipelineLayout(descriptor),
            'pipeline-layout',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUPipelineLayout' },
          ),
        } } : {}),
        ...(this.debug && createRenderPipeline ? { createRenderPipeline: {
          configurable: true,
          value: (descriptor: GPURenderPipelineDescriptor): GPURenderPipeline => this.trackObject(
            createRenderPipeline(descriptor),
            'render-pipeline',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPURenderPipeline' },
          ),
        } } : {}),
        ...(this.debug && createComputePipeline ? { createComputePipeline: {
          configurable: true,
          value: (descriptor: GPUComputePipelineDescriptor): GPUComputePipeline => this.trackObject(
            createComputePipeline(descriptor),
            'compute-pipeline',
            { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUComputePipeline' },
          ),
        } } : {}),
        ...(this.debug && createRenderPipelineAsync ? { createRenderPipelineAsync: {
          configurable: true,
          value: async (descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> => {
            const resourceOwner = this._activeOwner ?? owner;
            return this.trackObject(await createRenderPipelineAsync(descriptor), 'render-pipeline', {
              owner: resourceOwner,
              label: descriptor.label ?? 'GPURenderPipeline',
            });
          },
        } } : {}),
        ...(this.debug && createComputePipelineAsync ? { createComputePipelineAsync: {
          configurable: true,
          value: async (descriptor: GPUComputePipelineDescriptor): Promise<GPUComputePipeline> => {
            const resourceOwner = this._activeOwner ?? owner;
            return this.trackObject(await createComputePipelineAsync(descriptor), 'compute-pipeline', {
              owner: resourceOwner,
              label: descriptor.label ?? 'GPUComputePipeline',
            });
          },
        } } : {}),
        createQuerySet: {
          configurable: true,
          value: (descriptor: GPUQuerySetDescriptor): GPUQuerySet => {
            const resource = createQuerySet(descriptor);
            return this.trackQuerySet(resource, { owner: this._activeOwner ?? owner, label: descriptor.label ?? 'GPUQuerySet' });
          },
        },
        ...(createCommandEncoder ? { createCommandEncoder: {
          configurable: true,
          value: (descriptor?: GPUCommandEncoderDescriptor): GPUCommandEncoder => this._instrumentCommandEncoder(
            createCommandEncoder(descriptor),
          ),
        } } : {}),
      });
      this._instrumentQueue(device.queue);
      this._instrumentedDevices.add(device);
      trackerByDevice.set(device, this);
    } catch (error) {
      throw new EngineError(
        EngineErrorCode.EngineInvalidState,
        'GPUDevice allocation entry points cannot be instrumented for resource ownership.',
        {
          recovery: ErrorRecovery.TerminateRuntime,
          context: { ownerId: owner.id, ownerLabel: owner.label },
          cause: error,
        },
      );
    }
    return device;
  }

  trackBuffer(buffer: GPUBuffer, label: string, bytes: number, owner?: GPUResourceOwner): GPUBuffer;
  trackBuffer(buffer: GPUBuffer, options: GPUResourceTrackOptions): GPUBuffer;
  trackBuffer(
    buffer: GPUBuffer,
    labelOrOptions: string | GPUResourceTrackOptions,
    bytes = 0,
    owner = DEFAULT_OWNER,
  ): GPUBuffer {
    const options = normalizeTrackOptions(labelOrOptions, bytes, owner);
    this._track(buffer, 'buffer', options);
    return buffer;
  }

  trackTexture(texture: GPUTexture, label: string, bytes: number, owner?: GPUResourceOwner): GPUTexture;
  trackTexture(texture: GPUTexture, options: GPUResourceTrackOptions): GPUTexture;
  trackTexture(
    texture: GPUTexture,
    labelOrOptions: string | GPUResourceTrackOptions,
    bytes = 0,
    owner = DEFAULT_OWNER,
  ): GPUTexture {
    const options = normalizeTrackOptions(labelOrOptions, bytes, owner);
    this._track(texture, 'texture', options);
    return texture;
  }

  trackQuerySet(querySet: GPUQuerySet, options: GPUResourceTrackOptions): GPUQuerySet {
    this._track(querySet, 'query-set', normalizeTrackOptions(options, 0, DEFAULT_OWNER));
    return querySet;
  }

  trackObject<T extends GPUTrackedResource>(
    resource: T,
    type: Exclude<GPUTrackedResourceType, 'buffer' | 'texture' | 'query-set'>,
    options: GPUResourceTrackOptions,
  ): T {
    this._track(resource, type, normalizeTrackOptions(options, 0, DEFAULT_OWNER));
    return resource;
  }

  markUsed(resource: GPUTrackedResource): void {
    const record = this._resources.get(resource);
    if (record) record.lastUsedFrame = this._frame;
  }

  recordCacheAccess(label: string, hit: boolean, options: { owner?: GPUResourceOwner; entries?: number } = {}): void {
    if (!this.debug) return;
    const owner = options.owner ?? this._activeOwner ?? DEFAULT_OWNER;
    const key = `${owner.id}:${label}`;
    let stats = this._caches.get(key);
    if (!stats) {
      stats = { label, owner, entries: 0, peakEntries: 0, hits: 0, misses: 0 };
      this._caches.set(key, stats);
    }
    if (hit) stats.hits++;
    else stats.misses++;
    if (options.entries !== undefined) {
      stats.entries = Math.max(0, Math.trunc(options.entries));
      stats.peakEntries = Math.max(stats.peakEntries, stats.entries);
    }
  }

  untrackBuffer(buffer: GPUBuffer): void { this._untrack(buffer); }
  untrackTexture(texture: GPUTexture): void { this._untrack(texture); }
  untrackQuerySet(querySet: GPUQuerySet): void { this._untrack(querySet); }
  untrackObject(resource: GPUTrackedResource): void { this._untrack(resource); }

  releaseOwner(owner: GPUResourceOwner): void {
    const resources = this._resourcesByOwner.get(owner);
    this._releasedOwners.add(owner);
    if (!resources) return;
    for (const resource of [...resources]) this._destroyAndUntrack(resource);
    this._resourcesByOwner.delete(owner);
  }

  releaseAll(): void {
    for (const resource of [...this._resources.keys()]) this._destroyAndUntrack(resource);
    this._resourcesByOwner.clear();
  }

  getUsage(owner?: GPUResourceOwner): GPUResourceUsage {
    const usage: GPUResourceUsage = { buffers: 0, textures: 0, querySets: 0, estimatedBytes: 0 };
    if (owner) {
      for (const resource of this._resourcesByOwner.get(owner) ?? []) {
        const record = this._resources.get(resource);
        if (record) addUsage(usage, record);
      }
    } else {
      for (const record of this._resources.values()) addUsage(usage, record);
    }
    return usage;
  }

  getResources(owner?: GPUResourceOwner): readonly GPUResourceRecord[] {
    const resources = owner ? this._resourcesByOwner.get(owner) ?? [] : this._resources.keys();
    const records: GPUResourceRecord[] = [];
    for (const resource of resources) {
      const record = this._resources.get(resource);
      if (!record) continue;
      records.push({
        id: record.id,
        owner: record.owner,
        label: record.label,
        type: record.type,
        estimatedBytes: record.estimatedBytes,
        createdAtFrame: record.createdAtFrame,
        lastUsedFrame: record.lastUsedFrame,
        ...(record.creationStack ? { creationStack: record.creationStack } : {}),
      });
    }
    return records;
  }

  getOwnerUsages(): ReadonlyArray<{ owner: GPUResourceOwner; usage: GPUResourceUsage }> {
    return [...this._resourcesByOwner.keys()].map(owner => ({ owner, usage: this.getUsage(owner) }));
  }

  getDebugSnapshot(): GPUResourceDebugSnapshot {
    const byType: Partial<Record<GPUTrackedResourceType, GPUResourceTypeStats>> = {};
    for (const [type, stats] of this._stats) byType[type] = Object.freeze({ ...stats });
    const caches = [...this._caches.values()].map(stats => {
      const total = stats.hits + stats.misses;
      return Object.freeze({ ...stats, hitRate: total === 0 ? 0 : stats.hits / total });
    });
    let releasedOwnerResiduals = 0;
    for (const owner of this._releasedOwners) releasedOwnerResiduals += this._resourcesByOwner.get(owner)?.size ?? 0;
    return Object.freeze({
      enabled: this.debug,
      frame: this._frame,
      resources: this.debug ? Object.freeze([...this.getResources()]) : Object.freeze([]),
      byType: Object.freeze(byType),
      owners: Object.freeze(this.getOwnerUsages().map(({ owner, usage }) => Object.freeze({
        owner,
        usage: Object.freeze({ ...usage }),
        resources: this._resourcesByOwner.get(owner)?.size ?? 0,
      }))),
      caches: Object.freeze(caches),
      releasedOwnerResiduals,
    });
  }

  reset(): void {
    this.releaseAll();
  }

  private _track(
    resource: GPUTrackedResource,
    type: GPUTrackedResourceType,
    options: Required<Pick<GPUResourceTrackOptions, 'label' | 'owner'>> & { estimatedBytes: number },
  ): void {
    if (this._resources.has(resource)) this._untrack(resource);
    const record: TrackedResource = {
      id: ++this._nextResourceId,
      resource,
      type,
      owner: options.owner,
      label: options.label,
      estimatedBytes: Math.max(0, options.estimatedBytes),
      createdAtFrame: this._frame,
      lastUsedFrame: this._frame,
      ...(this.captureStacks ? { creationStack: captureCreationStack() } : {}),
    };
    this._resources.set(resource, record);
    let owned = this._resourcesByOwner.get(record.owner);
    if (!owned) {
      owned = new Set();
      this._resourcesByOwner.set(record.owner, owned);
    }
    owned.add(resource);
    const stats = this._getTypeStats(type);
    stats.current++;
    stats.created++;
    stats.frameCreated++;
    stats.estimatedBytes += record.estimatedBytes;
    stats.peak = Math.max(stats.peak, stats.current);
    stats.peakEstimatedBytes = Math.max(stats.peakEstimatedBytes, stats.estimatedBytes);
    if (isDestroyableResource(resource)) this._instrumentDestroy(resource);
  }

  private _untrack(resource: GPUTrackedResource): void {
    const record = this._resources.get(resource);
    if (!record) return;
    this._resources.delete(resource);
    const owned = this._resourcesByOwner.get(record.owner);
    owned?.delete(resource);
    if (owned?.size === 0) this._resourcesByOwner.delete(record.owner);
    const stats = this._getTypeStats(record.type);
    stats.current = Math.max(0, stats.current - 1);
    stats.destroyed++;
    stats.frameDestroyed++;
    stats.estimatedBytes = Math.max(0, stats.estimatedBytes - record.estimatedBytes);
  }

  private _destroyAndUntrack(resource: GPUTrackedResource): void {
    this._untrack(resource);
    if (!isDestroyableResource(resource)) return;
    try {
      resource.destroy();
    } catch {
      // Lost devices and already-destroyed resources are safe to release again.
    }
  }

  private _instrumentDestroy(resource: GPUBuffer | GPUTexture | GPUQuerySet): void {
    const marker = resource as GPUBuffer & { __haiyueTrackedDestroy?: boolean };
    if (marker.__haiyueTrackedDestroy) return;
    const destroy = resource.destroy.bind(resource);
    try {
      Object.defineProperties(resource, {
        __haiyueTrackedDestroy: { configurable: true, value: true },
        destroy: {
          configurable: true,
          value: () => {
            this._untrack(resource);
            destroy();
          },
        },
      });
    } catch {
      // Owner release remains the fallback for non-extensible WebGPU wrappers.
    }
  }

  private _getTypeStats(type: GPUTrackedResourceType): MutableResourceTypeStats {
    let stats = this._stats.get(type);
    if (!stats) {
      stats = {
        current: 0,
        created: 0,
        destroyed: 0,
        peak: 0,
        estimatedBytes: 0,
        peakEstimatedBytes: 0,
        frameCreated: 0,
        frameDestroyed: 0,
      };
      this._stats.set(type, stats);
    }
    return stats;
  }

  private _instrumentQueue(queue: GPUQueue): void {
    if (!this._frameDiagnostics?.enabled || this._instrumentedQueues.has(queue)) return;
    const writeBuffer = queue.writeBuffer.bind(queue);
    try {
      Object.defineProperty(queue, 'writeBuffer', {
        configurable: true,
        value: (...args: Parameters<GPUQueue['writeBuffer']>): void => {
          const source = args[2];
          const sourceOffset = args[3] ?? 0;
          const explicitSize = args[4];
          const sourceBytes = ArrayBuffer.isView(source) ? source.byteLength : source.byteLength;
          const bytes = explicitSize ?? Math.max(0, sourceBytes - sourceOffset);
          this._frameDiagnostics?.increment('bufferUploads');
          this._frameDiagnostics?.increment('bufferUploadBytes', bytes);
          writeBuffer(...args);
        },
      });
      this._instrumentedQueues.add(queue);
    } catch {
      // Diagnostics may be unavailable on non-extensible native wrappers.
    }
  }

  private _instrumentCommandEncoder(encoder: GPUCommandEncoder): GPUCommandEncoder {
    if (!this._frameDiagnostics?.enabled) return encoder;
    const beginRenderPass = typeof encoder.beginRenderPass === 'function' ? encoder.beginRenderPass.bind(encoder) : null;
    const beginComputePass = typeof encoder.beginComputePass === 'function' ? encoder.beginComputePass.bind(encoder) : null;
    try {
      Object.defineProperties(encoder, {
        ...(beginRenderPass ? { beginRenderPass: {
          configurable: true,
          value: (descriptor: GPURenderPassDescriptor): GPURenderPassEncoder => this._instrumentRenderPass(beginRenderPass(descriptor)),
        } } : {}),
        ...(beginComputePass ? { beginComputePass: {
          configurable: true,
          value: (descriptor?: GPUComputePassDescriptor): GPUComputePassEncoder => this._instrumentComputePass(beginComputePass(descriptor)),
        } } : {}),
      });
    } catch {
      // Pass counters remain best effort; render pipeline pass planning is still exact.
    }
    return encoder;
  }

  private _instrumentRenderPass(pass: GPURenderPassEncoder): GPURenderPassEncoder {
    this._instrumentCounterMethod(pass, 'draw', 'draws');
    this._instrumentCounterMethod(pass, 'drawIndexed', 'draws');
    this._instrumentCounterMethod(pass, 'drawIndirect', 'draws');
    this._instrumentCounterMethod(pass, 'drawIndexedIndirect', 'draws');
    this._instrumentCounterMethod(pass, 'setPipeline', 'pipelineSwitches');
    return pass;
  }

  private _instrumentComputePass(pass: GPUComputePassEncoder): GPUComputePassEncoder {
    this._instrumentCounterMethod(pass, 'dispatchWorkgroups', 'dispatches');
    this._instrumentCounterMethod(pass, 'dispatchWorkgroupsIndirect', 'dispatches');
    this._instrumentCounterMethod(pass, 'setPipeline', 'pipelineSwitches');
    return pass;
  }

  private _instrumentCounterMethod(target: object, key: string, counter: import('./FrameDiagnostics').FrameMetricCounter): void {
    const method = (target as Record<string, unknown>)[key];
    if (typeof method !== 'function') return;
    const bound = method.bind(target) as (...args: unknown[]) => unknown;
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        value: (...args: unknown[]): unknown => {
          this._frameDiagnostics?.increment(counter);
          return bound(...args);
        },
      });
    } catch {
      // Some browser implementations expose non-configurable pass methods.
    }
  }
}

function addUsage(usage: GPUResourceUsage, record: GPUResourceRecord): void {
  if (record.type === 'buffer') usage.buffers++;
  else if (record.type === 'texture') usage.textures++;
  else if (record.type === 'query-set') usage.querySets++;
  usage.estimatedBytes += record.estimatedBytes;
}

function isDestroyableResource(resource: GPUTrackedResource): resource is GPUBuffer | GPUTexture | GPUQuerySet {
  return typeof (resource as { destroy?: unknown }).destroy === 'function';
}

function captureCreationStack(): string | undefined {
  const stack = new Error('GPU resource created').stack;
  return stack?.split('\n').slice(2).join('\n');
}

function normalizeTrackOptions(
  labelOrOptions: string | GPUResourceTrackOptions,
  bytes: number,
  owner: GPUResourceOwner,
): Required<Pick<GPUResourceTrackOptions, 'label' | 'owner'>> & { estimatedBytes: number } {
  return typeof labelOrOptions === 'string'
    ? { label: labelOrOptions, estimatedBytes: bytes, owner }
    : {
        label: labelOrOptions.label,
        estimatedBytes: labelOrOptions.estimatedBytes ?? 0,
        owner: labelOrOptions.owner ?? DEFAULT_OWNER,
      };
}

export function estimateTextureBytes(size: GPUExtent3DStrict, format: GPUTextureFormat, sampleCount = 1): number {
  const extent = size as Iterable<number> | { width: number; height?: number; depthOrArrayLayers?: number };
  const [width = 1, height = 1, depthOrArrayLayers = 1] = Symbol.iterator in Object(extent)
    ? [...extent as Iterable<number>]
    : [(extent as { width: number }).width, (extent as { height?: number }).height ?? 1, (extent as { depthOrArrayLayers?: number }).depthOrArrayLayers ?? 1];
  return Math.max(1, width) * Math.max(1, height) * Math.max(1, depthOrArrayLayers) * bytesPerPixel(format) * Math.max(1, sampleCount);
}

function bytesPerPixel(format: GPUTextureFormat): number {
  switch (format) {
    case 'r8unorm':
    case 'r8snorm':
    case 'r8uint':
    case 'r8sint':
      return 1;
    case 'r16uint':
    case 'r16sint':
    case 'r16float':
    case 'rg8unorm':
    case 'rg8snorm':
    case 'rg8uint':
    case 'rg8sint':
      return 2;
    case 'rgba16uint':
    case 'rgba16sint':
    case 'rgba16float':
    case 'rg32uint':
    case 'rg32sint':
    case 'rg32float':
      return 8;
    case 'rgba32uint':
    case 'rgba32sint':
    case 'rgba32float':
      return 16;
    default:
      return 4;
  }
}
import { EngineError, EngineErrorCode, ErrorRecovery } from './EngineError';
