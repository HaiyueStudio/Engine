import type { IEngine } from '../core/IEngine';
import { releaseMapEntriesNotIn } from './utils';
import type { LiveIdSet } from './utils';
import { RendererPipelineLayoutCache, RendererResourceCache } from './RendererResourceCache';
import {
  createComputePipelineAsync,
  createRenderPipelineAsync,
  type PipelineWarmupPlan,
} from './PipelineWarmup';

export interface PipelineCacheDiagnosticsSnapshot {
  readonly hits: number;
  readonly misses: number;
  readonly synchronousCreates: number;
  readonly asynchronousCreates: number;
  readonly failures: number;
  readonly pending: number;
  readonly totalCreateTimeMs: number;
  readonly lastCreateTimeMs: number;
  readonly size: number;
}

export abstract class BaseRenderer {
  protected maxPipelineCacheEntries = 128;
  protected readonly pipelineCache = new Map<string | number, GPURenderPipeline>();
  private readonly _computePipelineKeys = new Set<string | number>();
  private readonly _pipelineWarmupId = ++pipelineWarmupRendererId;
  private readonly _pipelineDiagnostics = {
    hits: 0,
    misses: 0,
    synchronousCreates: 0,
    asynchronousCreates: 0,
    failures: 0,
    pending: 0,
    totalCreateTimeMs: 0,
    lastCreateTimeMs: 0,
  };

  /** Synchronously creates renderer-owned GPU objects. */
  abstract prepare(engine: IEngine): void;

  /** Adds every built-in/common render-pipeline variant owned by this renderer. */
  abstract contributePipelineWarmup(plan: PipelineWarmupPlan): void;

  protected getCachedPipeline(key: string | number, create: () => GPURenderPipeline): GPURenderPipeline {
    let pipeline = this.pipelineCache.get(key);
    if (pipeline) {
      this._pipelineDiagnostics.hits++;
      this.pipelineCache.delete(key);
      this.pipelineCache.set(key, pipeline);
      return pipeline;
    }

    this._pipelineDiagnostics.misses++;
    const startedAt = now();
    try {
      pipeline = create();
    } catch (error) {
      this._pipelineDiagnostics.failures++;
      throw error;
    } finally {
      this._recordPipelineCreateTime(startedAt);
    }
    this._pipelineDiagnostics.synchronousCreates++;
    this.pipelineCache.set(key, pipeline);
    this.trimPipelineCache();
    return pipeline;
  }

  protected clearPipelineCache(): void {
    this.pipelineCache.clear();
    this._computePipelineKeys.clear();
  }

  /** Returns cumulative pipeline cache and compilation diagnostics for this renderer instance. */
  getPipelineCacheDiagnostics(): PipelineCacheDiagnosticsSnapshot {
    return Object.freeze({
      ...this._pipelineDiagnostics,
      size: this.pipelineCache.size + this._computePipelineKeys.size,
    });
  }

  protected addPipelineWarmup(
    plan: PipelineWarmupPlan,
    key: string | number,
    label: string,
    descriptor: () => GPURenderPipelineDescriptor,
    device: GPUDevice,
  ): void {
    plan.add({
      id: `${this.constructor.name}#${this._pipelineWarmupId}:${String(key)}`,
      label,
      owner: this.constructor.name,
      compile: async () => {
        if (this.pipelineCache.has(key)) {
          this._pipelineDiagnostics.hits++;
          return;
        }
        this._pipelineDiagnostics.misses++;
        this._pipelineDiagnostics.pending++;
        const startedAt = now();
        try {
          const pipeline = await createRenderPipelineAsync(device, descriptor(), {
            renderer: this.constructor.name,
            key,
            label,
          });
          if (!this.pipelineCache.has(key)) {
            this.pipelineCache.set(key, pipeline);
            this.trimPipelineCache();
          }
          this._pipelineDiagnostics.asynchronousCreates++;
        } catch (error) {
          this._pipelineDiagnostics.failures++;
          throw error;
        } finally {
          this._pipelineDiagnostics.pending--;
          this._recordPipelineCreateTime(startedAt);
        }
      },
    });
  }

