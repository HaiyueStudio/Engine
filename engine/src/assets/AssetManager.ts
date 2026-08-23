import type { GPUResourceOwner, GPUResourceScope, GPUResourceTracker } from '../core/GPUResourceTracker';
import { EngineError, EngineErrorCode, ErrorRecovery } from '../core/EngineError';
import { isRecoverableGpuResource, type AssetJobState } from '../core/Lifecycle';
import { createKtx2TextureLoader } from './Ktx2TextureLoader';
import type { AssetWorkerClient } from './AssetWorkerClient';
import { AssetJob, type AssetJobOptions, type AssetJobProgress, type AssetJobPriority, type AssetOwnerScope } from './AssetJob';
import { AssetCacheHierarchy, type AssetCacheHierarchyOptions, type AssetCacheSnapshot } from './AssetCache';
import { AssetUploadScheduler, type AssetUploadSchedulerSnapshot, type AssetUploadTask } from './AssetUploadScheduler';
import { uploadImageTexture, type TextureMipmapMode } from './ImageTextureUpload';

export type { TextureMipmapMode } from './ImageTextureUpload';

export interface AssetHandle<T> {
  readonly key: string;
  readonly value: T;
  release(): void;
}

export interface TextureAssetOptions {
  label?: string;
  format?: GPUTextureFormat;
  /** Ordinary images default to `none`; compressed textures always use their source mip chain. */
  mipmaps?: TextureMipmapMode;
  /** Stores filtered texels as premultiplied alpha for renderers whose blend contract requires it. */
  premultipliedAlpha?: boolean;
  /**
   * Stable logical identity for sources whose runtime URL/object identity is temporary.
   * The manager still separates ordinary textures by format and mip policy.
   */
  cacheKey?: string;
  signal?: AbortSignal | undefined;
}

export interface CompressedTextureSourceDescriptor {
  kind: 'compressed-texture';
  type: 'texture/ktx2' | string;
  src: string;
}

export interface AssetManagerOptions {
  texture?: TextureAssetOptions;
  worker?: AssetWorkerClient | null;
  cache?: AssetCacheHierarchyOptions;
  uploadBudgetBytes?: number;
  defaultTimeoutMs?: number;
}

export interface AssetLoaderContext {
  manager: AssetManager;
  device: GPUDevice;
  tracker?: GPUResourceTracker | undefined;
  resourceOwner?: GPUResourceOwner | undefined;
  worker?: AssetWorkerClient | undefined;
  cache: AssetCacheHierarchy;
  signal: AbortSignal;
  setPhase(phase: Extract<AssetJobState, 'loading' | 'parsing' | 'uploading'>): void;
  reportProgress(loaded: number, total?: number | null): void;
  scheduleUpload<T>(task: AssetUploadTask<T>): Promise<T>;
}

export interface AssetLoaderRegistration<T = unknown> {
  type: string;
  extensions?: readonly string[];
  mimeTypes?: readonly string[];
  aliases?: readonly string[];
  match?: (url: string, request: AssetLookupRequest) => boolean;
  load(url: string, context: AssetLoaderContext): Promise<T>;
  dispose?: (asset: T) => void;
}

export interface AssetLookupRequest {
  url: string;
  extension: string | null;
  mimeType?: string | undefined;
  alias?: string | undefined;
}

export interface AssetManagerDebugSnapshot {
  readonly acceptingLoads: boolean;
  readonly disposed: boolean;
  readonly records: ReadonlyArray<Readonly<{
    key: string;
    state: AssetJobState;
    refs: number;
    hasValue: boolean;
    hasError: boolean;
    priority: number;
    progress: AssetJobProgress | null;
  }>>;
  readonly caches: readonly AssetCacheSnapshot[];
  readonly uploads: AssetUploadSchedulerSnapshot;
  readonly activity: Readonly<{
    recordHits: number;
    recordMisses: number;
  }>;
}

