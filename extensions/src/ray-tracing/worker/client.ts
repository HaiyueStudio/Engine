import { createAbortError, WorkerChannel, type WorkerChannelLike } from '@haiyue/engine/experimental/async';
import type { RaySceneSnapshot } from '../scene/index.js';
import { rayWorkerDiagnostic } from './diagnostics.js';
import { deserializePackedAcceleration, serializeRaySceneSnapshot } from './serialization.js';
import {
  RAY_ACCELERATION_WORKER_REQUEST_FORMAT,
  RAY_ACCELERATION_WORKER_RESPONSE_FORMAT,
  type RayAccelerationWorkerBuildOptions,
  type RayAccelerationWorkerBuildResult,
  type RayAccelerationWorkerClientCreateResult,
  type RayAccelerationWorkerClientOptions,
  type RayAccelerationWorkerRequest,
  type RayAccelerationWorkerResponse,
  type RayWorkerDiagnostic,
  type RayWorkerFactory,
} from './types.js';

interface OwnerState { generation: number; controller: AbortController; fingerprint: string }
type ChannelFault = 'queue-overflow' | 'worker-error' | 'message-error' | 'protocol-error' | 'disposed';

export class RayAccelerationWorkerClient {
  private channel: WorkerChannel;
  private readonly owners = new Map<string, OwnerState>();
  private readonly diagnosticValues: RayWorkerDiagnostic[] = [];
  private readonly queueOverflowErrors = new WeakSet<object>();
  private readonly maxRecoveryAttempts: number;
  private disposedValue = false;
  private recoveryPromise: Promise<boolean> | null = null;

  private constructor(private readonly workerFactory: RayWorkerFactory, private readonly options: RayAccelerationWorkerClientOptions, worker: WorkerChannelLike) {
    this.maxRecoveryAttempts = Math.max(0, Math.floor(options.maxRecoveryAttempts ?? 1));
    this.channel = this.createChannel(worker);
  }

  static create(workerFactory: RayWorkerFactory, options: RayAccelerationWorkerClientOptions = {}): RayAccelerationWorkerClientCreateResult {
    const diagnostics: RayWorkerDiagnostic[] = [];
    try { return Object.freeze({ client: new RayAccelerationWorkerClient(workerFactory, options, workerFactory()), diagnostics: Object.freeze(diagnostics) }); }
    catch (error) { diagnostics.push(rayWorkerDiagnostic('worker-recovery', 'error', 'RAY_WORKER_RECOVERY_FAILED', 'Failed to create the ray acceleration Worker.', { attempt: 0, cause: message(error) })); return Object.freeze({ client: null, diagnostics: Object.freeze(diagnostics) }); }
  }

  get destroyed(): boolean { return this.disposedValue; }
  get pendingCount(): number { return this.disposedValue ? 0 : this.channel.pendingCount; }
  get liveOwnerCount(): number { return this.disposedValue ? 0 : this.owners.size; }
  get diagnostics(): readonly RayWorkerDiagnostic[] { return Object.freeze([...this.diagnosticValues]); }

