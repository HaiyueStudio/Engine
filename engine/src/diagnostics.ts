import { getEngineFrameDiagnostics, getEngineGPUResourceTracker } from './core/EngineDiagnosticsAccess';
import type { IEngine } from './core/IEngine';

/** Stable CPU stages reported for the latest engine frame. */
export type EngineFrameMetricStage =
  | 'update'
  | 'collect'
  | 'cull'
  | 'sort'
  | 'batch-build'
  | 'upload'
  | 'record'
  | 'submit';

/** Stable counters reported for the latest engine frame. */
export type EngineFrameMetricCounter =
  | 'draws'
  | 'dispatches'
  | 'passes'
  | 'pipelineSwitches'
  | 'bufferUploads'
  | 'bufferUploadBytes';

export type EngineGpuPassTimingType = 'render' | 'compute';

export interface EngineGpuPassTimingSnapshot {
  readonly index: number;
  readonly type: EngineGpuPassTimingType;
  readonly label: string;
  readonly durationMs: number;
}

export interface EngineGpuFrameTimingSnapshot {
  readonly frame: number;
  readonly totalMs: number;
  readonly passes: readonly EngineGpuPassTimingSnapshot[];
  readonly truncated: boolean;
}

export interface EngineFrameDiagnosticsSnapshot {
  readonly enabled: boolean;
  readonly frame: number;
  readonly startedAt: number;
  readonly cpuMs: Readonly<Record<EngineFrameMetricStage, number>>;
  readonly counters: Readonly<Record<EngineFrameMetricCounter, number>>;
  readonly gpuMs?: number | undefined;
  readonly gpu?: EngineGpuFrameTimingSnapshot | undefined;
}

export type EngineGpuResourceType =
  | 'buffer'
  | 'texture'
  | 'sampler'
  | 'bind-group'
  | 'bind-group-layout'
  | 'pipeline-layout'
  | 'render-pipeline'
  | 'compute-pipeline'
  | 'query-set';

export interface EngineGpuResourceTypeSnapshot {
  readonly current: number;
  readonly created: number;
  readonly destroyed: number;
  readonly peak: number;
  readonly estimatedBytes: number;
  readonly peakEstimatedBytes: number;
  readonly frameCreated: number;
  readonly frameDestroyed: number;
}

export interface EngineGpuResourceTotalsSnapshot {
  readonly resources: number;
  readonly estimatedBytes: number;
}

/**
 * Aggregate-only GPU diagnostics. Resource handles, owner identities, labels,
 * stacks, and tracker mutation methods deliberately stay experimental.
 */
export interface EngineGpuResourceDiagnosticsSnapshot {
  readonly enabled: boolean;
  readonly frame: number;
  readonly totals: EngineGpuResourceTotalsSnapshot;
  readonly byType: Readonly<Partial<Record<EngineGpuResourceType, EngineGpuResourceTypeSnapshot>>>;
  readonly ownerCount: number;
  readonly cacheCount: number;
  readonly releasedOwnerResiduals: number;
}

/** An immutable point-in-time view of engine diagnostics. */
export interface EngineDiagnosticsSnapshot {
  readonly enabled: boolean;
  readonly frame: EngineFrameDiagnosticsSnapshot;
  readonly gpuResources: EngineGpuResourceDiagnosticsSnapshot;
}

const EMPTY_CPU_MS: Readonly<Record<EngineFrameMetricStage, number>> = Object.freeze({
  update: 0,
  collect: 0,
  cull: 0,
  sort: 0,
  'batch-build': 0,
  upload: 0,
  record: 0,
  submit: 0,
});
const EMPTY_COUNTERS: Readonly<Record<EngineFrameMetricCounter, number>> = Object.freeze({
  draws: 0,
  dispatches: 0,
  passes: 0,
  pipelineSwitches: 0,
  bufferUploads: 0,
  bufferUploadBytes: 0,
});

/**
 * Reads diagnostics without exposing the mutable instrumentation objects.
 * Engines without registered diagnostics return the same disabled shape.
 */
export function getEngineDiagnosticsSnapshot(engine: IEngine): EngineDiagnosticsSnapshot {
  const frame = getEngineFrameDiagnostics(engine)?.snapshot() ?? Object.freeze({
    enabled: false,
    frame: 0,
    startedAt: 0,
    cpuMs: EMPTY_CPU_MS,
    counters: EMPTY_COUNTERS,
  });
  const resourceSnapshot = getEngineGPUResourceTracker(engine)?.getDebugSnapshot();
  const byType: Partial<Record<EngineGpuResourceType, EngineGpuResourceTypeSnapshot>> = {};
  let resources = 0;
  let estimatedBytes = 0;
  for (const [type, stats] of Object.entries(resourceSnapshot?.byType ?? {})) {
    if (!stats) continue;
    const stableStats = Object.freeze({ ...stats });
    byType[type as EngineGpuResourceType] = stableStats;
    resources += stableStats.current;
    estimatedBytes += stableStats.estimatedBytes;
  }
  const gpuResources: EngineGpuResourceDiagnosticsSnapshot = Object.freeze({
    enabled: resourceSnapshot?.enabled === true,
    frame: resourceSnapshot?.frame ?? 0,
    totals: Object.freeze({ resources, estimatedBytes }),
    byType: Object.freeze(byType),
    ownerCount: resourceSnapshot?.owners.length ?? 0,
    cacheCount: resourceSnapshot?.caches.length ?? 0,
    releasedOwnerResiduals: resourceSnapshot?.releasedOwnerResiduals ?? 0,
  });
  return Object.freeze({
    enabled: frame.enabled || gpuResources.enabled,
    frame,
    gpuResources,
  });
}