export interface AssetLoadOptions<T> extends Omit<AssetJobOptions<T>, 'disposeLateResult'> {
  signal?: AbortSignal | undefined;
  /** Retains the CPU descriptor and rebuild callback across device loss. */
  recovery?: {
    label: string;
    source: unknown;
    load(signal: AbortSignal): Promise<T>;
  };
}

type TextureAssetSource = string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | CompressedTextureSourceDescriptor;
type AssetLoadPhase = Extract<AssetJobState, 'loading' | 'parsing' | 'uploading'>;

interface AssetRecord<T> {
  key: string;
  refs: number;
  promise: Promise<T>;
  value: T | null;
  error: unknown;
  dispose: (value: T) => void;
  controller: AbortController | null;
  job: AssetJob<T> | null;
  scope: GPUResourceScope | null;
  recovery: AssetLoadOptions<T>['recovery'];
}

export class AssetManager {
  private readonly _records = new Map<string, AssetRecord<unknown>>();
  private readonly _loaders = new Map<string, AssetLoaderRegistration>();
  private readonly _loaderAliases = new Map<string, string>();
  private readonly _loaderTypesByExtension = new Map<string, string>();
  private readonly _loaderTypesByMime = new Map<string, string>();
  private readonly _assetAliases = new Map<string, string>();
  private readonly _objectKeys = new WeakMap<object, string>();
  private _nextObjectKey = 0;
  private _disposed = false;
  private _acceptingLoads = true;
  private _recoveryLoadDepth = 0;
  private _device: GPUDevice;
  readonly cache: AssetCacheHierarchy;
  readonly uploads: AssetUploadScheduler;
  private _uploadDrainScheduled = false;
  private _recordHits = 0;
  private _recordMisses = 0;

  constructor(
    device: GPUDevice,
    private readonly _tracker?: GPUResourceTracker,
    private readonly _options: AssetManagerOptions = {},
  ) {
    this._device = device;
    this.cache = new AssetCacheHierarchy(_options.cache);
    this.uploads = new AssetUploadScheduler(_options.uploadBudgetBytes ?? 8 * 1024 * 1024);
    this.registerLoader(createKtx2TextureLoader());
  }

  getDebugSnapshot(): AssetManagerDebugSnapshot {
    return Object.freeze({
      acceptingLoads: this._acceptingLoads,
      disposed: this._disposed,
      records: Object.freeze([...this._records.values()].map(record => Object.freeze({
        key: record.key,
        state: getRecordState(record),
        refs: record.refs,
        hasValue: record.value !== null,
        hasError: record.error !== null,
        priority: record.job?.priority ?? 0,
        progress: record.job?.progress ?? null,
      }))),
      caches: this.cache.snapshot(this._device),
      uploads: this.uploads.snapshot(),
      activity: Object.freeze({
        recordHits: this._recordHits,
        recordMisses: this._recordMisses,
      }),
    });
  }

  load<T>(
    key: string,
    loader: (signal?: AbortSignal) => Promise<T>,
    dispose: (value: T) => void,
    options: AssetLoadOptions<T> = {},
  ): Promise<AssetHandle<T>> {
    this._assertCanLoad();
    if (options.signal?.aborted) return Promise.reject(this._abortError(key, options.signal.reason));

    let record = this._records.get(key) as AssetRecord<T> | undefined;
    if (!record) {
      this._recordMisses++;
      record = {
        key,
        refs: 0,
        promise: Promise.resolve(null as T),
        value: null,
        error: null,
        dispose,
        controller: null,
        job: null,
        scope: null,
        recovery: options.recovery,
      };
      this._records.set(key, record as AssetRecord<unknown>);
      this._startRecord(record, signal => loader(signal), options);
    } else {
      this._recordHits++;
    }

    record.refs++;
    const requestSignal = combineRequestSignals(options.signal, options.owner?.signal);
    const unsubscribe = options.onProgress && record.job ? record.job.onProgress(options.onProgress) : null;
    return waitForRecord(record.promise, requestSignal).then(
      () => {
        unsubscribe?.();
        const state = getRecordState(record!);
        if (this._disposed || state === 'released' || state === 'aborted') {
          throw new EngineError(
            state === 'aborted' ? EngineErrorCode.AssetJobAborted : EngineErrorCode.AssetDisposed,
            `Asset is unavailable after loading: ${key}`,
            { context: { key, jobState: state } },
          );
        }
        return this._createHandle(record!);
      },
      error => {
        unsubscribe?.();
        this._releaseRecord(record!);
        throw error;
      },
    );
  }

