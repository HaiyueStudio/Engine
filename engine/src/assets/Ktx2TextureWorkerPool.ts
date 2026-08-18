import {
  EngineError,
  EngineErrorCode,
  ErrorDomain,
  ErrorRecovery,
} from '../core/EngineError';
import type {
  Ktx2TexturePayload,
  Ktx2TextureWorker,
  Ktx2TextureWorkerOptions,
} from './Ktx2TextureLoader';
import { createAbortError } from '../async/AsyncPrimitives';

export interface Ktx2TextureWorkerPoolEndpoint extends Ktx2TextureWorker {
  dispose(options?: { terminate?: boolean }): void;
}

interface Ktx2TextureWorkerPoolSlot {
  readonly endpoint: Ktx2TextureWorkerPoolEndpoint;
  busy: boolean;
  retired: boolean;
}

interface Ktx2TextureWorkerPoolJob {
  readonly buffer: ArrayBuffer;
  readonly label: string;
  readonly deviceFeatures: readonly string[];
  readonly options: Ktx2TextureWorkerOptions;
  readonly signal?: AbortSignal;
  resolve(value: Ktx2TexturePayload): void;
  reject(error: unknown): void;
  abortListener?: () => void;
  started: boolean;
}

/** FIFO, bounded dispatcher over independent single-threaded Basis workers. */
export class Ktx2TextureWorkerPoolDispatcher implements Ktx2TextureWorker {
  private readonly slots: Ktx2TextureWorkerPoolSlot[];
  private readonly queued: Ktx2TextureWorkerPoolJob[] = [];
  private readonly maxQueued: number;
  private disposed = false;

  readonly size: number;

  constructor(endpoints: readonly Ktx2TextureWorkerPoolEndpoint[]) {
    if (endpoints.length === 0) {
      throw new EngineError(
        EngineErrorCode.AssetInvalidData,
        'KTX2 texture worker pool requires at least one worker.',
        { path: 'ktx2.workerPool.size', context: { size: endpoints.length } },
      );
    }
    this.slots = endpoints.map(endpoint => ({ endpoint, busy: false, retired: false }));
    this.size = this.slots.length;
    this.maxQueued = this.size * 64;
  }

  prepareTexturePayload(
    buffer: ArrayBuffer,
    label: string,
    deviceFeatures: readonly string[],
    options: Ktx2TextureWorkerOptions = {},
    signal?: AbortSignal,
  ): Promise<Ktx2TexturePayload> {
    if (this.disposed) throw createDisposedPoolError(label);
    if (signal?.aborted) return Promise.reject(createAbortError('KTX2 worker pool request aborted.', signal.reason));
    if (this.queued.length >= this.maxQueued) {
      return Promise.reject(new EngineError(
        EngineErrorCode.WorkerProtocolInvalid,
        'KTX2 worker pool queue is full.',
        {
          domain: ErrorDomain.Worker,
          recovery: ErrorRecovery.Retry,
          path: 'ktx2.workerPool.queue',
          context: { label, queued: this.queued.length, maxQueued: this.maxQueued },
          hint: 'Wait for pending texture preparation to complete before scheduling more work.',
        },
      ));
    }
    return new Promise<Ktx2TexturePayload>((resolve, reject) => {
      const job: Ktx2TextureWorkerPoolJob = {
        buffer,
        label,
        deviceFeatures,
        options,
        ...(signal ? { signal } : {}),
        resolve,
        reject,
        started: false,
      };
      if (signal) {
        job.abortListener = () => {
          if (job.started) return;
          const index = this.queued.indexOf(job);
          if (index >= 0) this.queued.splice(index, 1);
          cleanupPoolJob(job);
          reject(createAbortError('KTX2 worker pool request aborted.', signal.reason));
        };
        signal.addEventListener('abort', job.abortListener, { once: true });
      }
      this.queued.push(job);
      this.pump();
    });
  }

  dispose(options: { terminate?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queued.splice(0);
    for (const job of queued) {
      cleanupPoolJob(job);
      job.reject(createDisposedPoolError(job.label));
    }
    for (const slot of this.slots) slot.endpoint.dispose(options);
  }

  private pump(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (slot.busy || slot.retired) continue;
      const job = this.queued.shift();
      if (!job) break;
      if (job.signal?.aborted) {
        cleanupPoolJob(job);
        job.reject(createAbortError('KTX2 worker pool request aborted.', job.signal.reason));
        continue;
      }

      job.started = true;
      cleanupPoolJob(job);
      slot.busy = true;
      let pending: Promise<Ktx2TexturePayload>;
      try {
        pending = slot.endpoint.prepareTexturePayload(
          job.buffer,
          job.label,
          job.deviceFeatures,
          job.options,
          job.signal,
        );
      } catch (error) {
        pending = Promise.reject(error);
      }
      void pending.then(job.resolve, error => {
        if (isTerminalKtx2WorkerError(error)) slot.retired = true;
        job.reject(error);
      }).finally(() => {
        slot.busy = false;
        this.pump();
      });
    }
    if (
      this.queued.length > 0
      && !this.slots.some(slot => !slot.retired)
    ) {
      const queued = this.queued.splice(0);
      for (const job of queued) {
        cleanupPoolJob(job);
        job.reject(createUnavailablePoolError(job.label));
      }
    }
  }
}

function isTerminalKtx2WorkerError(error: unknown): boolean {
  return error instanceof EngineError
    && error.domain === ErrorDomain.Worker
    && error.recovery === ErrorRecovery.TerminateRuntime;
}

function cleanupPoolJob(job: Ktx2TextureWorkerPoolJob): void {
  if (job.signal && job.abortListener) {
    job.signal.removeEventListener('abort', job.abortListener);
    delete job.abortListener;
  }
}

function createDisposedPoolError(label: string): EngineError {
  return new EngineError(
    EngineErrorCode.AssetLoadFailed,
    'KTX2 texture worker pool has been disposed.',
    {
      hint: 'Create a new KTX2 texture worker pool before loading worker-backed compressed textures.',
      docsPath: 'errors/E_ASSET_LOAD_FAILED',
      domain: ErrorDomain.Asset,
      recovery: ErrorRecovery.ReleaseResource,
      context: { label },
      path: 'ktx2.workerPool',
    },
  );
}

function createUnavailablePoolError(label: string): EngineError {
  return new EngineError(
    EngineErrorCode.WorkerProtocolInvalid,
    'No healthy KTX2 texture workers remain in the pool.',
    {
      hint: 'Dispose this pool and create a new KTX2 texture worker client before retrying.',
      docsPath: 'errors/E_WORKER_PROTOCOL_INVALID',
      domain: ErrorDomain.Worker,
      recovery: ErrorRecovery.TerminateRuntime,
      context: { label, resourceType: 'texture/ktx2' },
      path: 'ktx2.workerPool',
    },
  );
}
