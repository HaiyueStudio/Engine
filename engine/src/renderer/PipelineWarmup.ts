import { EngineError, EngineErrorCode, ErrorRecovery } from '../core/EngineError';
import { assertWgslShaderModuleCompilation } from '../shader/WgslFeatureComposer';

export type PipelineWarmupStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface PipelineWarmupTask {
  readonly id: string;
  readonly label: string;
  /** Stable task owner used by callers to apply capability-specific fallback policy. */
  readonly owner?: string;
  readonly compile: () => Promise<void>;
}

export interface PipelineWarmupProgress {
  readonly label: string;
  readonly status: PipelineWarmupStatus;
  readonly total: number;
  readonly completed: number;
  readonly compiling: number;
  readonly failed: number;
  readonly currentTask: string | null;
  readonly elapsedMs: number;
  readonly error: EngineError | null;
}

export interface PipelineWarmupRunOptions {
  signal?: AbortSignal;
  concurrency?: number;
  /** Return true to tolerate one task failure and let the plan complete in degraded mode. */
  onTaskError?: (error: EngineError, task: PipelineWarmupTask) => boolean;
}

export interface PipelineWarmupParticipant {
  /** Adds renderer-owned variants without starting compilation. */
  contributePipelineWarmup(plan: PipelineWarmupPlan): void;
}

export type PipelineWarmupListener = (progress: PipelineWarmupProgress) => void;

export class PipelineWarmupPlan {
  private readonly _tasks = new Map<string, PipelineWarmupTask>();
  private readonly _listeners = new Set<PipelineWarmupListener>();
  private _status: PipelineWarmupStatus = 'idle';
  private _completed = 0;
  private _compiling = 0;
  private _failed = 0;
  private _currentTask: string | null = null;
  private _error: EngineError | null = null;
  private _startedAt = 0;
  private _runPromise: Promise<PipelineWarmupProgress> | null = null;

  constructor(readonly label = 'Pipeline warmup') {}

  /** Adds one idempotent task. Duplicate ids in the same plan are ignored. */
  add(task: PipelineWarmupTask): this {
    if (this._status !== 'idle') {
      throw new EngineError(
        EngineErrorCode.EngineInvalidState,
        'Cannot add pipeline warmup tasks after compilation has started.',
        { context: { plan: this.label, status: this._status, taskId: task.id } },
      );
    }
    if (!this._tasks.has(task.id)) this._tasks.set(task.id, Object.freeze({ ...task }));
    return this;
  }

  /** Subscribes to immutable progress snapshots and immediately emits the current state. */
  subscribe(listener: PipelineWarmupListener): () => void {
    this._listeners.add(listener);
    listener(this.snapshot());
    return () => this._listeners.delete(listener);
  }

  /** Returns the current immutable state without starting compilation. */
  snapshot(): PipelineWarmupProgress {
    return Object.freeze({
      label: this.label,
      status: this._status,
      total: this._tasks.size,
      completed: this._completed,
      compiling: this._compiling,
      failed: this._failed,
      currentTask: this._currentTask,
      elapsedMs: this._startedAt > 0 ? Math.max(0, now() - this._startedAt) : 0,
      error: this._error,
    });
  }

  /** Starts compilation once. Repeated calls share the same promise. */
  run(options: PipelineWarmupRunOptions = {}): Promise<PipelineWarmupProgress> {
    if (this._runPromise) return this._runPromise;
    this._runPromise = this._run(options);
    return this._runPromise;
  }

  private async _run(options: PipelineWarmupRunOptions): Promise<PipelineWarmupProgress> {
    const tasks = [...this._tasks.values()];
    this._startedAt = now();
    if (options.signal?.aborted) {
      this._status = 'cancelled';
      this._emit();
      return this.snapshot();
    }
    this._status = 'running';
    this._emit();
    if (tasks.length === 0) {
      this._status = 'completed';
      this._emit();
      return this.snapshot();
    }

    let cursor = 0;
    const errors: EngineError[] = [];
    const concurrency = Math.min(tasks.length, Math.max(1, Math.floor(options.concurrency ?? 4)));
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length && !options.signal?.aborted) {
        const task = tasks[cursor++]!;
        this._compiling++;
        this._currentTask = task.label;
        this._emit();
        try {
          await task.compile();
        } catch (cause) {
          const error = cause instanceof EngineError
            ? cause
            : pipelineCompilationError(task.label, task.id, cause);
          this._failed++;
          let tolerated = false;
          try {
            tolerated = options.onTaskError?.(error, task) === true;
          } catch {
            // A broken fallback policy must not hide the original compilation failure.
          }
          if (!tolerated) {
            errors.push(error);
            this._error ??= error;
          }
        } finally {
          this._compiling--;
          this._completed++;
          this._emit();
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (options.signal?.aborted) this._status = 'cancelled';
    else if (errors.length > 0) this._status = 'failed';
    else this._status = 'completed';
    this._currentTask = null;
    this._emit();
    if (errors.length > 0) throw errors[0]!;
    return this.snapshot();
  }

  private _emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this._listeners) listener(snapshot);
  }
}

export async function createRenderPipelineAsync(
  device: GPUDevice,
  descriptor: GPURenderPipelineDescriptor,
  context: { renderer: string; key: string | number; label: string },
): Promise<GPURenderPipeline> {
  try {
    const vertexModule = descriptor.vertex?.module;
    const fragmentModule = descriptor.fragment?.module;
    await Promise.all([
      vertexModule ? assertWgslShaderModuleCompilation(vertexModule) : Promise.resolve(),
      fragmentModule ? assertWgslShaderModuleCompilation(fragmentModule) : Promise.resolve(),
    ]);
    if (typeof device.createRenderPipelineAsync === 'function') {
      return await device.createRenderPipelineAsync(descriptor);
    }
    return device.createRenderPipeline(descriptor);
  } catch (cause) {
    throw pipelineCompilationError(context.label, `${context.renderer}:${String(context.key)}`, cause, context);
  }
}

/** Compiles a compute pipeline without blocking when the implementation supports async creation. */
export async function createComputePipelineAsync(
  device: GPUDevice,
  descriptor: GPUComputePipelineDescriptor,
  context: { owner: string; key: string | number; label: string },
): Promise<GPUComputePipeline> {
  try {
    const computeModule = descriptor.compute?.module;
    if (computeModule) await assertWgslShaderModuleCompilation(computeModule);
    if (typeof device.createComputePipelineAsync === 'function') {
      return await device.createComputePipelineAsync(descriptor);
    }
    return device.createComputePipeline(descriptor);
  } catch (cause) {
    throw pipelineCompilationError(
      context.label,
      `${context.owner}:${String(context.key)}`,
      cause,
      context,
      'compute',
    );
  }
}

export function isPipelineWarmupParticipant(value: unknown): value is PipelineWarmupParticipant {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { contributePipelineWarmup?: unknown }).contributePipelineWarmup === 'function';
}

function pipelineCompilationError(
  label: string,
  taskId: string,
  cause: unknown,
  context: Record<string, unknown> = {},
  kind: 'render' | 'compute' = 'render',
): EngineError {
  return new EngineError(
    EngineErrorCode.RenderPipelineCompilationFailed,
    `Failed to compile ${kind} pipeline "${label}".`,
    {
      recovery: ErrorRecovery.Retry,
      context: { taskId, label, ...context },
      hint: 'Inspect the mapped WGSL compilation diagnostics, then retry pipeline warmup.',
      docsPath: 'errors/E_RENDER_PIPELINE_COMPILATION_FAILED',
      cause,
    },
  );
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
