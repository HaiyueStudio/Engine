import {Geometry2D} from '@haiyue/engine/geometry';
import {ProductionFrameError} from './FrameTransaction.js';

type Entry = Readonly<{kind: 'geometry'; value: Geometry2D; bytes: number} | {kind: 'uv'; value: Float32Array; bytes: number}>;

/** A core owns only the latest copied geometry for each source. Plans retain their old immutable copies. */
export class CoreGeometrySnapshotCache {
  private readonly entries = new Map<object, Entry>();
  private bytes = 0;

  constructor(private readonly maxBytes: number, private readonly maxEntries = 100_000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.core.draw.cache', 'geometry snapshot cache needs finite nonnegative byte and positive entry ceilings');
  }

  geometry(source: Geometry2D): Geometry2D {
    const entry = this.entries.get(source);
    // Author arrays remain mutable even without markDirty(). Never trust their version alone.
    if (entry?.kind === 'geometry' && entry.value.topology === source.topology
      && same(entry.value.positions, source.positions) && same(entry.value.indices, source.indices)) {
      this.touch(source, entry);
      return entry.value;
    }
    const value = new Geometry2D(source.positions.slice(), source.indices?.slice(), {topology: source.topology});
    this.install(source, {kind: 'geometry', value, bytes: value.positions.byteLength + (value.indices?.byteLength ?? 0)});
    return value;
  }

  uvs(source: Float32Array): Float32Array {
    const entry = this.entries.get(source);
    if (entry?.kind === 'uv' && same(entry.value, source)) {this.touch(source, entry); return entry.value;}
    const value = source.slice();
    this.install(source, {kind: 'uv', value, bytes: value.byteLength});
    return value;
  }

  clear(): void {this.entries.clear(); this.bytes = 0;}
  get stats(): Readonly<{entries: number; bytes: number}> {return Object.freeze({entries: this.entries.size, bytes: this.bytes});}

  private touch(source: object, entry: Entry): void {this.entries.delete(source); this.entries.set(source, entry);}
  private install(source: object, entry: Entry): void {
    const previous = this.entries.get(source);
    if (previous) {this.entries.delete(source); this.bytes -= previous.bytes;}
    // An oversized snapshot is still valid for its plan, but does not enter this optional cache.
    if (entry.bytes > this.maxBytes) return;
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + entry.bytes > this.maxBytes)) {
      const key = this.entries.keys().next().value!, oldest = this.entries.get(key)!;
      this.entries.delete(key); this.bytes -= oldest.bytes;
    }
    this.entries.set(source, entry); this.bytes += entry.bytes;
  }
}

function same(a: Float32Array | Uint16Array | Uint32Array | null, b: Float32Array | Uint16Array | Uint32Array | null): boolean {
  if (!a || !b) return a === b;
  if (a.constructor !== b.constructor || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
  return true;
}
