import type { DataResourceHandle, DataResourcePort } from './runtime-types.js';

export class InteractionRuntimeError extends Error {
  readonly name = 'InteractionRuntimeError';
  constructor(readonly code: 'E_DATA_RUNTIME_STATE' | 'E_DATA_RUNTIME_PATH' | 'E_DATA_RUNTIME_TYPE' | 'E_DATA_RUNTIME_LIMIT' | 'E_DATA_RUNTIME_PORT' | 'E_INTERACTION_RUNTIME_LIMIT' | 'E_INTERACTION_RUNTIME_PORT' | 'E_SEMANTICS_RUNTIME_PORT', readonly path: string, message: string) { super(`${message} (${path})`); }
}

interface Owned { generation: number; controller: AbortController; handle?: DataResourceHandle; promise: Promise<unknown> }
export class DataResourceOwner {
  private readonly entries = new Map<string, Owned>();
  private readonly staged = new Map<string, Owned>();
  private generation = 0;
  private disposed = false;
  private preparingCommit: object | undefined;
  private pendingPublication: (() => readonly unknown[]) | undefined;
  constructor(private readonly port: DataResourcePort) {}
  replace(slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<unknown> { this.assertLive(); this.assertMutable(); this.retire(slot); const generation = ++this.generation, controller = new AbortController(); const entry: Owned = { generation, controller, promise: Promise.resolve() }; entry.promise = this.port.acquire(kind, id, controller.signal).then(handle => { if (this.disposed || controller.signal.aborted || this.entries.get(slot) !== entry || entry.generation !== generation) { handle.release(); throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'late resource result was retired'); } entry.handle = handle; return handle.value; }, error => { if (this.entries.get(slot) === entry) this.entries.delete(slot); throw error; }); this.entries.set(slot, entry); return entry.promise; }
  value(slot: string): unknown { return this.entries.get(slot)?.handle?.value; }
  /** Prepare without invalidating the last committed value. Only commitStaged publishes it. */
  stage(slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<unknown> {
    this.assertLive(); this.assertMutable();
    if (!slot || !id) throw new InteractionRuntimeError('E_DATA_RUNTIME_PATH', slot, 'resource identities must be non-empty');
    this.cancelStaged(slot);
    const generation = ++this.generation, controller = new AbortController();
    const entry: Owned = {generation, controller, promise: Promise.resolve()};
    this.staged.set(slot, entry);
    let acquisition: Promise<DataResourceHandle>;
    try {acquisition = this.port.acquire(kind, id, controller.signal);}
    catch (error) {if (this.staged.get(slot) === entry) this.staged.delete(slot); controller.abort(); return Promise.reject(error);}
    entry.promise = acquisition.then(handle => {
      try {
        this.assertLive();
        if (controller.signal.aborted || this.staged.get(slot) !== entry)
          throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'late staged resource result was retired');
        if (!handle || typeof handle.release !== 'function') throw new InteractionRuntimeError('E_DATA_RUNTIME_PORT', slot, 'resource acquisition requires a value and release handle');
        const value = handle.value;
        this.assertLive();
        if (controller.signal.aborted || this.staged.get(slot) !== entry)
          throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'late staged resource result was retired');
        entry.handle = handle;
        return value;
      } catch (error) {
        if (this.staged.get(slot) === entry) this.staged.delete(slot);
        controller.abort();
        try {if (handle && typeof handle.release === 'function') handle.release();}
        catch (cleanup) {throw new AggregateError([error, cleanup], 'Staged resource validation and release failed');}
        throw error;
      }
    }, error => {
      if (this.staged.get(slot) === entry) this.staged.delete(slot);
      controller.abort();
      throw error;
    });
    return entry.promise;
  }

  /** Prepare every value before the whole-frame barrier; logical commit calls no borrowed code. */
  prepareStaged(slots: readonly string[], retireSlots: readonly string[] = []): Readonly<{values: readonly unknown[]; commit(): void; rollback(): void; publish(): readonly unknown[]}> {
    this.assertLive(); this.assertMutable();
    if (this.pendingPublication) throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', '$.resources', 'the previous resource publication must finish first');
    if (new Set([...slots, ...retireSlots]).size !== slots.length + retireSlots.length)
      throw new InteractionRuntimeError('E_DATA_RUNTIME_PATH', '$.resources', 'duplicate staged or retired slot');
    let retired = retireSlots.map(slot => {
      if (!slot) throw new InteractionRuntimeError('E_DATA_RUNTIME_PATH', slot, 'retired resource identity must be non-empty');
      if (this.staged.has(slot)) throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'cancel the staged candidate before preparing retirement');
      return {slot, previous: this.entries.get(slot)};
    });
    let prepared = slots.map(slot => {
      const entry = this.staged.get(slot);
      if (!entry?.handle || entry.controller.signal.aborted)
        throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'staged resource is not ready');
      return {slot, entry, previous: this.entries.get(slot)};
    });
    const token = {}; this.preparingCommit = token;
    let values: readonly unknown[];
    try {
      values = Object.freeze(prepared.map(({entry}) => entry.handle!.value));
      this.assertLive();
      for (const {slot, entry} of prepared) if (this.staged.get(slot) !== entry || entry.controller.signal.aborted)
        throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'prepared resource was replaced');
    } catch (error) {if (this.preparingCommit === token) this.preparingCommit = undefined; prepared = []; retired = []; throw error;}
    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared', previous: Owned[] = [], published = false;
    const publish = (): readonly unknown[] => {
      if (state !== 'committed' || published) return Object.freeze([]);
      published = true; if (this.pendingPublication === publish) this.pendingPublication = undefined;
      const owned = previous; previous = []; const errors: unknown[] = [];
      for (const entry of owned) {
        entry.controller.abort();
        try {entry.handle?.release();} catch (error) {errors.push(error);}
      }
      return Object.freeze(errors);
    };
    return Object.freeze({values,
      commit: () => {
        if (state !== 'prepared') return;
        if (this.disposed || this.preparingCommit !== token) {state = 'rolled-back'; prepared = []; retired = []; return;}
        for (const {slot, entry} of prepared) {this.staged.delete(slot); this.entries.set(slot, entry);}
        for (const {slot} of retired) this.entries.delete(slot);
        previous = [...prepared, ...retired].flatMap(value => value.previous ? [value.previous] : []); prepared = []; retired = [];
        state = 'committed'; this.pendingPublication = publish; this.preparingCommit = undefined;
      },
      rollback: () => {if (state !== 'prepared') return; state = 'rolled-back'; prepared = []; retired = []; if (this.preparingCommit === token) this.preparingCommit = undefined;},
      publish,
    });
  }
  /** Standalone compatibility wrapper. Whole-frame owners use prepareStaged instead. */
  commitStaged(slots: readonly string[]): Readonly<{values: readonly unknown[]; releaseErrors: readonly unknown[]}> {
    const step = this.prepareStaged(slots); step.commit();
    return Object.freeze({values: step.values, releaseErrors: step.publish()});
  }

  cancelStaged(slot: string): void {
    this.assertMutable();
    const entry = this.staged.get(slot);
    if (!entry) return;
    this.staged.delete(slot);
    entry.controller.abort();
    entry.handle?.release();
  }
  isStagedReady(slot: string): boolean {return this.staged.get(slot)?.handle !== undefined;}
  retire(slot: string): void {
    this.assertMutable();
    let failure: unknown;
    try {this.cancelStaged(slot);} catch (error) {failure = error;}
    const entry = this.entries.get(slot);
    if (entry) {
      this.entries.delete(slot); entry.controller.abort();
      try {entry.handle?.release();} catch (error) {failure ??= error;}
    }
    if (failure) throw failure;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.preparingCommit = undefined;
    let failure: unknown;
    if (this.pendingPublication) {const errors = this.pendingPublication(); if (errors.length) failure = errors[0];}
    for (const slot of new Set([...this.entries.keys(), ...this.staged.keys()])) {
      try {this.retire(slot);} catch (error) {failure ??= error;}
    }
    if (failure) throw failure;
  }
  get stagedStats(): Readonly<{pending: number; ready: number}> {
    return Object.freeze({pending: this.staged.size, ready: [...this.staged.values()].filter(entry => entry.handle).length});
  }
  get stats(): Readonly<{ entries: number; handles: number; generation: number; disposed: boolean }> { return Object.freeze({ entries: this.entries.size, handles: [...this.entries.values()].filter(entry => entry.handle).length, generation: this.generation, disposed: this.disposed }); }
  private assertMutable(): void {if (this.preparingCommit) throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', '$.resources', 'resource mutations cannot reenter a prepared commit');}
  private assertLive(): void { if (this.disposed) throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', '$', 'resource owner is disposed'); }
}
