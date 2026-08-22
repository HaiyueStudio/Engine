import type { DataResourceHandle, DataResourcePort } from './runtime-types.js';

export class InteractionRuntimeError extends Error {
  readonly name = 'InteractionRuntimeError';
  constructor(readonly code: 'E_DATA_RUNTIME_STATE' | 'E_DATA_RUNTIME_PATH' | 'E_DATA_RUNTIME_TYPE' | 'E_DATA_RUNTIME_LIMIT' | 'E_DATA_RUNTIME_PORT' | 'E_INTERACTION_RUNTIME_LIMIT' | 'E_INTERACTION_RUNTIME_PORT' | 'E_SEMANTICS_RUNTIME_PORT', readonly path: string, message: string) { super(`${message} (${path})`); }
}

interface Owned { generation: number; controller: AbortController; handle?: DataResourceHandle; promise: Promise<unknown> }
export class DataResourceOwner {
  private readonly entries = new Map<string, Owned>(); private generation = 0; private disposed = false;
  constructor(private readonly port: DataResourcePort) {}
  replace(slot: string, kind: 'image' | 'artboard' | 'font' | 'blob', id: string): Promise<unknown> { this.assertLive(); this.retire(slot); const generation = ++this.generation, controller = new AbortController(); const entry: Owned = { generation, controller, promise: Promise.resolve() }; entry.promise = this.port.acquire(kind, id, controller.signal).then(handle => { if (this.disposed || controller.signal.aborted || this.entries.get(slot) !== entry || entry.generation !== generation) { handle.release(); throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', slot, 'late resource result was retired'); } entry.handle = handle; return handle.value; }, error => { if (this.entries.get(slot) === entry) this.entries.delete(slot); throw error; }); this.entries.set(slot, entry); return entry.promise; }
  value(slot: string): unknown { return this.entries.get(slot)?.handle?.value; }
  retire(slot: string): void { const entry = this.entries.get(slot); if (!entry) return; entry.controller.abort(); entry.handle?.release(); this.entries.delete(slot); }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const slot of [...this.entries.keys()]) this.retire(slot); }
  get stats(): Readonly<{ entries: number; handles: number; generation: number; disposed: boolean }> { return Object.freeze({ entries: this.entries.size, handles: [...this.entries.values()].filter(entry => entry.handle).length, generation: this.generation, disposed: this.disposed }); }
  private assertLive(): void { if (this.disposed) throw new InteractionRuntimeError('E_DATA_RUNTIME_STATE', '$', 'resource owner is disposed'); }
}
