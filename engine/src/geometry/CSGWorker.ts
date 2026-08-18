import {
  deserializeEngineError,
  EngineError,
  EngineErrorCode,
  ErrorDomain,
  ErrorRecovery,
} from '../core/EngineError';
import { Geometry3D } from './Geometry3D';
import type { CSGOperation } from './CSG';
import { createCSGWorkerSource } from './CSGWorkerRuntime';
import type { CSGPreparedGeometry, CSGWorker } from './CSGWorkerPublic';
import {
  assertCSGOperation,
  copyAndValidateTransform,
  copyGeometryData,
  geometryDataByteLength,
  geometryDataTransferList,
  geometryFromData,
  hasResponseId,
  isCSGGeometryData,
  isCSGWorkerResponse,
} from './CSGWorkerProtocol';
import type {
  CSGCancelRequest,
  CSGComputeRequest,
  CSGPrepareRequest,
  CSGReleaseRequest,
  CSGWorkerComputeOptions,
  CSGWorkerDiagnostics,
  CSGWorkerLike,
  CSGWorkerOperand,
  SerializedCSGWorkerOperand,
} from './CSGWorkerProtocol';

interface PendingPreparation {
  readonly id: number;
  readonly handle: CSGPreparedGeometry;
  readonly resolve: (handle: CSGPreparedGeometry) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
}

interface PendingCompute {
  readonly id: number;
  readonly operation: CSGOperation;
  readonly a: SerializedCSGWorkerOperand;
  readonly b: SerializedCSGWorkerOperand;
  readonly resolve: (geometry: Geometry3D) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
  posted: boolean;
}

const preparedGeometryOwners = new WeakMap<CSGPreparedGeometry, CSGWorkerClient>();

/**
 * Owns one dedicated CSG worker. Compute requests are coalesced to one active
 * request plus one latest queued request so interactive controls cannot build
 * an unbounded BSP workload.
 */
class CSGWorkerClient implements CSGWorker {
  private readonly pendingPreparations = new Map<number, PendingPreparation>();
  private readonly preparedHandles = new Map<number, CSGPreparedGeometry>();
  private nextRequestId = 1;
  private nextHandleId = 1;
  private activeCompute: PendingCompute | null = null;
  private queuedCompute: PendingCompute | null = null;
  private disposed = false;
  private fault: EngineError | null = null;
  private requestsPosted = 0;
  private computeRequestsPosted = 0;
  private supersededComputeCount = 0;
  private abortedRequestCount = 0;
  private inputTransferBytes = 0;
  private outputTransferBytes = 0;

