import {DataResourceOwner} from '../interaction/DataResourceOwner.js';
import type {DataResourcePort} from '../interaction/runtime-types.js';
import {ProductionFrameError, type PreparedProductionFrameStep} from './FrameTransaction.js';

type Kind = Parameters<DataResourcePort['acquire']>[0];
export interface ProductionResourceSlot {readonly slot: string; readonly kind: Kind;}
export interface ProductionResourceSelection {readonly slot: string; readonly id: string | null;}
interface Candidate {readonly id: string; ready: Promise<void>; state: 'pending' | 'ready' | 'failed'; error?: unknown;}
export class ProductionResourcePending extends ProductionFrameError {
  constructor(readonly ready: Promise<void>) {
    super('E_HYA_RUNTIME_RESOURCE_PENDING', '$.resources', 'required resource candidates are pending');
    void ready.catch(() => {});
  }
}

/** Selection/ready orchestration only. The original owner retains every acquired handle. */
export class ProductionResourceStage {
  private readonly owner: DataResourceOwner;
  private readonly slots: ReadonlyMap<string, Kind>;
  private readonly candidates = new Map<string, Candidate>();
  private current = new Map<string, string | null>();
  private prepared: ReadonlyMap<string, string | null> | undefined;
  private preparing = false;
  private disposed = false;
  private generation = 0;
  constructor(slots: readonly ProductionResourceSlot[], port: DataResourcePort,
    private readonly invalidate: () => void, private readonly diagnostic?: (error: unknown) => void) {
    if (slots.length > 100_000 || new Set(slots.map(value => value.slot)).size !== slots.length
      || slots.some(value => !value.slot || !['image', 'artboard', 'font', 'blob'].includes(value.kind)))
      fail('E_HYA_RUNTIME_REFERENCE', 'invalid, duplicate or excessive resource slots');
    if (typeof port?.acquire !== 'function' || typeof invalidate !== 'function')
      fail('E_HYA_RUNTIME_HOST_PORT', 'resource acquisition and invalidation ports are required');
    this.slots = new Map(slots.map(value => [value.slot, value.kind]));
    this.owner = new DataResourceOwner(port);
  }
  prepare(selections: readonly ProductionResourceSelection[]): PreparedProductionFrameStep {
    this.live();
    if (this.preparing || this.prepared) fail('E_HYA_RUNTIME_REENTRANT', 'resource frame is already preparing');
    if (selections.length > this.slots.size || new Set(selections.map(value => value.slot)).size !== selections.length
      || selections.some(value => !this.slots.has(value.slot) || value.id !== null && (typeof value.id !== 'string' || !value.id)))
      fail('E_HYA_RUNTIME_REFERENCE', 'every compiled resource slot requires exactly one non-empty selection');
    const desired = new Map(selections.map(value => [value.slot, value.id]));
    this.preparing = true;
    try {
      const changed: string[] = [], retired: string[] = [], pending: Promise<void>[] = [];
      for (const slot of this.candidates.keys()) if (!desired.has(slot)) {this.owner.cancelStaged(slot); this.candidates.delete(slot);}
      for (const slot of this.current.keys()) if (!desired.has(slot)) retired.push(slot);
      for (const [slot, id] of desired) {
        if (this.current.get(slot) === id) {
          if (this.candidates.has(slot)) {this.owner.cancelStaged(slot); this.candidates.delete(slot);}
          continue;
        }
        if (id === null) {if (this.candidates.has(slot)) {this.owner.cancelStaged(slot); this.candidates.delete(slot);} retired.push(slot); continue;}
        changed.push(slot);
        const candidate = this.ensure(slot, id);
        this.live();
        if (candidate.state === 'failed') throw candidate.error;
        if (candidate.state === 'pending') pending.push(candidate.ready);
      }
      if (pending.length) throw new ProductionResourcePending(Promise.all(pending).then(() => {}));
      const step = this.owner.prepareStaged(changed, retired);
      this.prepared = desired;
      let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
      return Object.freeze({value: Object.freeze(selections.map(value => Object.freeze({...value}))),
        commit: () => {
          if (state !== 'prepared') return;
          if (this.disposed || this.prepared !== desired) {state = 'rolled-back'; step.rollback(); return;}
          step.commit(); this.current = desired; this.prepared = undefined;
          for (const slot of [...changed, ...retired]) this.candidates.delete(slot);
          this.generation += changed.length || retired.length ? 1 : 0; state = 'committed';
        },
        rollback: () => {if (state !== 'prepared') return; state = 'rolled-back'; step.rollback(); if (this.prepared === desired) this.prepared = undefined;},
        publish: () => {const errors = step.publish(); if (errors.length) throw new AggregateError(errors, 'Resource retirement failed after frame publication');},
      });
    } finally {this.preparing = false;}
  }
  /** Start the original acquisition for a queued intent without publishing a selection. */
  ready(slot: string, id: string): Promise<void> {
    this.live(); if (this.preparing || this.prepared) fail('E_HYA_RUNTIME_REENTRANT', 'resource frame is already preparing');
    if (!this.slots.has(slot) || typeof id !== 'string' || !id) fail('E_HYA_RUNTIME_REFERENCE', 'unknown resource slot or empty resource ID');
    this.preparing = true;
    try {
      if (this.current.get(slot) === id) {if (this.candidates.has(slot)) {this.owner.cancelStaged(slot); this.candidates.delete(slot);} return Promise.resolve();}
      const candidate = this.ensure(slot, id); this.live(); return candidate.ready;
    } finally {this.preparing = false;}
  }
  private ensure(slot: string, id: string): Candidate {
    let candidate = this.candidates.get(slot);
    if (candidate?.id !== id) {
      candidate = {id, ready: undefined!, state: 'pending'};
      const selected = candidate; this.candidates.set(slot, selected);
      let loading: Promise<unknown>;
      try {loading = this.owner.stage(slot, this.slots.get(slot)!, id);}
      catch (error) {selected.state = 'failed'; selected.error = error; selected.ready = Promise.reject(error); void selected.ready.catch(() => {}); throw error;}
      selected.ready = loading.then(() => {
        if (!this.disposed && this.candidates.get(slot) === selected) {selected.state = 'ready'; this.changed();}
      }, error => {
        if (!this.disposed && this.candidates.get(slot) === selected) {selected.state = 'failed'; selected.error = error; this.changed();}
        throw error;
      });
      void selected.ready.catch(() => {});
      candidate = selected;
    }
    return candidate;
  }
  /** Text/layout read the candidate identity only inside the prepared whole-frame barrier. */
  selection(slot: string): string | null | undefined {this.live(); return (this.prepared ?? this.current).get(slot);}
  retryFailed(): void {
    this.live(); if (this.preparing || this.prepared) fail('E_HYA_RUNTIME_REENTRANT', 'resource frame is already preparing');
    for (const [slot, candidate] of this.candidates) if (candidate.state === 'failed') {this.owner.cancelStaged(slot); this.candidates.delete(slot);}
    this.changed();
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.prepared = undefined; this.current.clear(); this.candidates.clear(); this.owner.dispose();
  }
  get stats(): Readonly<{generation: number; pending: number; ready: number; failed: number; handles: number; disposed: boolean}> {
    return Object.freeze({generation: this.generation, pending: [...this.candidates.values()].filter(value => value.state === 'pending').length,
      ready: [...this.candidates.values()].filter(value => value.state === 'ready').length,
      failed: [...this.candidates.values()].filter(value => value.state === 'failed').length,
      handles: this.owner.stats.handles + this.owner.stagedStats.ready, disposed: this.disposed});
  }
  private live(): void {if (this.disposed) fail('E_HYA_RUNTIME_DISPOSED', 'resource selection owner is disposed');}
  private changed(): void {try {this.invalidate();} catch (error) {try {this.diagnostic?.(error);} catch {/* Diagnostics cannot change a resource generation. */}}}
}
function fail(code: string, message: string): never {throw new ProductionFrameError(code, '$.resources', message);}
