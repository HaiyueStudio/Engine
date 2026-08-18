export interface AssetCacheBudget {
  maxBytes: number;
  maxEntries: number;
}

export interface AssetCacheSnapshot {
  readonly name: string;
  readonly entries: number;
  readonly bytes: number;
  readonly retainedEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly budget: AssetCacheBudget;
}

interface AssetCacheEntry<T> {
  value: T;
  bytes: number;
  refs: number;
  touched: number;
  dispose: ((value: T) => void) | null;
}

export class BudgetedAssetCache<T = unknown> {
  private readonly _entries = new Map<string, AssetCacheEntry<T>>();
  private _bytes = 0;
  private _clock = 0;
  private _hits = 0;
  private _misses = 0;
  readonly budget: AssetCacheBudget;

  constructor(readonly name: string, budget: Partial<AssetCacheBudget> = {}) {
    this.budget = {
      maxBytes: Math.max(0, budget.maxBytes ?? Number.POSITIVE_INFINITY),
      maxEntries: Math.max(0, budget.maxEntries ?? Number.POSITIVE_INFINITY),
    };
  }

  get size(): number { return this._entries.size; }
  get byteLength(): number { return this._bytes; }

  get(key: string, options: { retain?: boolean } = {}): T | undefined {
    const entry = this._entries.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    this._hits++;
    entry.touched = ++this._clock;
    if (options.retain) entry.refs++;
    return entry.value;
  }

  set(key: string, value: T, bytes: number, options: { retain?: boolean; dispose?: (value: T) => void } = {}): T {
    this.delete(key);
    const entry: AssetCacheEntry<T> = {
      value,
      bytes: Math.max(0, Number.isFinite(bytes) ? bytes : 0),
      refs: options.retain ? 1 : 0,
      touched: ++this._clock,
      dispose: options.dispose ?? null,
    };
    this._entries.set(key, entry);
    this._bytes += entry.bytes;
    this.evictToBudget();
    return value;
  }

  retain(key: string): boolean {
    const entry = this._entries.get(key);
    if (!entry) return false;
    entry.refs++;
    entry.touched = ++this._clock;
    return true;
  }

  release(key: string): boolean {
    const entry = this._entries.get(key);
    if (!entry) return false;
    entry.refs = Math.max(0, entry.refs - 1);
    this.evictToBudget();
    return true;
  }

  delete(key: string): boolean {
    const entry = this._entries.get(key);
    if (!entry) return false;
    this._entries.delete(key);
    this._bytes -= entry.bytes;
    entry.dispose?.(entry.value);
    return true;
  }

  clear(): void {
    for (const key of [...this._entries.keys()]) this.delete(key);
  }

  evictToBudget(): void {
    if (this._entries.size <= this.budget.maxEntries && this._bytes <= this.budget.maxBytes) return;
    const candidates = [...this._entries.entries()]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].touched - b[1].touched);
    for (const [key] of candidates) {
      if (this._entries.size <= this.budget.maxEntries && this._bytes <= this.budget.maxBytes) break;
      this.delete(key);
    }
  }

  snapshot(): AssetCacheSnapshot {
    let retainedEntries = 0;
    for (const entry of this._entries.values()) if (entry.refs > 0) retainedEntries++;
    return Object.freeze({
      name: this.name,
      entries: this._entries.size,
      bytes: this._bytes,
      retainedEntries,
      hits: this._hits,
      misses: this._misses,
      budget: Object.freeze({ ...this.budget }),
    });
  }
}

export interface AssetCacheHierarchyOptions {
  network?: Partial<AssetCacheBudget>;
  parsed?: Partial<AssetCacheBudget>;
  gpu?: Partial<AssetCacheBudget>;
}

export class AssetCacheHierarchy {
  readonly network: BudgetedAssetCache<ArrayBuffer | Blob | string>;
  readonly parsed: BudgetedAssetCache;
  private readonly _gpu = new Map<GPUDevice, BudgetedAssetCache>();
  private readonly _gpuBudget: Partial<AssetCacheBudget>;

  constructor(options: AssetCacheHierarchyOptions = {}) {
    this.network = new BudgetedAssetCache('network', options.network ?? { maxBytes: 128 * 1024 * 1024, maxEntries: 512 });
    this.parsed = new BudgetedAssetCache('parsed-cpu', options.parsed ?? { maxBytes: 256 * 1024 * 1024, maxEntries: 256 });
    this._gpuBudget = options.gpu ?? { maxBytes: 512 * 1024 * 1024, maxEntries: 512 };
  }

  forDevice(device: GPUDevice): BudgetedAssetCache {
    let cache = this._gpu.get(device);
    if (!cache) {
      cache = new BudgetedAssetCache('gpu-device', this._gpuBudget);
      this._gpu.set(device, cache);
    }
    return cache;
  }

  releaseDevice(device: GPUDevice): void {
    this._gpu.get(device)?.clear();
    this._gpu.delete(device);
  }

  clear(): void {
    this.network.clear();
    this.parsed.clear();
    for (const cache of this._gpu.values()) cache.clear();
    this._gpu.clear();
  }

  snapshot(device?: GPUDevice): readonly AssetCacheSnapshot[] {
    const snapshots = [this.network.snapshot(), this.parsed.snapshot()];
    if (device) snapshots.push(this.forDevice(device).snapshot());
    return Object.freeze(snapshots);
  }
}