  loadTexture(source: TextureAssetSource, options: TextureAssetOptions = {}): Promise<AssetHandle<GPUTexture>> {
    if (isCompressedTextureSource(source)) {
      const key = options.cacheKey === undefined
        ? null
        : `texture:compressed:identity:${source.type}:${options.cacheKey}`;
      if (key === null) return this.loadAsset<GPUTexture>(source.type, source.src, { signal: options.signal });
      let dependency: AssetHandle<GPUTexture> | null = null;
      return this.load(
        key,
        async signal => {
          dependency = await this.loadAsset<GPUTexture>(source.type, source.src, { signal });
          return dependency.value;
        },
        () => {
          dependency?.release();
          dependency = null;
        },
        {
          signal: options.signal,
          recovery: {
            label: key,
            source: { ...source, cacheKey: options.cacheKey },
            load: async signal => {
              dependency?.release();
              dependency = await this.loadAsset<GPUTexture>(source.type, source.src, { signal });
              return dependency.value;
            },
          },
        },
      );
    }
    const format = options.format ?? this._options.texture?.format ?? 'rgba8unorm';
    const mipmaps = options.mipmaps ?? this._options.texture?.mipmaps ?? 'none';
    const premultipliedAlpha = options.premultipliedAlpha ?? this._options.texture?.premultipliedAlpha ?? false;
    const key = this._textureKey(source, format, mipmaps, premultipliedAlpha, options.cacheKey);
    const label = options.label ?? key;
    const create = (signal: AbortSignal) => this._createTexture(source, format, mipmaps, premultipliedAlpha, label, signal, key);
    return this.load(key, signal => create(signal!), texture => this._destroyTexture(texture), {
      signal: options.signal,
      recovery: {
        label,
        source: typeof source === 'string'
          ? { kind: 'url-texture', url: source, format, mipmaps, premultipliedAlpha }
          : { kind: 'image-source', source, format, mipmaps, premultipliedAlpha },
        load: create,
      },
    });
  }

  setAsset<T>(key: string, value: T, dispose: (value: T) => void = () => {}): AssetHandle<T> {
    this._assertCanLoad();
    const existing = this._records.get(key);
    if (existing) this._releaseImmediately(existing);
    const record: AssetRecord<T> = {
      key,
      refs: 1,
      promise: Promise.resolve(value),
      value,
      error: null,
      dispose,
      controller: null,
      job: createReadyAssetJob(key),
      scope: null,
      recovery: isRecoverableGpuResource(value)
        ? {
            label: value.recoveryLabel,
            source: value.recoverySource,
            load: async signal => {
              await value.recoverGpuResource(this._device, signal);
              return value;
            },
          }
        : undefined,
    };
    this._records.set(key, record as AssetRecord<unknown>);
    return this._createHandle(record);
  }

  getAsset<T>(key: string): AssetHandle<T> | null {
    const record = this._records.get(this.resolveAssetKey(key)) as AssetRecord<T> | undefined;
    if (!record || getRecordState(record) !== 'ready' || record.value === null) return null;
    record.refs++;
    return this._createHandle(record);
  }

  hasAsset(key: string): boolean { return this._records.has(this.resolveAssetKey(key)); }

