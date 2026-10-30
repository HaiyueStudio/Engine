import {ProductionFrameError, type ProductionFrameStage} from './FrameTransaction.js';

interface TransactionPort<Args extends readonly unknown[], Result> {
  begin(transaction: number): void; invoke(...args: Args): Result;
  commit(transaction: number): void; rollback(transaction: number): void;
}
const hosts = new WeakMap<object, {sequence: number; active?: object}>();

/** Adapts existing per-operation ports to one borrowed host transaction per whole player frame. */
export class ProductionTransactionPort<Args extends readonly unknown[], Result> {
  readonly port: TransactionPort<Args, Result>;
  private active: Readonly<{token: object; transaction: number}> | undefined;
  private readonly local = new Map<number, Set<number>>();
  private portSequence = 0;
  private failed = false;
  private logicalCommit = false;
  private disposed = false;
  private readonly retired = new WeakSet<object>();
  constructor(private readonly host: TransactionPort<Args, Result>) {
    this.port = this.createPort();
  }
  /** Each existing runtime keeps its own numeric transaction namespace. */
  createPort(): TransactionPort<Args, Result> {
    if (!Number.isSafeInteger(this.portSequence + 1)) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.transaction', 'local port identities exhausted');
    const namespace = ++this.portSequence;
    return Object.freeze({begin: (transaction: number) => {
      this.requireActive();
      const local = this.local.get(namespace) ?? new Set<number>();
      if (this.logicalCommit || this.failed || !Number.isSafeInteger(transaction) || local.has(transaction)) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'duplicate or invalid local transaction');
      local.add(transaction); this.local.set(namespace, local);
    }, invoke: (...args: Args): Result => {
      this.requireActive();
      if (!this.local.get(namespace)?.size || this.failed || this.logicalCommit) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'host invocation requires a live local frame transaction');
      return this.host.invoke(...args);
    }, commit: (transaction: number) => {
      this.requireLocal(namespace, transaction); const local = this.local.get(namespace)!; local.delete(transaction); if (!local.size) this.local.delete(namespace);
    }, rollback: (transaction: number) => {
      this.requireActive(); const local = this.local.get(namespace);
      if (local?.delete(transaction)) {this.failed = true; if (!local.size) this.local.delete(namespace);}
    }});
  }
  stage(id: string): ProductionFrameStage {
    return Object.freeze({id, phase: 'input-queue', prepare: () => {
      const token = this.beginFrame();
      return Object.freeze({commit: () => this.commitFrame(token), rollback: () => this.rollbackFrame(token), finalize: () => this.finalizeFrame(token), publish: () => this.publishFrame(token)});
    }, dispose: () => this.dispose()});
  }
  dispose(): void {
    if (this.disposed) return;
    try {if (this.active) this.rollbackFrame(this.active.token);} finally {this.disposed = true;}
    // The actual host is borrowed. Never dispose/reset its unrelated users.
  }
  private beginFrame(): object {
    if (this.disposed || this.active) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'port frame is not idle');
    const state = hosts.get(this.host) ?? {sequence: 0};
    if (state.active) throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT', '$.transaction', 'the same borrowed host is already evaluating another frame');
    if (!Number.isSafeInteger(state.sequence + 1)) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.transaction', 'host transaction sequence exhausted');
    const token = Object.freeze({}), transaction = ++state.sequence; state.active = token; hosts.set(this.host, state);
    this.active = {token, transaction}; this.failed = false; this.logicalCommit = false; this.local.clear();
    try {this.host.begin(transaction); return token;}
    catch (error) {try {this.host.rollback(transaction);} finally {this.finish();} throw error;}
  }
  private commitFrame(token: object): void {
    this.requireToken(token);
    this.logicalCommit = true;
  }
  private publishFrame(token: object): void {
    const frame = this.requireToken(token);
    if (!this.logicalCommit) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'logical frame was not committed');
    try {this.host.commit(frame.transaction);} finally {this.finish();}
  }
  private finalizeFrame(token: object): void {
    this.requireToken(token);
    // State/mixer transactions close in their later logical commit. The port stage
    // runs first, but publication starts only after every logical owner commits.
    if (this.failed || this.local.size) {
      throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'failed or incomplete local transaction cannot publish');
    }
  }
  private rollbackFrame(token: object): void {
    if (this.retired.has(token)) return;
    const frame = this.requireToken(token);
    try {this.host.rollback(frame.transaction);} finally {this.finish();}
  }
  private finish(): void {
    const state = hosts.get(this.host);
    if (state && this.active && state.active === this.active.token) delete state.active;
    if (this.active) this.retired.add(this.active.token);
    this.active = undefined; this.local.clear(); this.logicalCommit = false; this.failed = false;
  }
  private requireActive(): NonNullable<ProductionTransactionPort<Args, Result>['active']> {
    if (this.disposed || !this.active) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'host port has no active frame');
    return this.active;
  }
  private requireToken(token: object): NonNullable<ProductionTransactionPort<Args, Result>['active']> {
    const frame = this.requireActive();
    if (frame.token !== token) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'host frame token does not match');
    return frame;
  }
  private requireLocal(namespace: number, transaction: number): void {this.requireActive(); if (!this.local.get(namespace)?.has(transaction)) throw new ProductionFrameError('E_HYA_RUNTIME_TRANSACTION', '$.transaction', 'local transaction identity does not match');}
}
