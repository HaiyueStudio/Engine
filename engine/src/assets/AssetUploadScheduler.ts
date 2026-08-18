import type { AssetJobPriority } from './AssetJob';
import { EngineError, EngineErrorCode, ErrorRecovery } from '../core/EngineError';
import { createAbortError, monotonicNow, normalizeAsyncPriority } from '../async/AsyncPrimitives';

export interface AssetUploadTask<T> {
  readonly label: string;
  readonly bytes: number;
  readonly priority?: AssetJobPriority | number;
  readonly signal?: AbortSignal;
  upload(): T | Promise<T>;
}

export interface AssetUploadSchedulerSnapshot {
  readonly pendingTasks: number;
  readonly pendingBytes: number;
  readonly frameBudgetBytes: number;
  readonly uploadedBytes: number;
  readonly uploadCalls: number;
  readonly drainCalls: number;
  readonly maxFrameUploadedBytes: number;
  readonly uploadDurationMs: number;
  readonly peakPendingTasks: number;
  readonly peakPendingBytes: number;
  readonly cancelledTasks: number;
  readonly failedTasks: number;
}

interface PendingUpload<T = unknown> {
  task: AssetUploadTask<T>;
  priority: number;
  sequence: number;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Explicitly drained by the frame owner; atomic tasks larger than the budget are rejected. */
export class AssetUploadScheduler {
  private readonly _pending: PendingUpload[] = [];
  private _sequence = 0;
  private _uploadedBytes = 0;
  private _uploadCalls = 0;
  private _drainCalls = 0;
  private _maxFrameUploadedBytes = 0;
  private _uploadDurationMs = 0;
  private _peakPendingTasks = 0;
  private _peakPendingBytes = 0;
  private _cancelledTasks = 0;
  private _failedTasks = 0;

  readonly frameBudgetBytes: number;

  constructor(frameBudgetBytes = 8 * 1024 * 1024) {
    if (!Number.isFinite(frameBudgetBytes) || frameBudgetBytes <= 0) {
      throw new EngineError(EngineErrorCode.AssetInvalidData, 'Asset upload frame budget must be a positive finite byte count.', {
        recovery: ErrorRecovery.ReleaseResource,
        context: { frameBudgetBytes },
        path: 'assets.uploads.frameBudgetBytes',
      });
    }
    this.frameBudgetBytes = Math.floor(frameBudgetBytes);
  }

  enqueue<T>(task: AssetUploadTask<T>): Promise<T> {
    if (task.signal?.aborted) return Promise.reject(createAbortError(`Asset upload aborted: ${task.label}`, task.signal.reason));
    if (!Number.isFinite(task.bytes) || task.bytes < 0) {
      return Promise.reject(new EngineError(EngineErrorCode.AssetInvalidData, `Asset upload task has an invalid byte count: ${task.label}`, {
        recovery: ErrorRecovery.ReleaseResource,
        context: { label: task.label, bytes: task.bytes },
        path: 'assets.uploads.task.bytes',
      }));
    }
    const bytes = task.bytes;
    if (this.frameBudgetBytes > 0 && bytes > this.frameBudgetBytes) {
      return Promise.reject(new EngineError(
        EngineErrorCode.AssetInvalidData,
        `Asset upload task exceeds the per-frame budget: ${task.label}`,
        {
          recovery: ErrorRecovery.ReleaseResource,
          context: { label: task.label, bytes, frameBudgetBytes: this.frameBudgetBytes },
          path: 'assets.uploads.task.bytes',
          hint: 'Split large uploads into mip, layer, mesh, or buffer-view chunks before scheduling them.',
        },
      ));
    }
    return new Promise<T>((resolve, reject) => {
      this._pending.push({
        task,
        priority: normalizeAsyncPriority(task.priority),
        sequence: ++this._sequence,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this._pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      this._peakPendingTasks = Math.max(this._peakPendingTasks, this._pending.length);
      this._peakPendingBytes = Math.max(
        this._peakPendingBytes,
        this._pending.reduce((total, pending) => total + Math.max(0, pending.task.bytes), 0),
      );
    });
  }

  /**
   * Drains pending uploads up to the requested budget. Because upload tasks are
   * atomic, the first task may exceed a caller-supplied sub-budget to guarantee
   * progress; enqueue() still rejects tasks above the configured frame budget.
   */
  async drainFrame(budgetBytes = this.frameBudgetBytes): Promise<number> {
    let uploaded = 0;
    const budget = Math.max(0, budgetBytes);
    if (budget === 0) return 0;
    this._drainCalls++;
    while (this._pending.length > 0) {
      const next = this._pending.shift();
      if (!next) break;
      const bytes = Math.max(0, next.task.bytes);
      if (uploaded > 0 && uploaded + bytes > budget) {
        this._pending.unshift(next);
        break;
      }
      if (next.task.signal?.aborted) {
        this._cancelledTasks++;
        next.reject(createAbortError(`Asset upload aborted: ${next.task.label}`, next.task.signal.reason));
        continue;
      }
      try {
        const startedAt = monotonicNow();
        next.resolve(await next.task.upload());
        this._uploadDurationMs += monotonicNow() - startedAt;
        uploaded += bytes;
        this._uploadedBytes += bytes;
        this._uploadCalls++;
      } catch (error) {
        this._failedTasks++;
        next.reject(error);
      }
      if (budget === 0) break;
    }
    this._maxFrameUploadedBytes = Math.max(this._maxFrameUploadedBytes, uploaded);
    return uploaded;
  }

  abortAll(reason: unknown = 'upload-scheduler-disposed'): void {
    const pendingUploads = this._pending.splice(0);
    this._cancelledTasks += pendingUploads.length;
    for (const pending of pendingUploads) pending.reject(createAbortError(`Asset upload aborted: ${pending.task.label}`, reason));
  }

  snapshot(): AssetUploadSchedulerSnapshot {
    return Object.freeze({
      pendingTasks: this._pending.length,
      pendingBytes: this._pending.reduce((total, pending) => total + Math.max(0, pending.task.bytes), 0),
      frameBudgetBytes: this.frameBudgetBytes,
      uploadedBytes: this._uploadedBytes,
      uploadCalls: this._uploadCalls,
      drainCalls: this._drainCalls,
      maxFrameUploadedBytes: this._maxFrameUploadedBytes,
      uploadDurationMs: this._uploadDurationMs,
      peakPendingTasks: this._peakPendingTasks,
      peakPendingBytes: this._peakPendingBytes,
      cancelledTasks: this._cancelledTasks,
      failedTasks: this._failedTasks,
    });
  }
}
