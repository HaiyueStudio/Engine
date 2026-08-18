import {
  deserializeEngineError,
  EngineError,
  EngineErrorCode,
  ErrorDomain,
  ErrorRecovery,
  isSerializedEngineError,
} from '../core/EngineError';
import type { SerializedEngineError } from '../core/EngineError';
import { createAbortError, normalizeAsyncPriority, type AsyncPriority } from './AsyncPrimitives';

export const WORKER_CHANNEL_PROTOCOL_VERSION = 1 as const;

export interface WorkerChannelRequestEnvelope {
  readonly version: typeof WORKER_CHANNEL_PROTOCOL_VERSION;
  readonly id: number;
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface WorkerChannelSuccessEnvelope {
  readonly version: typeof WORKER_CHANNEL_PROTOCOL_VERSION;
  readonly id: number;
  readonly ok: true;
  readonly value: unknown;
}

export interface WorkerChannelFailureEnvelope {
  readonly version: typeof WORKER_CHANNEL_PROTOCOL_VERSION;
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedEngineError;
}

export type WorkerChannelResponseEnvelope = WorkerChannelSuccessEnvelope | WorkerChannelFailureEnvelope;

export interface WorkerChannelLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<unknown> | Event) => void,
  ): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent<unknown> | Event) => void,
  ): void;
  terminate?(): void;
}

export interface WorkerChannelDiagnostic {
  readonly kind: 'queue-overflow' | 'worker-error' | 'message-error' | 'protocol-error' | 'disposed';
  readonly path: string;
  readonly pendingCount: number;
  readonly cause?: unknown;
}

export interface WorkerChannelOptions {
  readonly label: string;
  readonly path: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly maxPending?: number;
  readonly onDiagnostic?: (diagnostic: WorkerChannelDiagnostic) => void;
}

export interface WorkerTaskOptions<T> {
  readonly signal?: AbortSignal;
  readonly transfer?: Transferable[];
  readonly priority?: AsyncPriority | number;
  readonly latestKey?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly validate: (value: unknown) => value is T;
  readonly abortMessage?: string;
}

interface PendingWorkerTask {
  readonly id: number;
  readonly type: string;
  readonly priority: number;
  readonly latestKey?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly validate: (value: unknown) => boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly abortMessage: string;
  abortListener?: () => void;
}

/** Capability-agnostic, versioned request channel. Payload validation stays with each consumer. */
export class WorkerChannel {
  private readonly pending = new Map<number, PendingWorkerTask>();
  private readonly latest = new Map<string, number>();
  private readonly maxPending: number;
  private nextId = 1;
  private disposed = false;
  private terminated = false;
  private fault: EngineError | null = null;

  constructor(private readonly worker: WorkerChannelLike, private readonly options: WorkerChannelOptions) {
    this.maxPending = Math.max(1, Math.floor(options.maxPending ?? 64));
    worker.addEventListener('message', this.onMessage);
    worker.addEventListener('error', this.onWorkerError);
    worker.addEventListener('messageerror', this.onMessageError);
  }

  get pendingCount(): number { return this.pending.size; }
  get isDisposed(): boolean { return this.disposed; }
  get isFaulted(): boolean { return this.fault !== null; }

