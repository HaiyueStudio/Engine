import type { Render3DRenderItem } from './Render3DContracts';

export type Render3DOpaqueSortMode = 'none' | 'comparison' | 'radix';

export interface Render3DOpaqueSorterStats {
  readonly mode: Render3DOpaqueSortMode;
  readonly itemCount: number;
  readonly radixThreshold: number;
}

// Native Array.sort remains faster for small and medium views; reserve the
// allocation-free radix path for genuinely large opaque lists.
const DEFAULT_RADIX_THRESHOLD = 4096;
const KEY_WORDS = 5;
const RADIX_SIZE = 256;

/** Sorts opaque items without resolving materials or allocating per comparison. */
export class Render3DOpaqueSorter {
  private _keys = new Uint32Array(0);
  private _indicesA = new Uint32Array(0);
  private _indicesB = new Uint32Array(0);
  private readonly _counts = new Uint32Array(RADIX_SIZE);
  private readonly _itemScratch: Array<Render3DRenderItem | null> = [];
  private readonly _depthBits = new Uint32Array(1);
  private readonly _depthFloat: Float32Array;
  private readonly _radixThreshold: number;
  private _capacity = 0;
  private _preferBatchContiguity = false;
  private readonly _stats: { mode: Render3DOpaqueSortMode; itemCount: number; radixThreshold: number };

  constructor(radixThreshold = DEFAULT_RADIX_THRESHOLD) {
    if (!Number.isInteger(radixThreshold) || radixThreshold < 2) {
      throw new RangeError('Render3DOpaqueSorter.radixThreshold must be an integer greater than one.');
    }
    this._radixThreshold = radixThreshold;
    this._depthFloat = new Float32Array(this._depthBits.buffer);
    this._stats = { mode: 'none', itemCount: 0, radixThreshold };
  }

  get stats(): Render3DOpaqueSorterStats { return this._stats; }

  sort(items: Render3DRenderItem[], preferBatchContiguity = false): void {
    const count = items.length;
    this._preferBatchContiguity = preferBatchContiguity;
    this._stats.itemCount = count;
    if (count < 2) {
      this._stats.mode = 'none';
      return;
    }
    this._appendViewDepthKeys(items, count);
    if (count < this._radixThreshold) {
      this._stats.mode = 'comparison';
      items.sort(this._compareItems);
      return;
    }
    this._stats.mode = 'radix';
    this._ensureCapacity(count);
    this._writeKeys(items, count);
    this._radixSort(items, count);
  }

  clearReferences(): void {
    this._itemScratch.length = 0;
  }

  private readonly _compareItems = (a: Render3DRenderItem, b: Render3DRenderItem): number => {
    const aKey = a.opaqueSortKey;
    const bKey = b.opaqueSortKey;
    return ((aKey?.rendererSlot ?? 0) - (bKey?.rendererSlot ?? 0))
      || ((aKey?.materialSlot ?? 0) - (bKey?.materialSlot ?? 0))
      || ((aKey?.geometrySlot ?? 0) - (bKey?.geometrySlot ?? 0))
      || (this._preferBatchContiguity
        ? ((aKey?.entitySlot ?? a.entityId) - (bKey?.entitySlot ?? b.entityId))
          || (a.opaqueDepthKey - b.opaqueDepthKey)
        : (a.opaqueDepthKey - b.opaqueDepthKey)
          || ((aKey?.entitySlot ?? a.entityId) - (bKey?.entitySlot ?? b.entityId)));
  };

  private _writeKeys(items: readonly Render3DRenderItem[], count: number): void {
    const keys = this._keys;
    for (let index = 0; index < count; index++) {
      const item = items[index]!;
      const key = item.opaqueSortKey;
      const base = index * KEY_WORDS;
      keys[base] = key?.rendererSlot ?? 0;
      keys[base + 1] = key?.materialSlot ?? 0;
      keys[base + 2] = key?.geometrySlot ?? 0;
      keys[base + 3] = this._preferBatchContiguity
        ? key?.entitySlot ?? item.entityId
        : item.opaqueDepthKey;
      keys[base + 4] = this._preferBatchContiguity
        ? item.opaqueDepthKey
        : key?.entitySlot ?? item.entityId;
      this._indicesA[index] = index;
    }
  }

  private _radixSort(items: Render3DRenderItem[], count: number): void {
    let source = this._indicesA;
    let target = this._indicesB;
    // LSD order produces the five-word precedence written by _writeKeys().
    for (let word = KEY_WORDS - 1; word >= 0; word--) {
      for (let shift = 0; shift < 32; shift += 8) {
        this._radixPass(source, target, count, word, shift);
        const swap = source;
        source = target;
        target = swap;
      }
    }
    const scratch = this._itemScratch;
    scratch.length = count;
    for (let index = 0; index < count; index++) scratch[index] = items[source[index]!]!;
    for (let index = 0; index < count; index++) {
      items[index] = scratch[index]!;
      scratch[index] = null;
    }
    scratch.length = 0;
  }

  private _radixPass(
    source: Uint32Array,
    target: Uint32Array,
    count: number,
    word: number,
    shift: number,
  ): void {
    const counts = this._counts;
    counts.fill(0);
    const keys = this._keys;
    for (let index = 0; index < count; index++) {
      const sourceIndex = source[index]!;
      const digit = (keys[sourceIndex * KEY_WORDS + word]! >>> shift) & 0xff;
      counts[digit] = counts[digit]! + 1;
    }
    let offset = 0;
    for (let digit = 0; digit < RADIX_SIZE; digit++) {
      const digitCount = counts[digit]!;
      counts[digit] = offset;
      offset += digitCount;
    }
    for (let index = 0; index < count; index++) {
      const sourceIndex = source[index]!;
      const digit = (keys[sourceIndex * KEY_WORDS + word]! >>> shift) & 0xff;
      target[counts[digit]!] = sourceIndex;
      counts[digit] = counts[digit]! + 1;
    }
  }

  private _depthKey(value: number): number {
    if (Number.isNaN(value)) return 0xffffffff;
    this._depthFloat[0] = value;
    const bits = this._depthBits[0]!;
    return (bits & 0x80000000) !== 0 ? (~bits) >>> 0 : (bits ^ 0x80000000) >>> 0;
  }

  private _appendViewDepthKeys(items: readonly Render3DRenderItem[], count: number): void {
    for (let index = 0; index < count; index++) {
      const item = items[index]!;
      item.opaqueDepthKey = this._depthKey(item.viewDepth);
    }
  }

  private _ensureCapacity(required: number): void {
    if (required <= this._capacity) return;
    let capacity = Math.max(512, this._capacity);
    while (capacity < required) capacity *= 2;
    this._keys = new Uint32Array(capacity * KEY_WORDS);
    this._indicesA = new Uint32Array(capacity);
    this._indicesB = new Uint32Array(capacity);
    this._capacity = capacity;
  }
}
