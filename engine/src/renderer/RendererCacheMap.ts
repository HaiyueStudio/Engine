import { releaseMapEntriesNotIn } from './utils';
import type { LiveIdSet } from './utils';
import type { RendererObjectTable } from './RendererObjectTable';

export class RendererCacheMap<T> {
  private readonly _entries = new Map<number, T>();

  constructor(private readonly _destroy: (value: T) => void) {}

  get size(): number {
    return this._entries.size;
  }

  get(id: number): T | undefined {
    return this._entries.get(id);
  }

  set(id: number, value: T): void {
    const previous = this._entries.get(id);
    if (previous === value) return;
    if (previous) this._destroy(previous);
    this._entries.set(id, value);
  }

  ensure(id: number, create: () => T): T {
    let value = this._entries.get(id);
    if (!value) {
      value = create();
      this._entries.set(id, value);
    }
    return value;
  }

  release(id: number): void {
    const value = this._entries.get(id);
    if (!value) return;
    this._destroy(value);
    this._entries.delete(id);
  }

  releaseNotIn(liveIds: LiveIdSet): void {
    releaseMapEntriesNotIn(this._entries, liveIds, this._destroy);
  }

  clear(): void {
    for (const value of this._entries.values()) this._destroy(value);
    this._entries.clear();
  }
}

export class RendererObjectSlotCache<T extends { modelSlot: number }> {
  private readonly _entries = new Map<number, T>();

  constructor(
    private readonly _getTable: () => RendererObjectTable,
    private readonly _create: (modelSlot: number) => T,
  ) {}

  get(id: number): T | undefined {
    return this._entries.get(id);
  }

  ensure(id: number): T {
    let value = this._entries.get(id);
    if (!value) {
      value = this._create(this._getTable().allocateSlot());
      this._entries.set(id, value);
    }
    return value;
  }

  release(id: number): void {
    const value = this._entries.get(id);
    if (!value) return;
    this._getTable().releaseSlot(value.modelSlot);
    this._entries.delete(id);
  }

  releaseNotIn(liveIds: LiveIdSet): void {
    for (const [id, value] of this._entries) {
      if (!liveIds.has(id)) {
        this._getTable().releaseSlot(value.modelSlot);
        this._entries.delete(id);
      }
    }
  }

  clear(): void {
    const table = this._getTable();
    for (const value of this._entries.values()) table.releaseSlot(value.modelSlot);
    this._entries.clear();
  }
}