  async build(ownerId: string, snapshot: RaySceneSnapshot, options: RayAccelerationWorkerBuildOptions = {}): Promise<RayAccelerationWorkerBuildResult> {
    if (this.disposedValue) throw new Error('RAY_WORKER_CLIENT_DISPOSED');
    if (!ownerId) throw new TypeError('Ray Worker ownerId must be non-empty.');
    const previous = this.owners.get(ownerId); previous?.controller.abort('superseded-owner-generation');
    const controller = new AbortController(); const generation = (previous?.generation ?? 0) + 1;
    const owner: OwnerState = { generation, controller, fingerprint: snapshot.fingerprint }; this.owners.set(ownerId, owner);
    const externalAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) externalAbort(); else options.signal?.addEventListener('abort', externalAbort, { once: true });
    const diagnosticStart = this.diagnosticValues.length;
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) { this.emit(rayWorkerDiagnostic('worker-request', 'info', 'RAY_WORKER_ABORTED', 'Ray acceleration Worker request was aborted.', { ownerId, generation })); throw createAbortError('Ray acceleration build aborted.', controller.signal.reason); }
        const serialized = serializeRaySceneSnapshot(snapshot);
        const request: RayAccelerationWorkerRequest = Object.freeze({ format: RAY_ACCELERATION_WORKER_REQUEST_FORMAT, ownerId, generation,
          sourceFingerprint: snapshot.fingerprint, forceRebuild: options.forceRebuild ?? false, snapshot: serialized.snapshot });
        const channel = this.channel;
        try {
          const response = await channel.request('buildRayAcceleration', { request }, {
            signal: controller.signal, transfer: [...serialized.transfer], latestKey: `ray-acceleration:${ownerId}`,
            context: { ownerId, generation, sourceFingerprint: snapshot.fingerprint }, abortMessage: 'Ray acceleration build aborted.', validate: isWorkerResponse,
          });
          const current = this.owners.get(ownerId);
          if (this.disposedValue || current !== owner || response.ownerId !== ownerId || response.generation !== generation || response.sourceFingerprint !== snapshot.fingerprint) {
            this.emit(rayWorkerDiagnostic('worker-request', 'warning', 'RAY_WORKER_STALE_REPLY', 'A stale ray acceleration Worker reply was discarded.', { ownerId, generation, responseGeneration: response.generation }));
            throw createAbortError('Stale ray acceleration Worker reply.', 'stale-worker-reply');
          }
          const packed = response.packed ? deserializePackedAcceleration(response.packed) : null;
          return Object.freeze({ ...response, packed, workerDiagnostics: Object.freeze(this.diagnosticValues.slice(diagnosticStart)) });
        } catch (error) {
          if (controller.signal.aborted || isAbort(error)) throw error;
          if (isObject(error) && this.queueOverflowErrors.has(error)) throw error;
          if (!channel.isFaulted) throw error;
          if (attempt >= this.maxRecoveryAttempts) { this.emit(rayWorkerDiagnostic('worker-recovery', 'error', 'RAY_WORKER_RECOVERY_FAILED', 'Ray acceleration Worker exhausted its bounded recovery attempts.', { ownerId, generation, attempts: this.maxRecoveryAttempts, cause: message(error) })); throw error; }
          const recovered = await this.recover(attempt + 1, ownerId, generation);
          if (!recovered) throw error;
        }
      }
    } finally { options.signal?.removeEventListener('abort', externalAbort); }
  }

  async releaseOwner(ownerId: string): Promise<boolean> {
    const owner = this.owners.get(ownerId); if (!owner) return false;
    owner.controller.abort('owner-released'); this.owners.delete(ownerId);
    this.emit(rayWorkerDiagnostic('worker-lifecycle', 'info', 'RAY_WORKER_OWNER_RELEASED', 'Ray acceleration Worker owner was released.', { ownerId, generation: owner.generation }));
    if (this.disposedValue || this.channel.isFaulted) return true;
    try { await this.channel.request('releaseRayAccelerationOwner', { ownerId }, { latestKey: `ray-acceleration:${ownerId}`, validate: isReleaseResponse }); }
    catch { /* Owner is already retired locally; a concurrent fault owns its diagnostic. */ }
    return true;
  }

  dispose(): void {
    if (this.disposedValue) return; this.disposedValue = true;
    for (const owner of this.owners.values()) owner.controller.abort('worker-client-disposed'); this.owners.clear(); this.channel.dispose();
    this.emit(rayWorkerDiagnostic('worker-lifecycle', 'info', 'RAY_WORKER_DISPOSED', 'Ray acceleration Worker client was disposed.', {}));
  }

  private createChannel(worker: WorkerChannelLike): WorkerChannel {
    const observed = new ObservedWorker(worker, (id) => this.emit(rayWorkerDiagnostic('worker-request', 'warning', 'RAY_WORKER_STALE_REPLY', 'A late Worker response with no live request was discarded.', { requestId: id })));
    let channel: WorkerChannel;
    channel = new WorkerChannel(observed, { label: 'ray acceleration worker', path: 'rayTracing.worker', maxPending: this.options.maxPending ?? 4,
      context: { capability: 'ray-tracing' }, onDiagnostic: diagnostic => { if (diagnostic.kind === 'queue-overflow' && isObject(diagnostic.cause)) this.queueOverflowErrors.add(diagnostic.cause); const mapped = mapChannelDiagnostic(diagnostic.kind); this.emit(rayWorkerDiagnostic(mapped.phase, mapped.severity, mapped.code, mapped.message, { pendingCount: diagnostic.pendingCount })); } });
    return channel;
  }

  private async recover(attempt: number, ownerId: string, generation: number): Promise<boolean> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.emit(rayWorkerDiagnostic('worker-recovery', 'warning', 'RAY_WORKER_RECOVERY_STARTED', 'Recreating the ray acceleration Worker after a classified fault.', { ownerId, generation, attempt }));
    this.recoveryPromise = Promise.resolve().then(() => {
      if (this.disposedValue) return false;
      try { this.channel.dispose(); const worker = this.workerFactory(); if (this.disposedValue) { worker.terminate?.(); return false; } this.channel = this.createChannel(worker);
        this.emit(rayWorkerDiagnostic('worker-recovery', 'info', 'RAY_WORKER_RECOVERY_COMPLETED', 'Ray acceleration Worker recovery completed; the current source revision will be replayed.', { ownerId, generation, attempt })); return true;
      } catch (error) { this.emit(rayWorkerDiagnostic('worker-recovery', 'error', 'RAY_WORKER_RECOVERY_FAILED', 'Ray acceleration Worker recovery failed.', { ownerId, generation, attempt, cause: message(error) })); return false; }
    }).finally(() => { this.recoveryPromise = null; });
    return this.recoveryPromise;
  }

  private emit(diagnostic: RayWorkerDiagnostic): void { this.diagnosticValues.push(diagnostic); this.options.onDiagnostic?.(diagnostic); }
}

