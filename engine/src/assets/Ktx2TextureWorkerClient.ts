import { WorkerChannel, type WorkerChannelLike } from '../async/WorkerChannel';
import type { Ktx2TexturePayload } from './Ktx2TextureUpload';
import {
  Ktx2TextureWorkerPoolDispatcher,
  type Ktx2TextureWorkerPoolEndpoint,
} from './Ktx2TextureWorkerPool';

export interface Ktx2TextureWorkerOptions {
  basisTranscoderCDN?: string | null | undefined;
  basisEncoderScriptUrl?: string | undefined;
  basisEncoderWasmUrl?: string | undefined;
}

export interface Ktx2TextureWorker {
  prepareTexturePayload(
    buffer: ArrayBuffer,
    label: string,
    deviceFeatures: readonly string[],
    options?: Ktx2TextureWorkerOptions,
    signal?: AbortSignal,
  ): Promise<Ktx2TexturePayload>;
}

export interface Ktx2TextureWorkerPoolOptions extends WorkerOptions {
  /** Bounded worker count. Defaults to available hardware concurrency, capped at four. */
  maxWorkers?: number | undefined;
}

type Ktx2TextureWorkerLike = WorkerChannelLike;

/**
 * Owns the request/response lifecycle for one KTX2 module worker.
 *
 * Container parsing and transcoding deliberately remain in Ktx2TextureLoader;
 * this adapter only owns transport, cancellation, validation, and teardown.
 */
export class Ktx2TextureWorkerClient implements Ktx2TextureWorker {
  private readonly channel: WorkerChannel;

  constructor(worker: Ktx2TextureWorkerLike) {
    this.channel = new WorkerChannel(worker, {
      label: 'KTX2 texture worker',
      path: 'ktx2.worker',
      context: { resourceType: 'texture/ktx2' },
    });
  }

  prepareTexturePayload(
    buffer: ArrayBuffer,
    label: string,
    deviceFeatures: readonly string[],
    options: Ktx2TextureWorkerOptions = {},
    signal?: AbortSignal,
  ): Promise<Ktx2TexturePayload> {
    return this.channel.request<Ktx2TexturePayload>(
      'prepareKtx2TexturePayload',
      { buffer, label, deviceFeatures, options },
      {
        ...(signal ? { signal } : {}),
        transfer: [buffer],
        context: { label },
        abortMessage: 'KTX2 preparation aborted.',
        validate: isKtx2TexturePayload,
      },
    );
  }

  dispose(options: { terminate?: boolean } = {}): void {
    this.channel.dispose(options);
  }
}

class BoundedKtx2TextureWorkerClient extends Ktx2TextureWorkerClient {
  private readonly dispatcher: Ktx2TextureWorkerPoolDispatcher;

  readonly workerPoolSize: number;

  constructor(workers: readonly Ktx2TextureWorkerLike[]) {
    super(workers[0]!);
    const primary: Ktx2TextureWorkerPoolEndpoint = {
      prepareTexturePayload: (buffer, label, deviceFeatures, options, signal) =>
        super.prepareTexturePayload(buffer, label, deviceFeatures, options, signal),
      dispose: options => super.dispose(options),
    };
    const endpoints: Ktx2TextureWorkerPoolEndpoint[] = [
      primary,
      ...workers.slice(1).map(worker => new Ktx2TextureWorkerClient(worker)),
    ];
    this.dispatcher = new Ktx2TextureWorkerPoolDispatcher(endpoints);
    this.workerPoolSize = this.dispatcher.size;
  }

  override prepareTexturePayload(
    buffer: ArrayBuffer,
    label: string,
    deviceFeatures: readonly string[],
    options: Ktx2TextureWorkerOptions = {},
    signal?: AbortSignal,
  ): Promise<Ktx2TexturePayload> {
    return this.dispatcher.prepareTexturePayload(buffer, label, deviceFeatures, options, signal);
  }

  override dispose(options: { terminate?: boolean } = {}): void {
    this.dispatcher.dispose(options);
  }
}

function isKtx2TexturePayload(value: unknown): value is Ktx2TexturePayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Partial<Ktx2TexturePayload>;
  return typeof payload.width === 'number'
    && typeof payload.height === 'number'
    && typeof payload.depth === 'number'
    && typeof payload.layerCount === 'number'
    && typeof payload.faceCount === 'number'
    && typeof payload.levelCount === 'number'
    && typeof payload.format === 'string'
    && (payload.uploadPath === 'gpu-native' || payload.uploadPath === 'basis-transcode')
    && Array.isArray(payload.levels)
    && payload.levels.every(level => typeof level === 'object'
      && level !== null
      && typeof level.width === 'number'
      && typeof level.height === 'number'
      && typeof level.depthOrArrayLayers === 'number'
      && level.data instanceof Uint8Array);
}

export function createKtx2TextureWorkerSource(workerEntryUrl: string): string {
  return `import ${JSON.stringify(workerEntryUrl)};`;
}

export function createKtx2TextureWorkerClientFromUrl(
  url: string | URL,
  options?: Ktx2TextureWorkerPoolOptions,
): Ktx2TextureWorkerClient {
  const { maxWorkers, ...workerOptions } = options ?? {};
  return createBoundedKtx2WorkerClient(
    () => new Worker(url, workerOptions),
    normalizeKtx2WorkerPoolSize(maxWorkers),
  );
}

export function createInlineKtx2TextureWorkerClient(
  workerEntryUrl: string,
  options?: Ktx2TextureWorkerPoolOptions,
): Ktx2TextureWorkerClient {
  const { maxWorkers, ...workerOptions } = options ?? {};
  const blob = new Blob([createKtx2TextureWorkerSource(workerEntryUrl)], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return createBoundedKtx2WorkerClient(
      () => new Worker(url, { type: 'module', ...workerOptions }),
      normalizeKtx2WorkerPoolSize(maxWorkers),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createBoundedKtx2WorkerClient(
  createWorker: () => Ktx2TextureWorkerLike,
  size: number,
): Ktx2TextureWorkerClient {
  const workers: Ktx2TextureWorkerLike[] = [];
  try {
    for (let index = 0; index < size; index++) workers.push(createWorker());
    return new BoundedKtx2TextureWorkerClient(workers);
  } catch (error) {
    for (const worker of workers) {
      try {
        worker.terminate?.();
      } catch {
        // Best-effort rollback after worker construction failure.
      }
    }
    throw error;
  }
}

function normalizeKtx2WorkerPoolSize(requested: number | undefined): number {
  const hardwareConcurrency = globalThis.navigator?.hardwareConcurrency;
  const defaultSize = Math.min(4, Math.max(1, Math.floor(hardwareConcurrency ?? 4)));
  if (requested === undefined || !Number.isFinite(requested)) return defaultSize;
  return Math.min(4, Math.max(1, Math.floor(requested)));
}