  protected getCachedComputePipeline(
    key: string | number,
    cached: () => GPUComputePipeline | null,
    create: () => GPUComputePipeline,
    store: (pipeline: GPUComputePipeline) => void,
  ): GPUComputePipeline {
    const existing = cached();
    if (existing) {
      this._pipelineDiagnostics.hits++;
      return existing;
    }
    this._pipelineDiagnostics.misses++;
    const startedAt = now();
    let pipeline: GPUComputePipeline;
    try {
      pipeline = create();
    } catch (error) {
      this._pipelineDiagnostics.failures++;
      throw error;
    } finally {
      this._recordPipelineCreateTime(startedAt);
    }
    store(pipeline);
    this._computePipelineKeys.add(key);
    this._pipelineDiagnostics.synchronousCreates++;
    return pipeline;
  }

  protected addComputePipelineWarmup(
    plan: PipelineWarmupPlan,
    key: string | number,
    label: string,
    descriptor: () => GPUComputePipelineDescriptor,
    device: GPUDevice,
    cached: () => GPUComputePipeline | null,
    store: (pipeline: GPUComputePipeline) => void,
  ): void {
    plan.add({
      id: `${this.constructor.name}#${this._pipelineWarmupId}:compute:${String(key)}`,
      label,
      owner: this.constructor.name,
      compile: async () => {
        if (cached()) {
          this._pipelineDiagnostics.hits++;
          return;
        }
        this._pipelineDiagnostics.misses++;
        this._pipelineDiagnostics.pending++;
        const startedAt = now();
        try {
          const pipeline = await createComputePipelineAsync(device, descriptor(), {
            owner: this.constructor.name,
            key,
            label,
          });
          if (!cached()) store(pipeline);
          this._computePipelineKeys.add(key);
          this._pipelineDiagnostics.asynchronousCreates++;
        } catch (error) {
          this._pipelineDiagnostics.failures++;
          throw error;
        } finally {
          this._pipelineDiagnostics.pending--;
          this._recordPipelineCreateTime(startedAt);
        }
      },
    });
  }

  protected setPipelineCacheLimit(limit: number): void {
    this.maxPipelineCacheEntries = Math.max(1, Math.floor(limit));
    this.trimPipelineCache();
  }

  protected getSharedPipelineLayout(device: GPUDevice, key: string, bindGroupLayouts: GPUBindGroupLayout[]): GPUPipelineLayout {
    return RendererPipelineLayoutCache.get(device, key, bindGroupLayouts);
  }

  protected getSharedRendererResource<T extends object>(device: GPUDevice, key: string, create: () => T): T {
    return RendererResourceCache.get(device, key, create);
  }

  private trimPipelineCache(): void {
    while (this.pipelineCache.size > this.maxPipelineCacheEntries) {
      const oldestKey = this.pipelineCache.keys().next().value;
      if (oldestKey === undefined) return;
      this.pipelineCache.delete(oldestKey);
    }
  }

  private _recordPipelineCreateTime(startedAt: number): void {
    const elapsed = Math.max(0, now() - startedAt);
    this._pipelineDiagnostics.lastCreateTimeMs = elapsed;
    this._pipelineDiagnostics.totalCreateTimeMs += elapsed;
  }

  protected releaseCacheEntriesNotIn<T>(
    cache: Map<number, T>,
    liveIds: LiveIdSet,
    destroy: (value: T) => void,
  ): void {
    releaseMapEntriesNotIn(cache, liveIds, destroy);
  }

  protected destroyCacheEntries<T>(cache: Map<number, T>, destroy: (value: T) => void): void {
    for (const value of cache.values()) destroy(value);
    cache.clear();
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

let pipelineWarmupRendererId = 0;
