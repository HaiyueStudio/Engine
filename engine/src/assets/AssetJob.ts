import { EngineError, EngineErrorCode, ErrorRecovery } from '../core/EngineError';
import type { AssetJobState } from '../core/Lifecycle';
import { ASYNC_PRIORITY_VALUE, normalizeAsyncPriority, type AsyncPriority } from '../async/AsyncPrimitives';

export type AssetJobPhase = Extract<AssetJobState, 'queued' | 'loading' | 'parsing' | 'uploading'>;
export type AssetJobPriority = AsyncPriority;

export const ASSET_JOB_PRIORITY_VALUE = ASYNC_PRIORITY_VALUE;

export interface AssetJobProgress {
  readonly phase: AssetJobPhase;
  readonly loaded: number;
  readonly total: number | null;
  readonly ratio: number | null;
}

export interface AssetJobOptions<T = unknown> {
  priority?: AssetJobPriority | number;
  timeoutMs?: number;
  owner?: AssetOwnerScope;
  onProgress?: (progress: AssetJobProgress) => void;
  disposeLateResult?: (value: T) => void;
}

export interface AssetJobContext {
  readonly signal: AbortSignal;
  setPhase(phase: Exclude<AssetJobPhase, 'queued'>): void;
  reportProgress(loaded: number, total?: number | null): void;
}

/**
 * One deduplicated unit of asset work. AssetManager owns reference counting;
 * AssetJob owns cancellation, timeout, progress and late-result suppression.
 */
export class AssetJob<T> {
  readonly controller = new AbortController();
  readonly priority: number;
  readonly timeoutMs: number;
  readonly owner: AssetOwnerScope | null;
  private _state: AssetJobState = 'queued';
  progress: AssetJobProgress = Object.freeze({ phase: 'queued', loaded: 0, total: null, ratio: null });
  error: unknown = null;
  private _generation = 0;
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  private _promise: Promise<T> | null = null;
  private _rejectAbort: ((error: EngineError) => void) | null = null;
  private readonly _disposeLateResult: ((value: T) => void) | null;
  private readonly _progressListeners = new Set<(progress: AssetJobProgress) => void>();

  constructor(readonly key: string, options: AssetJobOptions<T> = {}) {
    this.priority = normalizeAsyncPriority(options.priority);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    this.owner = options.owner ?? null;
    this._disposeLateResult = options.disposeLateResult ?? null;
    if (options.onProgress) this._progressListeners.add(options.onProgress);
    this.owner?.trackJob(this);
  }

  get state(): AssetJobState { return this._state; }

  get promise(): Promise<T> {
    if (!this._promise) throw new Error(`AssetJob has not started: ${this.key}`);
    return this._promise;
  }

  onProgress(listener: (progress: AssetJobProgress) => void): () => void {
    this._progressListeners.add(listener);
    listener(this.progress);
    return () => this._progressListeners.delete(listener);
  }

  start(executor: (context: AssetJobContext) => Promise<T>): Promise<T> {
    if (this._promise) return this._promise;
    if (this.controller.signal.aborted) {
      this.transition('aborted');
      this.error ??= this.abortError();
      this._promise = Promise.reject(this.error).finally(() => this.finish());
      return this._promise;
    }
    const generation = ++this._generation;
    this.setPhase('loading');
    if (this.timeoutMs > 0) {
      this._timeoutId = setTimeout(() => this.abort(`timeout:${this.timeoutMs}`), this.timeoutMs);
    }
    const context: AssetJobContext = {
      signal: this.controller.signal,
      setPhase: phase => this.setPhase(phase),
      reportProgress: (loaded, total) => this.reportProgress(loaded, total),
    };
    let result: Promise<T>;
    try {
      result = executor(context);
    } catch (error) {
      result = Promise.reject(error);
    }
    const guardedResult = result.then(value => {
      if (generation !== this._generation || this.controller.signal.aborted) {
        this.disposeLateResult(value);
        throw this.abortError();
      }
      return value;
    });
    const abortPromise = new Promise<T>((_resolve, reject) => {
      this._rejectAbort = reject;
    });
    this._promise = Promise.race([guardedResult, abortPromise]).then(
      value => {
        if (generation !== this._generation || this.controller.signal.aborted) {
          this.disposeLateResult(value);
          throw this.abortError();
        }
        this.reportProgress(1, 1);
        this.transition('ready');
        return value;
      },
      error => {
        if (this.controller.signal.aborted) {
          this.transition('aborted');
          this.error = this.abortError(error);
          throw this.error;
        }
        this.transition('failed');
        this.error = error;
        throw error;
      },
    ).finally(() => this.finish());
    return this._promise;
  }

  setPhase(phase: Exclude<AssetJobPhase, 'queued'>): void {
    if (this.controller.signal.aborted || isSettled(this.state)) return;
    this.transition(phase);
    this.progress = Object.freeze({ ...this.progress, phase });
    this.emitProgress();
  }