  request<T>(
    type: string,
    payload: Readonly<Record<string, unknown>>,
    task: WorkerTaskOptions<T>,
  ): Promise<T> {
    if (this.fault) throw this.fault;
    if (this.disposed) throw this.createError(`${this.options.label} has been disposed.`, this.options.path, undefined, task.context);
    if (task.signal?.aborted) {
      return Promise.reject(createAbortError(task.abortMessage ?? `${this.options.label} request aborted.`, task.signal.reason));
    }
    if (this.pending.size >= this.maxPending) {
      const error = this.createError(
        `${this.options.label} request queue is full.`,
        `${this.options.path}.queue`,
        undefined,
        { ...task.context, maxPending: this.maxPending, requestType: type },
      );
      this.emitDiagnostic('queue-overflow', error.path ?? `${this.options.path}.queue`, error);
      return Promise.reject(error);
    }

    if (task.latestKey) {
      const previousId = this.latest.get(task.latestKey);
      const previous = previousId === undefined ? undefined : this.pending.get(previousId);
      if (previous) this.cancelPending(previous, `superseded:${task.latestKey}`, true);
    }

    const id = this.nextId++;
    const message: WorkerChannelRequestEnvelope = {
      version: WORKER_CHANNEL_PROTOCOL_VERSION,
      id,
      type,
      ...payload,
    };
    return new Promise<T>((resolve, reject) => {
      const pending: PendingWorkerTask = {
        id,
        type,
        priority: normalizeAsyncPriority(task.priority),
        ...(task.latestKey ? { latestKey: task.latestKey } : {}),
        ...(task.context ? { context: task.context } : {}),
        ...(task.signal ? { signal: task.signal } : {}),
        validate: task.validate,
        resolve: value => resolve(value as T),
        reject,
        abortMessage: task.abortMessage ?? `${this.options.label} request aborted.`,
      };
      if (task.signal) {
        pending.abortListener = () => this.cancelPending(pending, task.signal?.reason, true);
        task.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      if (task.latestKey) this.latest.set(task.latestKey, id);
      try {
        this.worker.postMessage(message, task.transfer);
      } catch (cause) {
        this.removePending(pending);
        reject(this.createError(
          `Failed to send a ${this.options.label} request.`,
          `${this.options.path}.request`,
          cause,
          { ...task.context, requestType: type },
        ));
      }
    });
  }

  dispose(options: { terminate?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeListeners();
    const error = this.createError(
      `${this.options.label} was disposed while requests were pending.`,
      this.options.path,
      undefined,
      { pendingCount: this.pending.size },
    );
    this.emitDiagnostic('disposed', this.options.path, error);
    for (const pending of [...this.pending.values()]) {
      this.removePending(pending);
      pending.reject(error);
    }
    if (options.terminate !== false) this.terminate();
  }

  private onMessage = (event: MessageEvent<unknown> | Event): void => {
    const response = 'data' in event ? event.data : undefined;
    if (!isResponseIdentity(response)) {
      this.fail('protocol-error', `${this.options.label} returned an unidentifiable response.`, `${this.options.path}.response`, response);
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (!isWorkerChannelResponse(response)) {
      this.fail('protocol-error', `${this.options.label} returned an invalid or incompatible response.`, `${this.options.path}.response`, response);
      return;
    }
    this.removePending(pending);
    if (!response.ok) {
      pending.reject(deserializeEngineError(response.error));
      return;
    }
    if (!pending.validate(response.value)) {
      const error = this.createError(
        `${this.options.label} returned an invalid value.`,
        `${this.options.path}.response.value`,
        response.value,
        { ...pending.context, requestType: pending.type },
      );
      pending.reject(error);
      this.fail('protocol-error', error.message, error.path ?? `${this.options.path}.response.value`, response.value, error);
      return;
    }
    pending.resolve(response.value);
  };

  private onWorkerError = (event: MessageEvent<unknown> | Event): void => {
    this.fail('worker-error', `${this.options.label} execution failed.`, `${this.options.path}.error`, event);
  };

  private onMessageError = (event: MessageEvent<unknown> | Event): void => {
    this.fail('message-error', `${this.options.label} could not deserialize a message.`, `${this.options.path}.messageerror`, event);
  };

  private cancelPending(pending: PendingWorkerTask, reason: unknown, notifyWorker: boolean): void {
    if (!this.pending.has(pending.id)) return;
    this.removePending(pending);
    if (notifyWorker && !this.disposed && !this.fault) {
      try {
        this.worker.postMessage({ version: WORKER_CHANNEL_PROTOCOL_VERSION, id: pending.id, type: 'cancel' });
      } catch {
        // The local request is already retired; a concurrent worker fault will own diagnostics.
      }
    }
    pending.reject(createAbortError(pending.abortMessage, reason));
  }

  private fail(
    kind: WorkerChannelDiagnostic['kind'],
    message: string,
    path: string,
    cause: unknown,
    existing?: EngineError,
  ): void {
    if (this.disposed || this.fault) return;
    this.fault = existing ?? this.createError(message, path, cause, {
      pendingCount: this.pending.size,
      requestTypes: [...this.pending.values()].map(pending => pending.type),
    });
    this.emitDiagnostic(kind, path, cause);
    this.removeListeners();
    for (const pending of [...this.pending.values()]) {
      this.removePending(pending);
      pending.reject(this.fault);
    }
    this.terminate();
  }

  private removePending(pending: PendingWorkerTask): void {
    this.pending.delete(pending.id);
    if (pending.latestKey && this.latest.get(pending.latestKey) === pending.id) this.latest.delete(pending.latestKey);
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener('abort', pending.abortListener);
  }

  private createError(
    message: string,
    path: string,
    cause?: unknown,
    context?: Readonly<Record<string, unknown>>,
  ): EngineError {
    return new EngineError(EngineErrorCode.WorkerProtocolInvalid, message, {
      domain: ErrorDomain.Worker,
      recovery: ErrorRecovery.TerminateRuntime,
      path,
      hint: `Recreate ${this.options.label} before retrying.`,
      docsPath: 'errors/E_WORKER_PROTOCOL_INVALID',
      context: { ...this.options.context, ...context },
      ...(cause === undefined ? {} : { cause }),
    });
  }

  private emitDiagnostic(kind: WorkerChannelDiagnostic['kind'], path: string, cause?: unknown): void {
    this.options.onDiagnostic?.(Object.freeze({ kind, path, pendingCount: this.pending.size, ...(cause === undefined ? {} : { cause }) }));
  }

  private removeListeners(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.removeEventListener('messageerror', this.onMessageError);
  }

  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate?.();
  }
}

export function isWorkerChannelResponse(value: unknown): value is WorkerChannelResponseEnvelope {
  if (!isResponseIdentity(value) || value.version !== WORKER_CHANNEL_PROTOCOL_VERSION || typeof value.ok !== 'boolean') return false;
  return value.ok ? 'value' in value : isSerializedEngineError(value.error);
}

function isResponseIdentity(value: unknown): value is Record<string, unknown> & { id: number; version?: unknown; ok?: unknown } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).id === 'number';
}