  constructor(private readonly worker: CSGWorkerLike) {
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onWorkerError);
    this.worker.addEventListener('messageerror', this.onMessageError);
  }

  get diagnostics(): CSGWorkerDiagnostics {
    return {
      pendingRequestCount: this.pendingPreparations.size
        + (this.activeCompute ? 1 : 0)
        + (this.queuedCompute ? 1 : 0),
      preparedGeometryCount: this.preparedHandles.size,
      hasActiveCompute: this.activeCompute !== null,
      hasQueuedCompute: this.queuedCompute !== null,
      requestsPosted: this.requestsPosted,
      computeRequestsPosted: this.computeRequestsPosted,
      supersededComputeCount: this.supersededComputeCount,
      abortedRequestCount: this.abortedRequestCount,
      inputTransferBytes: this.inputTransferBytes,
      outputTransferBytes: this.outputTransferBytes,
    };
  }

  prepareGeometry(geometry: Geometry3D, options: CSGWorkerComputeOptions = {}): Promise<CSGPreparedGeometry> {
    this.assertAvailable();
    if (options.signal?.aborted) {
      return Promise.reject(createCSGAbortError('CSG geometry preparation was aborted.', options.signal.reason));
    }

    const id = this.nextRequestId++;
    const handle = Object.freeze({ id: this.nextHandleId++ });
    const data = copyGeometryData(geometry);
    const transfer = geometryDataTransferList(data);
    const transferBytes = geometryDataByteLength(data);

    return new Promise((resolve, reject) => {
      const pending: PendingPreparation = {
        id,
        handle,
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.abortListener = () => {
          if (!this.pendingPreparations.delete(id)) return;
          this.abortedRequestCount++;
          cleanupAbortListener(pending);
          this.safePost({ type: 'cancel', id, requestType: 'prepare' });
          this.safePost({ type: 'release', handleId: handle.id });
          reject(createCSGAbortError('CSG geometry preparation was aborted.', options.signal?.reason));
        };
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.pendingPreparations.set(id, pending);

      try {
        const request: CSGPrepareRequest = { id, type: 'prepare', handleId: handle.id, geometry: data };
        this.worker.postMessage(request, transfer);
        this.requestsPosted++;
        this.inputTransferBytes += transferBytes;
      } catch (error) {
        this.pendingPreparations.delete(id);
        cleanupAbortListener(pending);
        reject(createCSGProtocolError('Failed to send CSG geometry to the worker.', 'csg.worker.prepare', error));
      }
    });
  }

  compute(
    a: CSGWorkerOperand,
    b: CSGWorkerOperand,
    operation: CSGOperation,
    options: CSGWorkerComputeOptions = {},
  ): Promise<Geometry3D> {
    this.assertAvailable();
    assertCSGOperation(operation);
    const serializedA = this.serializeOperand(a, 'a');
    const serializedB = this.serializeOperand(b, 'b');
    if (options.signal?.aborted) {
      return Promise.reject(createCSGAbortError('CSG computation was aborted.', options.signal.reason));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingCompute = {
        id,
        operation,
        a: serializedA,
        b: serializedB,
        resolve,
        reject,
        settled: false,
        posted: false,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      if (options.signal) {
        pending.abortListener = () => this.abortCompute(pending, options.signal?.reason);
        options.signal.addEventListener('abort', pending.abortListener, { once: true });
      }

      if (!this.activeCompute) {
        this.postCompute(pending);
        return;
      }

      this.supersedeCompute(this.activeCompute);
      if (this.queuedCompute) this.supersedeCompute(this.queuedCompute);
      this.queuedCompute = pending;
    });
  }

  releaseGeometry(handle: CSGPreparedGeometry): void {
    this.assertOwnedHandle(handle, 'geometry');
    if (!this.preparedHandles.delete(handle.id)) return;
    preparedGeometryOwners.delete(handle);
    this.safePost({ type: 'release', handleId: handle.id });
  }

  dispose(options: { terminate?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onWorkerError);
    this.worker.removeEventListener('messageerror', this.onMessageError);

    const error = createCSGProtocolError(
      'CSGWorkerClient was disposed while requests were pending.',
      'csg.worker.dispose',
    );
    for (const pending of this.pendingPreparations.values()) {
      cleanupAbortListener(pending);
      pending.reject(error);
      this.safePost({ type: 'release', handleId: pending.handle.id });
    }
    this.pendingPreparations.clear();
    this.rejectCompute(this.activeCompute, error);
    this.rejectCompute(this.queuedCompute, error);
    this.activeCompute = null;
    this.queuedCompute = null;

    for (const [handleId, handle] of this.preparedHandles) {
      preparedGeometryOwners.delete(handle);
      this.safePost({ type: 'release', handleId });
    }
    this.preparedHandles.clear();
    if (options.terminate !== false) this.worker.terminate?.();
  }

  private serializeOperand(operand: CSGWorkerOperand, path: 'a' | 'b'): SerializedCSGWorkerOperand {
    if (!operand || typeof operand !== 'object') {
      throw createCSGProtocolError(`CSG operand "${path}" must be an object.`, `csg.worker.compute.${path}`);
    }
    this.assertOwnedHandle(operand.geometry, path);
    const transform = operand.transform === undefined
      ? undefined
      : copyAndValidateTransform(operand.transform, `csg.worker.compute.${path}.transform`);
    return {
      handleId: operand.geometry.id,
      ...(transform ? { transform } : {}),
    };
  }

  private assertOwnedHandle(handle: CSGPreparedGeometry, path: string): void {
    if (!handle || typeof handle !== 'object' || !Number.isSafeInteger(handle.id)) {
      throw createCSGProtocolError('CSG prepared geometry handle is invalid.', `csg.worker.compute.${path}`);
    }
    if (preparedGeometryOwners.get(handle) !== this || !this.preparedHandles.has(handle.id)) {
      throw createCSGProtocolError(
        'CSG prepared geometry belongs to another client or has been released.',
        `csg.worker.compute.${path}`,
      );
    }
  }

  private postCompute(pending: PendingCompute): void {
    if (this.disposed || this.fault) {
      this.rejectCompute(pending, this.fault ?? createDisposedError());
      return;
    }
    this.activeCompute = pending;
    const request: CSGComputeRequest = {
      id: pending.id,
      type: 'compute',
      operation: pending.operation,
      a: pending.a,
      b: pending.b,
    };
    try {
      this.worker.postMessage(request);
      pending.posted = true;
      this.requestsPosted++;
      this.computeRequestsPosted++;
    } catch (error) {
      this.activeCompute = null;
      this.rejectCompute(
        pending,
        createCSGProtocolError('Failed to send a CSG compute request.', 'csg.worker.compute', error),
      );
      this.dispatchQueuedCompute();
    }
  }

  private supersedeCompute(pending: PendingCompute): void {
    if (pending.settled) return;
    this.supersededComputeCount++;
    this.rejectCompute(
      pending,
      createCSGAbortError('CSG computation was superseded by a newer request.'),
    );
  }

  private abortCompute(pending: PendingCompute, cause?: unknown): void {
    if (pending.settled) return;
    this.abortedRequestCount++;
    this.rejectCompute(pending, createCSGAbortError('CSG computation was aborted.', cause));
    if (this.queuedCompute === pending) {
      this.queuedCompute = null;
      return;
    }
    if (this.activeCompute === pending && pending.posted) {
      this.safePost({ type: 'cancel', id: pending.id, requestType: 'compute' });
    }
  }

  private rejectCompute(pending: PendingCompute | null, error: unknown): void {
    if (!pending || pending.settled) return;
    pending.settled = true;
    cleanupAbortListener(pending);
    pending.reject(error);
  }

  private dispatchQueuedCompute(): void {
    if (this.activeCompute || !this.queuedCompute) return;
    const queued = this.queuedCompute;
    this.queuedCompute = null;
    if (queued.settled) return;
    this.postCompute(queued);
  }

  private onMessage = (event: MessageEvent<unknown> | Event): void => {
    const response = 'data' in event ? event.data : undefined;
    if (!hasResponseId(response)) return;

    const preparation = this.pendingPreparations.get(response.id);
    if (preparation) {
      this.handlePreparationResponse(preparation, response);
      return;
    }

    if (this.activeCompute?.id === response.id) {
      this.handleComputeResponse(this.activeCompute, response);
    }
  };

  private handlePreparationResponse(pending: PendingPreparation, response: unknown): void {
    this.pendingPreparations.delete(pending.id);
    cleanupAbortListener(pending);
    if (!isCSGWorkerResponse(response)) {
      pending.reject(createCSGProtocolError(
        'CSG worker returned an invalid preparation response.',
        'csg.worker.response',
        response,
      ));
      this.safePost({ type: 'release', handleId: pending.handle.id });
      return;
    }
    if (!response.ok) {
      pending.reject(deserializeEngineError(response.error, { path: 'csg.worker.response.error' }));
      return;
    }
    if (response.type !== 'prepared' || response.handleId !== pending.handle.id) {
      pending.reject(createCSGProtocolError(
        'CSG worker returned a mismatched prepared geometry handle.',
        'csg.worker.response.handle',
        response,
      ));
      this.safePost({ type: 'release', handleId: pending.handle.id });
      return;
    }
    this.preparedHandles.set(pending.handle.id, pending.handle);
    preparedGeometryOwners.set(pending.handle, this);
    pending.resolve(pending.handle);
  }

  private handleComputeResponse(pending: PendingCompute, response: unknown): void {
    this.activeCompute = null;
    if (!isCSGWorkerResponse(response)) {
      this.rejectCompute(
        pending,
        createCSGProtocolError('CSG worker returned an invalid compute response.', 'csg.worker.response', response),
      );
      this.dispatchQueuedCompute();
      return;
    }
    if (!response.ok) {
      this.rejectCompute(
        pending,
        deserializeEngineError(response.error, { path: 'csg.worker.response.error' }),
      );
      this.dispatchQueuedCompute();
      return;
    }
    if (response.type !== 'computed' || !isCSGGeometryData(response.geometry)) {
      this.rejectCompute(
        pending,
        createCSGProtocolError('CSG worker returned invalid geometry data.', 'csg.worker.response.geometry', response),
      );
      this.dispatchQueuedCompute();
      return;
    }

    this.outputTransferBytes += geometryDataByteLength(response.geometry);
    if (!pending.settled) {
      try {
        pending.settled = true;
        cleanupAbortListener(pending);
        pending.resolve(geometryFromData(response.geometry));
      } catch (error) {
        pending.settled = true;
        cleanupAbortListener(pending);
        pending.reject(error);
      }
    }
    this.dispatchQueuedCompute();
  }

  private onWorkerError = (event: MessageEvent<unknown> | Event): void => {
    this.failWorker('CSG worker execution failed.', 'csg.worker.error', event);
  };

  private onMessageError = (event: MessageEvent<unknown> | Event): void => {
    this.failWorker('CSG worker could not deserialize a message.', 'csg.worker.messageerror', event);
  };

  private failWorker(message: string, path: string, cause: unknown): void {
    if (this.disposed || this.fault) return;
    this.fault = createCSGProtocolError(message, path, cause);
    for (const pending of this.pendingPreparations.values()) {
      cleanupAbortListener(pending);
      pending.reject(this.fault);
    }
    this.pendingPreparations.clear();
    this.rejectCompute(this.activeCompute, this.fault);
    this.rejectCompute(this.queuedCompute, this.fault);
    this.activeCompute = null;
    this.queuedCompute = null;
    for (const handle of this.preparedHandles.values()) {
      preparedGeometryOwners.delete(handle);
    }
    this.preparedHandles.clear();
  }

  private safePost(message: CSGReleaseRequest | CSGCancelRequest): void {
    try {
      this.worker.postMessage(message);
    } catch {
      // Cleanup is best-effort after abort/dispose; the worker may already be gone.
    }
  }

  private assertAvailable(): void {
    if (this.fault) throw this.fault;
    if (this.disposed) throw createDisposedError();
  }
}

