export type FrameMetricStage =
  | 'update'
  | 'collect'
  | 'cull'
  | 'sort'
  | 'batch-build'
  | 'upload'
  | 'record'
  | 'submit';

export type FrameMetricCounter =
  | 'draws'
  | 'dispatches'
  | 'passes'
  | 'pipelineSwitches'
  | 'bufferUploads'
  | 'bufferUploadBytes';

export type GpuPassTimingType = 'render' | 'compute';

export interface GpuPassTimingSnapshot {
  readonly index: number;
  readonly type: GpuPassTimingType;
  readonly label: string;
  readonly durationMs: number;
}

export interface GpuFrameTimingSnapshot {
  readonly frame: number;
  readonly totalMs: number;
  readonly passes: readonly GpuPassTimingSnapshot[];
  readonly truncated: boolean;
}

export interface FrameMetricsSnapshot {
  readonly enabled: boolean;
  readonly frame: number;
  readonly startedAt: number;
  readonly cpuMs: Readonly<Record<FrameMetricStage, number>>;
  readonly counters: Readonly<Record<FrameMetricCounter, number>>;
  readonly gpuMs?: number | undefined;
  readonly gpu?: GpuFrameTimingSnapshot | undefined;
}

export interface FrameDiagnosticsOptions {
  enabled?: boolean;
  now?: () => number;
}

const EMPTY_STAGES: Record<FrameMetricStage, number> = {
  update: 0,
  collect: 0,
  cull: 0,
  sort: 0,
  'batch-build': 0,
  upload: 0,
  record: 0,
  submit: 0,
};

const EMPTY_COUNTERS: Record<FrameMetricCounter, number> = {
  draws: 0,
  dispatches: 0,
  passes: 0,
  pipelineSwitches: 0,
  bufferUploads: 0,
  bufferUploadBytes: 0,
};

/** Opt-in per-frame metrics sink shared by ECS, render preparation, and submission. */
export class FrameDiagnostics {
  readonly enabled: boolean;
  private readonly _now: () => number;
  private _frame = 0;
  private _startedAt = 0;
  private _cpuMs = { ...EMPTY_STAGES };
  private _counters = { ...EMPTY_COUNTERS };
  private _gpuMs: number | undefined;
  private _gpu: GpuFrameTimingSnapshot | undefined;
  private _latestGpuTimingFrame = -1;

  constructor(options: FrameDiagnosticsOptions = {}) {
    this.enabled = options.enabled === true;
    this._now = options.now ?? (() => performance.now());
  }

  get frame(): number { return this._frame; }

  beginFrame(frame?: number): void {
    if (!this.enabled) return;
    this._frame = frame ?? this._frame + 1;
    this._startedAt = this._now();
    this._cpuMs = { ...EMPTY_STAGES };
    this._counters = { ...EMPTY_COUNTERS };
    this._gpuMs = undefined;
    this._gpu = undefined;
  }

  measure<T>(stage: FrameMetricStage, action: () => T): T {
    if (!this.enabled) return action();
    const started = this.startMeasure();
    try {
      return action();
    } finally {
      this.finishMeasure(stage, started);
    }
  }

  /** Allocation-free timing boundary for hot loops that cannot create a measurement closure. */
  startMeasure(): number {
    return this.enabled ? this._now() : 0;
  }

  /** Completes a boundary opened by startMeasure(). */
  finishMeasure(stage: FrameMetricStage, startedAt: number): void {
    if (!this.enabled) return;
    this.addDuration(stage, this._now() - startedAt);
  }

  addDuration(stage: FrameMetricStage, milliseconds: number): void {
    if (!this.enabled || !Number.isFinite(milliseconds)) return;
    this._cpuMs[stage] += Math.max(0, milliseconds);
  }

  increment(counter: FrameMetricCounter, amount = 1): void {
    if (!this.enabled || !Number.isFinite(amount)) return;
    this._counters[counter] += Math.max(0, amount);
  }

  setGpuDuration(milliseconds: number | undefined): void {
    if (!this.enabled) return;
    this._gpuMs = milliseconds !== undefined && Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
    this._gpu = undefined;
  }

  setGpuPassDurations(
    frame: number,
    passes: readonly GpuPassTimingSnapshot[],
    truncated = false,
  ): void {
    if (!this.enabled) return;
    if (frame < this._latestGpuTimingFrame) return;
    const snapshots: GpuPassTimingSnapshot[] = [];
    let totalMs = 0;
    for (const pass of passes) {
      if (!Number.isFinite(pass.durationMs)) continue;
      const durationMs = Math.max(0, pass.durationMs);
      totalMs += durationMs;
      snapshots.push(Object.freeze({ ...pass, durationMs }));
    }
    if (frame === this._latestGpuTimingFrame && this._gpu?.frame === frame) {
      const combined = [...this._gpu.passes, ...snapshots].map((pass, index) => Object.freeze({ ...pass, index }));
      totalMs += this._gpu.totalMs;
      this._gpuMs = totalMs;
      this._gpu = Object.freeze({
        frame,
        totalMs,
        passes: Object.freeze(combined),
        truncated: this._gpu.truncated || truncated,
      });
      return;
    }
    this._latestGpuTimingFrame = frame;
    this._gpuMs = totalMs;
    this._gpu = Object.freeze({
      frame,
      totalMs,
      passes: Object.freeze(snapshots),
      truncated,
    });
  }

  snapshot(): FrameMetricsSnapshot {
    return Object.freeze({
      enabled: this.enabled,
      frame: this._frame,
      startedAt: this._startedAt,
      cpuMs: Object.freeze({ ...this._cpuMs }),
      counters: Object.freeze({ ...this._counters }),
      ...(this._gpuMs === undefined ? {} : { gpuMs: this._gpuMs }),
      ...(this._gpu === undefined ? {} : { gpu: this._gpu }),
    });
  }
}