  reportProgress(loaded: number, total: number | null = null): void {
    if (this.controller.signal.aborted || isSettled(this.state)) return;
    const safeLoaded = Math.max(0, Number.isFinite(loaded) ? loaded : 0);
    const safeTotal = total == null || !Number.isFinite(total) || total <= 0 ? null : total;
    this.progress = Object.freeze({
      phase: isPendingPhase(this.state) ? this.state : this.progress.phase,
      loaded: safeLoaded,
      total: safeTotal,
      ratio: safeTotal === null ? null : Math.min(1, safeLoaded / safeTotal),
    });
    this.emitProgress();
  }

  abort(reason: unknown = 'aborted'): void {
    if (isSettled(this.state)) return;
    this._generation++;
    this.controller.abort(reason);
    this.transition('aborted');
    this.error = this.abortError();
    this._rejectAbort?.(this.error as EngineError);
    this.finish();
  }

  release(): void {
    if (!isSettled(this.state)) this.abort('released');
    if (this.state !== 'released') this.transition('released');
    this.finish();
  }

  /** Adopts an already-created value while preserving AssetJob as the sole state owner. */
  adoptReady(): void {
    if (this._promise || this.state !== 'queued') {
      throw this.invalidTransition('ready');
    }
    this.progress = Object.freeze({ phase: 'queued', loaded: 1, total: 1, ratio: 1 });
    this.transition('ready');
    this.emitProgress();
    this.finish();
  }

  private abortError(cause: unknown = this.controller.signal.reason): EngineError {
    return new EngineError(EngineErrorCode.AssetJobAborted, `Asset job was aborted: ${this.key}`, {
      recovery: ErrorRecovery.Retry,
      context: { key: this.key, timeoutMs: this.timeoutMs, reason: String(this.controller.signal.reason ?? 'aborted') },
      path: `assets.jobs[${JSON.stringify(this.key)}]`,
      cause,
    });
  }

  private emitProgress(): void {
    for (const listener of this._progressListeners) listener(this.progress);
  }

  private disposeLateResult(value: T): void {
    try { this._disposeLateResult?.(value); }
    catch (error) { console.error(`[AssetJob:${this.key}] late-result disposal failed`, error); }
  }

  private finish(): void {
    if (this._timeoutId !== null) clearTimeout(this._timeoutId);
    this._timeoutId = null;
    this.owner?.untrackJob(this);
    this._rejectAbort = null;
  }

  private transition(next: AssetJobState): void {
    if (next === this._state) return;
    if (!isAllowedTransition(this._state, next)) throw this.invalidTransition(next);
    this._state = next;
  }

  private invalidTransition(next: AssetJobState): EngineError {
    return new EngineError(EngineErrorCode.AssetInvalidData, `Invalid asset job transition: ${this.state} -> ${next}`, {
      recovery: ErrorRecovery.ReleaseResource,
      context: { key: this.key, from: this.state, to: next },
      path: `assets.jobs[${JSON.stringify(this.key)}].state`,
    });
  }
}

/** Owner-scoped cancellation used by scenes, components, imports and editor sessions. */
export class AssetOwnerScope {
  readonly controller = new AbortController();
  private readonly _jobs = new Set<{ abort(reason?: unknown): void }>();

  constructor(readonly label: string) {}

  get signal(): AbortSignal { return this.controller.signal; }
  get pendingJobCount(): number { return this._jobs.size; }

  abort(reason: unknown = `owner-released:${this.label}`): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    for (const job of [...this._jobs]) job.abort(reason);
    this._jobs.clear();
  }

  trackJob(job: { abort(reason?: unknown): void }): void {
    if (this.controller.signal.aborted) {
      job.abort(this.controller.signal.reason);
      return;
    }
    this._jobs.add(job);
  }

  untrackJob(job: { abort(reason?: unknown): void }): void { this._jobs.delete(job); }
}

function isPendingPhase(state: AssetJobState): state is AssetJobPhase {
  return state === 'queued' || state === 'loading' || state === 'parsing' || state === 'uploading';
}

function isSettled(state: AssetJobState): boolean {
  return state === 'ready' || state === 'failed' || state === 'aborted' || state === 'released';
}

function isAllowedTransition(from: AssetJobState, to: AssetJobState): boolean {
  if (to === 'released') return true;
  if (to === 'aborted') return !isSettled(from);
  if (from === 'queued') return to === 'loading' || to === 'ready' || to === 'failed';
  if (from === 'loading') return to === 'parsing' || to === 'uploading' || to === 'ready' || to === 'failed';
  if (from === 'parsing') return to === 'uploading' || to === 'ready' || to === 'failed';
  if (from === 'uploading') return to === 'ready' || to === 'failed';
  return false;
}