  getJobState(key: string): AssetJobState | null {
    const record = this._records.get(this.resolveAssetKey(key));
    return record ? getRecordState(record) : null;
  }

  getRefCount(key: string): number { return this._records.get(this.resolveAssetKey(key))?.refs ?? 0; }
  getError(key: string): unknown { return this._records.get(this.resolveAssetKey(key))?.error ?? null; }
  get pendingJobCount(): number {
    let count = 0;
    for (const record of this._records.values()) {
      if (isPending(getRecordState(record))) count++;
    }
    return count;
  }

  deleteAsset(key: string): boolean {
    const resolvedKey = this.resolveAssetKey(key);
    const record = this._records.get(resolvedKey);
    if (!record) return false;
    this._records.delete(resolvedKey);
    this._releaseImmediately(record);
    return true;
  }

  registerLoader<T>(registration: AssetLoaderRegistration<T>): this {
    this.unregisterLoader(registration.type);
    this._loaders.set(registration.type, registration as AssetLoaderRegistration);
    for (const alias of registration.aliases ?? []) this._loaderAliases.set(normalizeLoaderKey(alias), registration.type);
    for (const extension of registration.extensions ?? []) this._loaderTypesByExtension.set(normalizeExtension(extension), registration.type);
    for (const mimeType of registration.mimeTypes ?? []) this._loaderTypesByMime.set(normalizeLoaderKey(mimeType), registration.type);
    return this;
  }

  unregisterLoader(type: string): this {
    const resolvedType = this.resolveTypeAlias(type);
    const registration = this._loaders.get(resolvedType);
    this._loaders.delete(resolvedType);
    if (registration) {
      for (const [alias, loaderType] of this._loaderAliases) if (loaderType === resolvedType) this._loaderAliases.delete(alias);
      for (const [extension, loaderType] of this._loaderTypesByExtension) if (loaderType === resolvedType) this._loaderTypesByExtension.delete(extension);
      for (const [mimeType, loaderType] of this._loaderTypesByMime) if (loaderType === resolvedType) this._loaderTypesByMime.delete(mimeType);
    }
    return this;
  }

  hasLoader(type: string): boolean { return this._loaders.has(this.resolveTypeAlias(type)); }
  getRegisteredTypes(): string[] { return [...this._loaders.keys()]; }
  getRegisteredAliases(): Record<string, string> { return Object.fromEntries(this._loaderAliases); }
  resolveTypeAlias(typeOrAlias: string): string { return this._loaderAliases.get(normalizeLoaderKey(typeOrAlias)) ?? typeOrAlias; }

  resolveType(url: string, options: { mimeType?: string | undefined; alias?: string | undefined } = {}): string | null {
    const aliasType = options.alias ? this._loaderAliases.get(normalizeLoaderKey(options.alias)) : undefined;
    if (aliasType) return aliasType;
    const mimeType = options.mimeType ? normalizeLoaderKey(options.mimeType) : null;
    if (mimeType) {
      const match = this._loaderTypesByMime.get(mimeType);
      if (match) return match;
    }
    const request: AssetLookupRequest = { url, extension: getUrlExtension(url), mimeType: options.mimeType, alias: options.alias };
    if (request.extension) {
      const match = this._loaderTypesByExtension.get(request.extension);
      if (match) return match;
    }
    for (const registration of this._loaders.values()) if (registration.match?.(url, request)) return registration.type;
    return null;
  }

  setAlias(alias: string, key: string): this { this._assetAliases.set(alias, key); return this; }
  removeAlias(alias: string): boolean { return this._assetAliases.delete(alias); }
  resolveAssetKey(keyOrAlias: string): string {
    let current = keyOrAlias;
    const seen = new Set<string>();
    while (this._assetAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this._assetAliases.get(current)!;
    }
    return current;
  }
  getAliasTarget(alias: string): string | undefined { return this._assetAliases.get(alias); }