export function createCSGWorkerClientFromUrl(url: string | URL, options?: WorkerOptions): CSGWorker {
  const WorkerConstructor = requireWorkerCapability();
  try {
    return new CSGWorkerClient(new WorkerConstructor(url, { type: 'module', ...options }));
  } catch (error) {
    throw createWorkerUnavailableError(error);
  }
}

export function createInlineCSGWorkerClient(
  geometryModuleUrl: string | URL,
  options?: WorkerOptions,
): CSGWorker {
  const WorkerConstructor = requireWorkerCapability();
  if (
    typeof Blob === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
  ) {
    throw createWorkerUnavailableError(new Error('Blob-backed module workers are unavailable.'));
  }

  const blob = new Blob([createCSGWorkerSource(String(geometryModuleUrl))], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new CSGWorkerClient(new WorkerConstructor(url, { type: 'module', ...options }));
  } catch (error) {
    throw createWorkerUnavailableError(error);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cleanupAbortListener(pending: { signal?: AbortSignal; abortListener?: () => void }): void {
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener('abort', pending.abortListener);
  }
}

function createCSGAbortError(message: string, cause?: unknown): Error {
  const error = new Error(message, { cause });
  error.name = 'AbortError';
  return error;
}

function createCSGProtocolError(message: string, path: string, cause?: unknown): EngineError {
  return new EngineError(EngineErrorCode.WorkerProtocolInvalid, message, {
    domain: ErrorDomain.Worker,
    recovery: ErrorRecovery.TerminateRuntime,
    context: {},
    path,
    hint: 'Use a live CSGWorkerClient with prepared geometry handles created by that client.',
    docsPath: 'errors/E_WORKER_PROTOCOL_INVALID',
    ...(cause === undefined ? {} : { cause }),
  });
}

function createDisposedError(): EngineError {
  return createCSGProtocolError('CSGWorkerClient has been disposed.', 'csg.worker');
}

function createWorkerUnavailableError(cause: unknown): EngineError {
  return new EngineError(
    EngineErrorCode.WorkerProtocolInvalid,
    'Dedicated CSG Web Workers are unavailable in this environment.',
    {
      domain: ErrorDomain.Worker,
      recovery: ErrorRecovery.TerminateRuntime,
      context: { capability: 'Worker' },
      path: 'csg.worker.capability',
      hint: 'Provide a module-worker URL allowed by the page worker-src CSP. Synchronous fallback is intentionally disabled.',
      docsPath: 'errors/E_WORKER_PROTOCOL_INVALID',
      cause,
    },
  );
}

function requireWorkerCapability(): typeof Worker {
  if (typeof Worker === 'undefined') {
    throw createWorkerUnavailableError(new Error('The Worker constructor is not defined.'));
  }
  return Worker;
}
