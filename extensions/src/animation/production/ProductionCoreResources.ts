import type {AnimationCoreResourceKind} from '../Animation2DRuntime.js';
import {ProductionFrameError} from './FrameTransaction.js';

interface Resource {readonly kind: AnimationCoreResourceKind; readonly id: string; readonly path: string; readonly capability: string;}
const capability = (kind: AnimationCoreResourceKind): string => kind === 'font' ? 'core-text' : kind === 'image' ? 'images-and-nslice' : 'safe-text-expression';
const resource = (kind: AnimationCoreResourceKind, id: string): Resource => Object.freeze({kind, id, path: '$.core.resources[' + JSON.stringify(id) + ']', capability: capability(kind)});

export class ProductionCoreResourceError extends ProductionFrameError {
  override readonly cause: unknown;
  constructor(readonly resource: Resource, cause: unknown, hostMissing = false) {
    super(hostMissing ? 'E_HYA_RUNTIME_HOST_PORT' : 'E_HYA_RUNTIME_RESOURCE', resource.path,
      `Original core ${resource.kind} resource ${JSON.stringify(resource.id)} failed`);
    this.cause = cause;
  }
  get capability(): string {return this.resource.capability;}
}
export class ProductionCoreResourcePending extends ProductionFrameError {
  constructor(readonly ready: Promise<void>, readonly resources: readonly Resource[]) {
    super('E_HYA_RUNTIME_RESOURCE_PENDING', resources.length === 1 ? resources[0]!.path : '$.core.resources', 'original core resource requests are pending');
    void ready.catch(() => {});
  }
  get capabilities(): readonly string[] {return Object.freeze([...new Set(this.resources.map(value => value.capability))]);}
}

/** Observes request completion only. Loading, decoding and acquired handles stay with original owners. */
export class ProductionCoreResources {
  private readonly pending = new Set<Resource>();
  private waiter: {resolve(): void; reject(error: unknown): void} | undefined;
  private ready: Promise<void> | undefined;
  private failure: ProductionCoreResourceError | undefined;
  private disposed = false;
  private invalidate: (() => void) | undefined;
  private completed = 0;
  private cleanupErrors = 0;
  begin(kind: AnimationCoreResourceKind, id: string): () => void {
    if (this.disposed) return () => {};
    const value = resource(kind, id); this.pending.add(value); let ended = false;
    return () => {
      if (ended) return; ended = true; this.pending.delete(value); this.completed++;
      if (!this.disposed && !this.pending.size) {this.settle(); this.notify();}
    };
  }
  fail(kind: AnimationCoreResourceKind, id: string, error: unknown, hostMissing = false): void {
    if (this.disposed) return;
    this.failure ??= new ProductionCoreResourceError(resource(kind, id), error, hostMissing);
    this.settle(); this.notify();
  }
  assertReady(): void {
    this.live(); if (this.failure) throw this.failure;
    if (this.pending.size) throw new ProductionCoreResourcePending(this.whenReady(), Object.freeze([...this.pending]));
  }
  whenReady(): Promise<void> {
    if (this.disposed) return this.rejected(new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource observer is disposed'));
    if (this.failure) return this.rejected(this.failure);
    if (!this.pending.size) return Promise.resolve();
    // Repeated failed frame attempts share one completion signal while resources are pending.
    // They must not accumulate a waiter per animation tick or caller retry.
    this.ready ??= new Promise((resolve, reject) => {this.waiter = {resolve, reject};});
    return this.ready;
  }
  setInvalidation(invalidate: (() => void) | undefined): void {this.live(); this.invalidate = invalidate;}
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.invalidate = undefined;
    const error = new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource observer is disposed');
    const waiter = this.waiter; this.waiter = undefined; this.ready = undefined; waiter?.reject(error); this.pending.clear();
  }
  private settle(): void {
    if (!this.failure && this.pending.size) return;
    const waiter = this.waiter; this.waiter = undefined; this.ready = undefined;
    if (waiter) this.failure ? waiter.reject(this.failure) : waiter.resolve();
  }
  private notify(): void {try {this.invalidate?.();} catch {this.cleanupErrors++;}}
  private rejected(error: unknown): Promise<void> {const value = Promise.reject<void>(error); void value.catch(() => {}); return value;}
  private live(): void {if (this.disposed) throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED', '$.core.resources', 'core resource observer is disposed');}
  get stats(): Readonly<{pending: number; completed: number; failed: boolean; waiters: number; disposed: boolean; cleanupErrors: number}> {
    return Object.freeze({pending: this.pending.size, completed: this.completed, failed: this.failure !== undefined, waiters: this.waiter ? 1 : 0, disposed: this.disposed, cleanupErrors: this.cleanupErrors});
  }
}