  loadAsset<T>(type: string, url: string, options: Omit<AssetLoadOptions<T>, 'recovery'> = {}): Promise<AssetHandle<T>> {
    const resolvedType = this.resolveTypeAlias(type);
    const loader = this._loaders.get(resolvedType) as AssetLoaderRegistration<T> | undefined;
    if (!loader) {
      throw new EngineError(
        EngineErrorCode.AssetLoadFailed,
        `No asset loader is registered for type "${type}".`,
        { hint: 'Register an asset loader through AssetManager.registerLoader(...) or an engine plugin.' },
      );
    }
    const key = `asset:${resolvedType}:${url}`;
    const load = (signal: AbortSignal) => loader.load(url, this._createLoaderContext(key, signal));
    return this.load(key, signal => load(signal!), asset => loader.dispose?.(asset), {
      ...options,
      recovery: { label: key, source: { type: resolvedType, url }, load },
    });
  }

  loadUrl<T>(url: string, options: {
    type?: string | undefined;
    mimeType?: string | undefined;
    alias?: string | undefined;
    signal?: AbortSignal | undefined;
    priority?: AssetJobPriority | number;
    timeoutMs?: number;
    owner?: AssetOwnerScope;
    onProgress?: (progress: AssetJobProgress) => void;
  } = {}): Promise<AssetHandle<T>> {
    const type = options.type ? this.resolveTypeAlias(options.type) : this.resolveType(url, options);
    if (!type) {
      throw new EngineError(
        EngineErrorCode.AssetLoadFailed,
        `No asset loader can be inferred for "${url}".`,
        { hint: 'Register a loader, pass an explicit type, or use loadTexture() for browser image textures.' },
      );
    }
    const promise = this.loadAsset<T>(type, url, options);
    if (options.alias) this.setAlias(options.alias, `asset:${type}:${url}`);
    return promise;
  }

  suspendForDeviceLoss(): void {
    if (this._disposed || !this._acceptingLoads) return;
    this._acceptingLoads = false;
    this.uploads.abortAll('device-lost');
    this.cache.releaseDevice(this._device);
    for (const record of this._records.values()) {
      record.controller?.abort('device-lost');
      if (getRecordState(record) === 'ready' && record.recovery && record.value !== null) {
        record.dispose(record.value);
        record.scope?.release();
        record.scope = null;
        record.value = null;
        record.job?.release();
        record.job = new AssetJob(record.key);
      }
    }
  }

  async recoverDevice(device: GPUDevice, signal: AbortSignal): Promise<readonly string[]> {
    if (this._disposed) return ['AssetManager'];
    this._device = device;
    const failed: string[] = [];
    const pending: Promise<unknown>[] = [];
    for (const record of this._records.values()) {
      if (record.refs === 0 || getRecordState(record) !== 'queued') continue;
      if (!record.recovery) {
        failed.push(record.key);
        continue;
      }
      this._recoveryLoadDepth++;
      try {
        this._startRecord(record, record.recovery.load, { signal });
      } finally {
        this._recoveryLoadDepth--;
      }
      pending.push(record.promise.catch(() => { failed.push(record.key); }));
    }
    await Promise.all(pending);
    this._acceptingLoads = failed.length === 0 && !signal.aborted;
    return failed;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._acceptingLoads = false;
    for (const record of this._records.values()) this._releaseImmediately(record);
    this._records.clear();
    this._loaders.clear();
    this._loaderAliases.clear();
    this._loaderTypesByExtension.clear();
    this._loaderTypesByMime.clear();
    this._assetAliases.clear();
    this.uploads.abortAll('asset-manager-disposed');
    this.cache.clear();
  }

  abortAll(reason: unknown = 'asset-manager-abort-all'): void {
    for (const record of this._records.values()) {
      if (isPending(getRecordState(record))) record.job?.abort(reason);
      record.controller?.abort(reason);
    }
    this.uploads.abortAll(reason);
  }

