import type { SceneLightCandidate } from './SceneLightSelection';
import { lightEnergy } from './SceneLightSelection';
import type { DirectionalLight } from '../lighting/DirectionalLight';
import {
  DEFERRED_LIGHTING_ABI as ABI,
  writeDeferredLightRecord,
  writeDeferredSourceHeader,
  writeDeferredViewHeader,
  type DeferredLightRecordInput,
} from '../shaders/generated/deferred-lighting-abi.generated';

export class DeferredLightingCapabilityError extends Error {
  readonly code = 'E_DEFERRED_LIGHTING_CAPABILITY';
  constructor(readonly reason: string, readonly observed: number, readonly supported: number) {
    super(`Deferred lighting ${reason}: ${observed} exceeds or does not meet ${supported}.`);
    this.name = 'DeferredLightingCapabilityError';
  }
}

export interface DeferredSourceStats {
  readonly candidateCount: number;
  readonly rejectedCount: number;
  readonly pointCount: number;
  readonly directionalCount: number;
  readonly ambientCount: number;
}

export interface DeferredLightSource {
  readonly generation: number;
  readonly bytes: ArrayBuffer;
  /** Directionals first. Stable IDs are owner allocated; entity IDs never enter the GPU ABI. */
  readonly records: readonly DeferredLightRecordInput[];
  readonly entityIds: readonly number[];
  readonly ambientRadiance: readonly [number, number, number];
  readonly stats: DeferredSourceStats;
}

export interface DeferredLightView {
  readonly source: DeferredLightSource;
  readonly header: ArrayBuffer;
  readonly pointIndices: Uint32Array<ArrayBuffer>;
  readonly stats: { readonly eligibleCount: number; readonly selectedCount: number; readonly overflowCount: 0 };
}

// This is a cache bound, not an admission limit. Larger candidate sets use normal packing.
const INPUT_CACHE_CAPACITY = ABI.maxPoints + ABI.maxDirectionals;
const INPUT_CACHE_STRIDE = 14;

/** One owner per World. Snapshots are immutable across phases and shared by every view. */
export class DeferredLightTable {
  private readonly _ids = new Map<number, number>();
  private _nextId = 1;
  private _generation = 0;
  private _current: DeferredLightSource | undefined;
  private _inputCache = new Float64Array(0);
  private _cachedCandidateCount = -1;

