import type { NestedRuntimeFactory, NestedRuntimeInstance, RuntimeComponent } from './runtime-types.js';

interface OwnedNested { readonly definition: RuntimeComponent; readonly instance: NestedRuntimeInstance; readonly generation: number }

export class NestedRuntimeOwnerV2 {
  private readonly _definitions = new Map<string, RuntimeComponent>();
  private readonly _owned = new Map<string, OwnedNested>();
  private _generation = 0;
  private _disposed = false;
  private _transaction: Readonly<{id: number; original: ReadonlySet<string>; required: boolean}> | null = null;
  private readonly _pendingDispose = new Set<string>();

  constructor(components: readonly RuntimeComponent[], private readonly _factory?: NestedRuntimeFactory) { for (const component of components) this._definitions.set(component.id, component); }

  acquire(id: string): NestedRuntimeInstance {
    this._requireActive(); const current = this._owned.get(id); if (current) { this._pendingDispose.delete(id); return current.instance; }
    const definition = this._definitions.get(id); if (!definition) throw ownerError('E_STATE_MACHINE_RUNTIME_REFERENCE', `Unknown nested component ${id}.`);
    if (!this._factory) throw ownerError('E_STATE_MACHINE_NESTED_PORT_REQUIRED', `Nested component ${id} requires a runtime factory.`);
    const generation = ++this._generation, instance = this._factory.create(definition, generation);
    if (this._disposed) {instance.dispose(); throw ownerError('E_STATE_MACHINE_RUNTIME_DISPOSED', 'Nested owner was disposed during creation.');}
    if (this._transaction?.required) {
      try {requireTransactional(instance); instance.beginTransaction!(this._transaction.id);}
      catch (error) {instance.dispose(); throw error;}
    }
    this._owned.set(id, { definition, instance, generation }); return instance;
  }

  reconcile(active: ReadonlySet<string>): void { this._requireActive(); for (const [id, owner] of this._owned) if (!active.has(id)) { if (this._transaction) this._pendingDispose.add(id); else { owner.instance.dispose(); this._owned.delete(id); } } }
  beginTransaction(transactionId: number, required = false): void { this._requireActive(); if (this._transaction) throw ownerError('E_STATE_MACHINE_MIXER_TRANSACTION', 'Nested owner transaction is already active.'); if (required) for (const owner of this._owned.values()) requireTransactional(owner.instance); this._transaction = {id: transactionId, original: new Set(this._owned.keys()), required}; this._pendingDispose.clear(); for (const owner of this._owned.values()) owner.instance.beginTransaction?.(transactionId); }
  commitTransaction(transactionId: number): void { if (!this._transaction) throw ownerError('E_STATE_MACHINE_MIXER_TRANSACTION', 'Nested owner has no active transaction.'); for (const owner of this._owned.values()) owner.instance.commitTransaction?.(transactionId); for (const id of this._pendingDispose) { this._owned.get(id)?.instance.dispose(); this._owned.delete(id); } this._pendingDispose.clear(); this._transaction = null; }
  rollbackTransaction(transactionId: number): void { if (!this._transaction) return; const original = this._transaction.original; this._transaction = null; this._pendingDispose.clear(); for (const [id, owner] of this._owned) { if (!original.has(id)) { owner.instance.dispose(); this._owned.delete(id); } else owner.instance.rollbackTransaction?.(transactionId); } }
  reset(): void { this._requireActive(); for (const owner of this._owned.values()) owner.instance.reset(); }
  pause(): void { this._requireActive(); for (const owner of this._owned.values()) owner.instance.pause(); }
  resume(): void { this._requireActive(); for (const owner of this._owned.values()) owner.instance.resume(); }
  stop(): void { this._requireActive(); for (const owner of this._owned.values()) owner.instance.stop(); }
  dispose(): void { if (this._disposed) return; this._transaction = null; this._pendingDispose.clear(); this._disposed = true; for (const owner of this._owned.values()) owner.instance.dispose(); this._owned.clear(); this._definitions.clear(); }
  get liveCount(): number { return this._owned.size; }
  get generation(): number { return this._generation; }
  private _requireActive(): void { if (this._disposed) throw ownerError('E_STATE_MACHINE_RUNTIME_DISPOSED', 'Nested owner was disposed.'); }
}

function ownerError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
function requireTransactional(instance: NestedRuntimeInstance): void {
  if (typeof instance.beginTransaction !== 'function' || typeof instance.commitTransaction !== 'function' || typeof instance.rollbackTransaction !== 'function')
    throw ownerError('E_STATE_MACHINE_NESTED_PORT_REQUIRED', 'Composition requires transactional nested runtime hooks.');
}