  async drainUploadBudget(budgetBytes = this.uploads.frameBudgetBytes): Promise<number> {
    return await this.uploads.drainFrame(budgetBytes);
  }

  get size(): number { return this._records.size; }

  private _startRecord<T>(record: AssetRecord<T>, loader: (signal: AbortSignal) => Promise<T>, options: AssetLoadOptions<T> = {}): void {
    const job = new AssetJob<T>(record.key, {
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      timeoutMs: options.timeoutMs ?? this._options.defaultTimeoutMs ?? 30000,
      disposeLateResult: record.dispose,
    });
    const controller = job.controller;
    record.job = job;
    record.controller = controller;
    record.error = null;
    record.scope = this._tracker?.createScope('asset', record.recovery?.label ?? record.key) ?? null;
    record.promise = job.start(async () => await loader(controller.signal));
    record.promise.then(
      value => {
        record.controller = null;
        if (this._disposed || controller.signal.aborted || record.refs === 0) {
          record.dispose(value);
          record.scope?.release();
          record.scope = null;
          record.job?.release();
          if (this._records.get(record.key) === record) this._records.delete(record.key);
          return;
        }
        record.value = value;
      },
      error => {
        record.controller = null;
        record.scope?.release();
        record.scope = null;
        record.error = controller.signal.aborted ? this._abortError(record.key, controller.signal.reason) : error;
        if (this._records.get(record.key) === record && record.refs === 0) this._records.delete(record.key);
      },
    );
    record.promise = record.promise.catch(error => {
      if (controller.signal.aborted) throw this._abortError(record.key, controller.signal.reason);
      throw error;
    });
  }

  private _createLoaderContext(key: string, signal: AbortSignal): AssetLoaderContext {
    const record = this._records.get(key);
    return {
      manager: this,
      device: this._device,
      tracker: this._tracker,
      resourceOwner: record?.scope?.owner,
      worker: this._options.worker ?? undefined,
      cache: this.cache,
      signal,
      setPhase: phase => {
        if (record && !signal.aborted && isLoadPhase(phase)) {
          record.job?.setPhase(phase);
        }
      },
      reportProgress: (loaded, total) => record?.job?.reportProgress(loaded, total),
      scheduleUpload: task => {
        const priority = task.priority ?? record?.job?.priority;
        const result = this.uploads.enqueue({
          ...task,
          ...(priority === undefined ? {} : { priority }),
          signal: task.signal ?? signal,
        });
        this._scheduleUploadDrain();
        return result;
      },
    };
  }

  private _createHandle<T>(record: AssetRecord<T>): AssetHandle<T> {
    let released = false;
    return {
      key: record.key,
      get value(): T {
        if (released) throw new EngineError(EngineErrorCode.AssetHandleReleased, `Asset handle has been released: ${record.key}`);
        if (record.value === null) throw new EngineError(EngineErrorCode.AssetNotReady, `Asset is not ready: ${record.key}`, { context: { jobState: getRecordState(record) } });
        return record.value;
      },
      release: () => {
        if (released) return;
        released = true;
        this._releaseRecord(record);
      },
    };
  }

  private _releaseRecord<T>(record: AssetRecord<T>): void {
    record.refs = Math.max(0, record.refs - 1);
    if (record.refs !== 0) return;
    if (isPending(getRecordState(record))) {
      record.controller?.abort('owner-released');
      return;
    }
    this._records.delete(record.key);
    this._releaseImmediately(record);
  }

  private _releaseImmediately<T>(record: AssetRecord<T>): void {
    record.controller?.abort('released');
    record.job?.release();
    record.controller = null;
    record.job = null;
    if (record.value !== null) record.dispose(record.value);
    record.value = null;
    record.refs = 0;
    record.scope?.release();
    record.scope = null;
  }