  update(candidates: readonly SceneLightCandidate[], shadows: readonly DirectionalLight[]): DeferredLightSource {
    // Cache values, never borrowed light objects: callers mutate their arrays in place.
    // A hit reuses a previously validated snapshot without allocating records or packed bytes.
    if (this._current && this._matchesInputs(candidates, shadows)) return this._current;
    const seen = new Set<number>();
    const directionals: SceneLightCandidate[] = [], points: SceneLightCandidate[] = [];
    const ambient: [number, number, number] = [0, 0, 0];
    let rejectedCount = 0, ambientCount = 0;
    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.id) || seen.has(candidate.id)) throw new Error('Deferred light source requires distinct safe entity IDs.');
      seen.add(candidate.id);
      const light = candidate.info;
      if (!lightEnergy(light) || ![0, 1, 2].includes(light.type)
        || light.color.some(c => !Number.isFinite(Math.fround(c * light.intensity)))
        || (light.type === 2 && ![...light.position, light.range].every(v => Number.isFinite(Math.fround(v))))) {
        rejectedCount++;
        continue;
      }
      if (light.type === 0) {
        for (let i = 0; i < 3; i++) ambient[i] = ambient[i]! + light.color[i]! * light.intensity;
        ambientCount++;
      } else (light.type === 1 ? directionals : points).push(candidate);
    }
    if (points.length > ABI.maxPoints) throw new DeferredLightingCapabilityError('point-capacity', points.length, ABI.maxPoints);
    if (directionals.length > ABI.maxDirectionals) throw new DeferredLightingCapabilityError('directional-capacity', directionals.length, ABI.maxDirectionals);
    if (!ambient.every(v => Number.isFinite(Math.fround(v)))) throw new DeferredLightingCapabilityError('ambient-f32-range', Math.max(...ambient), 3.4028234663852886e38);
    // Stable ordering ensures query reordering is not a source upload or a different local index.
    directionals.sort((a, b) => a.id - b.id);
    points.sort((a, b) => a.id - b.id);
    const ordered = [...directionals, ...points];
    const records: DeferredLightRecordInput[] = [];
    for (const candidate of ordered) {
      let id = this._ids.get(candidate.id);
      if (id === undefined) {
        // Never reuse a u32 ID in this owner. Explicit exhaustion is safer than aliasing a live light.
        if (this._nextId > 0xffffffff) throw new DeferredLightingCapabilityError('stable-id-exhausted', this._nextId, 0xffffffff);
        id = this._nextId++;
        this._ids.set(candidate.id, id);
      }
      const light = candidate.info;
      const directional = light.type === 1;
      const length = directional ? Math.hypot(...light.direction) : 1;
      const shadow = candidate.shadow ? shadows.indexOf(candidate.shadow) : -1;
      records.push(Object.freeze({
        positionRange: tuple(directional ? [0, 0, 0, 0] : [...light.position, light.range]),
        radiance: tuple([...light.color.map(c => c * light.intensity), 0]),
        direction: tuple(directional ? [...light.direction.map(c => c / length), 0] : [0, 0, 0, 0]),
        identity: tuple([light.type, id, shadow >= 0 && shadow < 3 ? shadow : ABI.noShadow, 0]),
      }));
    }
    const bytes = new ArrayBuffer(ABI.blocks.sourceHeader.byteSize + records.length * ABI.blocks.light.byteSize);
    const data = new DataView(bytes);
    for (let i = 0; i < records.length; i++) writeDeferredLightRecord(data, ABI.blocks.sourceHeader.byteSize + i * ABI.blocks.light.byteSize, records[i]!);
    const stats = Object.freeze({ candidateCount: candidates.length, rejectedCount, pointCount: points.length, directionalCount: directionals.length, ambientCount });
    const previous = this._current;
    // Stats are part of the snapshot too: changing a rejected/ambient source cannot return stale diagnostics.
    if (previous && equalRecords(bytes, previous.bytes) && ambient.every((v, i) => v === previous.ambientRadiance[i])
      && Object.keys(stats).every(k => stats[k as keyof DeferredSourceStats] === previous.stats[k as keyof DeferredSourceStats])) {
      this._rememberInputs(candidates, shadows);
      return previous;
    }
    if (this._generation >= 0xffffffff) throw new DeferredLightingCapabilityError('generation-exhausted', this._generation + 1, 0xffffffff);
    const generation = ++this._generation;
    writeDeferredSourceHeader(data, 0, { abiVersion: ABI.version, sourceGeneration: generation, pointCount: points.length, directionalCount: directionals.length });
    for (const id of this._ids.keys()) if (!seen.has(id)) this._ids.delete(id);
    this._current = Object.freeze({ generation, bytes, records: Object.freeze(records),
      entityIds: Object.freeze(ordered.map(c => c.id)), ambientRadiance: Object.freeze(ambient), stats });
    this._rememberInputs(candidates, shadows);
    return this._current;
  }

  private _matchesInputs(candidates: readonly SceneLightCandidate[], shadows: readonly DirectionalLight[]): boolean {
    if (candidates.length !== this._cachedCandidateCount) return false;
    const cache = this._inputCache;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!, light = candidate.info, offset = i * INPUT_CACHE_STRIDE;
      if (light.color.length !== 3 || light.direction.length !== 3 || light.position.length !== 3
        || !Object.is(cache[offset], candidate.id) || !Object.is(cache[offset + 1], light.type)
        || !Object.is(cache[offset + 2], light.intensity) || !Object.is(cache[offset + 12], light.range)
        || cache[offset + 13] !== shadowSlot(candidate, shadows)) return false;
      for (let axis = 0; axis < 3; axis++) {
        if (!Object.is(cache[offset + 3 + axis], light.color[axis])
          || !Object.is(cache[offset + 6 + axis], light.direction[axis])
          || !Object.is(cache[offset + 9 + axis], light.position[axis])) return false;
      }
    }
    return true;
  }

  private _rememberInputs(candidates: readonly SceneLightCandidate[], shadows: readonly DirectionalLight[]): void {
    this._cachedCandidateCount = -1;
    if (candidates.length > INPUT_CACHE_CAPACITY) return;
    const length = candidates.length * INPUT_CACHE_STRIDE;
    if (this._inputCache.length < length) this._inputCache = new Float64Array(length);
    const cache = this._inputCache;
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!, light = candidate.info, offset = i * INPUT_CACHE_STRIDE;
      if (light.color.length !== 3 || light.direction.length !== 3 || light.position.length !== 3) return;
      cache[offset] = candidate.id; cache[offset + 1] = light.type; cache[offset + 2] = light.intensity;
      for (let axis = 0; axis < 3; axis++) {
        cache[offset + 3 + axis] = light.color[axis]!;
        cache[offset + 6 + axis] = light.direction[axis]!;
        cache[offset + 9 + axis] = light.position[axis]!;
      }
      cache[offset + 12] = light.range; cache[offset + 13] = shadowSlot(candidate, shadows);
    }
    this._cachedCandidateCount = candidates.length;
  }
}

function shadowSlot(candidate: SceneLightCandidate, shadows: readonly DirectionalLight[]): number {
  const index = candidate.shadow ? shadows.indexOf(candidate.shadow) : -1;
  return index >= 0 && index < 3 ? index : ABI.noShadow;
}

/** Reference path conservatively accepts every valid source point, including offscreen influence. */
export function createDeferredReferenceView(source: DeferredLightSource): DeferredLightView {
  const header = new ArrayBuffer(ABI.blocks.viewHeader.byteSize);
  writeDeferredViewHeader(new DataView(header), 0, { sourceGeneration: source.generation,
    pointCount: source.stats.pointCount, directionalCount: source.stats.directionalCount,
    flags: 0, ambientRadiance: [...source.ambientRadiance, 0] });
  const pointIndices = Uint32Array.from({ length: source.stats.pointCount }, (_, index) => index);
  return Object.freeze({ source, header, pointIndices, stats: Object.freeze({
    eligibleCount: pointIndices.length, selectedCount: pointIndices.length, overflowCount: 0,
  }) });
}

export function validateDeferredView(view: DeferredLightView, source: DeferredLightSource): void {
  const data = new DataView(view.header);
  if (view.source !== source || data.getUint32(0, true) !== source.generation) throw new Error('Stale Deferred light view generation.');
  if (data.getUint32(4, true) !== view.pointIndices.length || data.getUint32(8, true) !== source.stats.directionalCount
    || data.getUint32(12, true) !== 0) throw new Error('Invalid Deferred view header.');
  const seen = new Set<number>();
  for (const index of view.pointIndices) {
    if (index >= source.stats.pointCount || seen.has(index)) throw new Error('Invalid or duplicate Deferred local point index.');
    seen.add(index);
  }
}

function tuple(values: number[]): readonly [number, number, number, number] {
  return Object.freeze(values as [number, number, number, number]);
}

function equalRecords(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint32Array(a), y = new Uint32Array(b);
  for (let i = ABI.blocks.sourceHeader.byteSize / 4; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