class ObservedWorker implements WorkerChannelLike {
  private readonly listeners = new Map<string, Set<(event: MessageEvent<unknown> | Event) => void>>();
  private readonly active = new Set<number>(); private terminated = false;
  constructor(private readonly worker: WorkerChannelLike, private readonly onStale: (id: number) => void) {
    worker.addEventListener('message', this.onMessage); worker.addEventListener('error', this.onError); worker.addEventListener('messageerror', this.onMessageError);
  }
  postMessage(message: unknown, transfer?: Transferable[]): void { const value = message as { id?: unknown; type?: unknown }; if (typeof value?.id === 'number') { if (value.type === 'cancel') this.active.delete(value.id); else this.active.add(value.id); } this.worker.postMessage(message, transfer); }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: MessageEvent<unknown> | Event) => void): void { let values = this.listeners.get(type); if (!values) this.listeners.set(type, values = new Set()); values.add(listener); }
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: MessageEvent<unknown> | Event) => void): void { this.listeners.get(type)?.delete(listener); }
  terminate(): void { if (this.terminated) return; this.terminated = true; this.worker.removeEventListener('message', this.onMessage); this.worker.removeEventListener('error', this.onError); this.worker.removeEventListener('messageerror', this.onMessageError); this.active.clear(); this.listeners.clear(); this.worker.terminate?.(); }
  private onMessage = (event: MessageEvent<unknown> | Event): void => { const value = 'data' in event ? event.data as { id?: unknown } : null; if (typeof value?.id === 'number') { if (!this.active.delete(value.id)) this.onStale(value.id); } this.dispatch('message', event); };
  private onError = (event: MessageEvent<unknown> | Event): void => { this.active.clear(); this.dispatch('error', event); };
  private onMessageError = (event: MessageEvent<unknown> | Event): void => { this.active.clear(); this.dispatch('messageerror', event); };
  private dispatch(type: string, event: MessageEvent<unknown> | Event): void { for (const listener of [...this.listeners.get(type) ?? []]) listener(event); }
}

function isWorkerResponse(value: unknown): value is RayAccelerationWorkerResponse { if (!value || typeof value !== 'object') return false; const candidate = value as Partial<RayAccelerationWorkerResponse>; return candidate.format === RAY_ACCELERATION_WORKER_RESPONSE_FORMAT && typeof candidate.ownerId === 'string' && Number.isSafeInteger(candidate.generation) && typeof candidate.sourceFingerprint === 'string' && typeof candidate.transferBytes === 'number' && Array.isArray(candidate.dirtyRanges) && Array.isArray(candidate.diagnostics); }
function isReleaseResponse(value: unknown): value is { readonly released: boolean } { return !!value && typeof value === 'object' && typeof (value as { released?: unknown }).released === 'boolean'; }
function isAbort(error: unknown): boolean { return error instanceof DOMException ? error.name === 'AbortError' : !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'; }
function isObject(value: unknown): value is object { return (typeof value === 'object' && value !== null) || typeof value === 'function'; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mapChannelDiagnostic(kind: ChannelFault): Pick<RayWorkerDiagnostic, 'phase' | 'severity' | 'code' | 'message'> { switch (kind) { case 'queue-overflow': return { phase: 'worker-request', severity: 'error', code: 'RAY_WORKER_QUEUE_OVERFLOW', message: 'Ray acceleration Worker queue capacity was exceeded.' }; case 'worker-error': return { phase: 'worker-recovery', severity: 'warning', code: 'RAY_WORKER_CRASH', message: 'Ray acceleration Worker crashed.' }; case 'message-error': return { phase: 'worker-recovery', severity: 'warning', code: 'RAY_WORKER_MESSAGE_ERROR', message: 'Ray acceleration Worker could not deserialize a message.' }; case 'protocol-error': return { phase: 'worker-recovery', severity: 'warning', code: 'RAY_WORKER_PROTOCOL_ERROR', message: 'Ray acceleration Worker returned an incompatible response.' }; default: return { phase: 'worker-lifecycle', severity: 'info', code: 'RAY_WORKER_DISPOSED', message: 'Ray acceleration Worker channel was disposed.' }; } }