  private _textureKey(
    source: TextureAssetSource,
    format: GPUTextureFormat,
    mipmaps: TextureMipmapMode,
    premultipliedAlpha: boolean,
    cacheKey?: string,
  ): string {
    if (isCompressedTextureSource(source)) return `texture:compressed:${source.type}:${source.src}`;
    const alphaMode = premultipliedAlpha ? 'premultiplied' : 'straight';
    if (cacheKey !== undefined) return `texture:identity:${format}:${mipmaps}:${alphaMode}:${cacheKey}`;
    if (typeof source === 'string') return `texture:url:${format}:${mipmaps}:${alphaMode}:${source}`;
    let identity = this._objectKeys.get(source);
    if (!identity) {
      identity = String(++this._nextObjectKey);
      this._objectKeys.set(source, identity);
    }
    return `texture:object:${format}:${mipmaps}:${alphaMode}:${identity}`;
  }

  private async _createTexture(
    source: TextureAssetSource,
    format: GPUTextureFormat,
    mipmaps: TextureMipmapMode,
    premultipliedAlpha: boolean,
    label: string,
    signal: AbortSignal,
    key: string,
  ): Promise<GPUTexture> {
    if (isCompressedTextureSource(source)) {
      const handle = await this.loadAsset<GPUTexture>(source.type, source.src, { signal });
      return handle.value;
    }
    let imageSource: ImageBitmap | HTMLCanvasElement | HTMLImageElement = source as ImageBitmap | HTMLCanvasElement | HTMLImageElement;
    let closeBitmap = false;
    if (typeof source === 'string') {
      try {
        const blob = this._options.worker
          ? new Blob([await this._options.worker.fetchArrayBuffer(source, { signal })])
          : await fetchTextureBlob(source, signal);
        this._throwIfAborted(signal, key);
        const decoded = await decodeTextureBlob(blob, signal);
        imageSource = decoded.source;
        closeBitmap = decoded.closeBitmap;
      } catch (error) {
        if (signal.aborted || error instanceof EngineError) throw error;
        throw new EngineError(EngineErrorCode.AssetLoadFailed, `Failed to load texture "${source}".`, { cause: error, context: { url: source } });
      }
    }
    try {
      this._throwIfAborted(signal, key);
      const record = this._records.get(key);
      record?.job?.setPhase('uploading');
      return this._createTextureFromImageSource(imageSource, format, mipmaps, premultipliedAlpha, label, record?.scope ?? null);
    } finally {
      if (closeBitmap) (imageSource as ImageBitmap).close();
    }
  }

  private _createTextureFromImageSource(
    source: ImageBitmap | HTMLCanvasElement | HTMLImageElement,
    format: GPUTextureFormat,
    mipmaps: TextureMipmapMode,
    premultipliedAlpha: boolean,
    label: string,
    scope: GPUResourceScope | null,
  ): GPUTexture {
    const upload = uploadImageTexture(this._device, source, format, mipmaps, label, premultipliedAlpha);
    const texture = upload.texture;
    if (scope) scope.trackTexture(texture, `AssetManager.texture:${format}:${mipmaps}`, upload.estimatedBytes);
    else this._tracker?.trackTexture(texture, `AssetManager.texture:${format}:${mipmaps}`, upload.estimatedBytes);
    return texture;
  }

  private _destroyTexture(texture: GPUTexture): void {
    this._tracker?.untrackTexture(texture);
    try { texture.destroy(); } catch { /* Idempotent teardown after device loss. */ }
  }

  private _assertCanLoad(): void {
    if (this._disposed) throw new EngineError(EngineErrorCode.AssetManagerDisposed, 'AssetManager has been disposed.');
    if (!this._acceptingLoads && this._recoveryLoadDepth === 0) {
      throw new EngineError(
        EngineErrorCode.EngineInvalidState,
        'AssetManager is suspended while the GPU device is recovering.',
        { recovery: ErrorRecovery.Retry, context: { state: 'suspended' } },
      );
    }
  }

  private _throwIfAborted(signal: AbortSignal, key: string): void {
    if (signal.aborted) throw this._abortError(key, signal.reason);
  }

  private _abortError(key: string, cause?: unknown): EngineError {
    return new EngineError(
      EngineErrorCode.AssetJobAborted,
      `Asset job was aborted: ${key}`,
      { recovery: ErrorRecovery.Retry, context: { key }, cause },
    );
  }

  private _scheduleUploadDrain(): void {
    if (this._uploadDrainScheduled) return;
    this._uploadDrainScheduled = true;
    const drain = () => {
      this._uploadDrainScheduled = false;
      void this.drainUploadBudget().then(() => {
        if (this.uploads.snapshot().pendingTasks > 0) this._scheduleUploadDrain();
      });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(drain);
    else setTimeout(drain, 0);
  }
}

async function fetchTextureBlob(source: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(source, { signal });
  if (!response.ok) {
    throw new EngineError(
      EngineErrorCode.AssetLoadFailed,
      `Failed to load texture "${source}": ${response.status} ${response.statusText}`,
      { context: { url: source, status: response.status } },
    );
  }
  return response.blob();
}

async function decodeTextureBlob(
  blob: Blob,
  signal: AbortSignal,
): Promise<{ source: ImageBitmap | HTMLImageElement; closeBitmap: boolean }> {
  let bitmapError: unknown;
  if (typeof createImageBitmap === 'function') {
    try {
      return {
        // Keep runtime texture bytes straight-alpha. Blend-specific shaders
        // perform the one explicit premultiplication before compositing.
        source: await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }),
        closeBitmap: true,
      };
    } catch (error) {
      bitmapError = error;
    }
  }
  // Chromium does not consistently expose every browser-decodable image format
  // (notably SVG) through createImageBitmap. Keep the fallback at the asset
  // boundary so animation sprites and ordinary engine textures share behavior.
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw bitmapError ?? new Error('No browser image decoder is available.');
  }
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = 'async';
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        image.onload = null;
        image.onerror = null;
      };
      const abort = () => {
        cleanup();
        image.src = '';
        reject(signal.reason ?? new DOMException('Texture decode aborted.', 'AbortError'));
      };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(bitmapError ?? new Error('Browser image decoder rejected the texture.')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else image.src = objectUrl;
    });
    return { source: image, closeBitmap: false };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function isPending(state: AssetJobState): boolean {
  return state === 'queued' || state === 'loading' || state === 'parsing' || state === 'uploading';
}

function getRecordState<T>(record: AssetRecord<T>): AssetJobState {
  return record.job?.state ?? 'released';
}

function createReadyAssetJob<T>(key: string): AssetJob<T> {
  const job = new AssetJob<T>(key);
  job.adoptReady();
  return job;
}

function isLoadPhase(state: AssetJobState): state is AssetLoadPhase {
  return state === 'loading' || state === 'parsing' || state === 'uploading';
}

export function isCompressedTextureSource(source: unknown): source is CompressedTextureSourceDescriptor {
  return !!source
    && typeof source === 'object'
    && (source as CompressedTextureSourceDescriptor).kind === 'compressed-texture'
    && typeof (source as CompressedTextureSourceDescriptor).type === 'string'
    && typeof (source as CompressedTextureSourceDescriptor).src === 'string';
}

function normalizeLoaderKey(value: string): string { return value.trim().toLowerCase(); }
function normalizeExtension(extension: string): string {
  const normalized = normalizeLoaderKey(extension);
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}
function getUrlExtension(url: string): string | null {
  const cleanUrl = url.split(/[?#]/, 1)[0] ?? url;
  const slashIndex = cleanUrl.lastIndexOf('/');
  const basename = slashIndex >= 0 ? cleanUrl.slice(slashIndex + 1) : cleanUrl;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return null;
  return normalizeExtension(basename.slice(dotIndex + 1));
}

function combineRequestSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}

function waitForRecord<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Asset request aborted.', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason ?? new DOMException('Asset request aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}
