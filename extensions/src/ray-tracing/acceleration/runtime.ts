import type { RaySceneAnalyticSphere, RaySceneTriangleGeometry } from '../reference/index.js';
import type { RaySceneSnapshot } from '../scene/index.js';
import {
  analyticBlasKey,
  blasKey,
  buildAnalyticSphereBlas,
  buildBlas,
  diagnostic,
  fingerprintTriangleGeometry,
} from './bvh.js';
import { compareText, fingerprintText } from './math.js';
import { packAcceleration } from './pack.js';
import { buildTlas, refitTlas } from './tlas.js';
import type {
  RayAccelerationDiagnostic,
  RayAccelerationRuntimeStatistics,
  RayAccelerationSnapshot,
  RayAccelerationUpdate,
  RayAccelerationUpdateKind,
  RayBlas,
  RayBlasBuildResult,
  RayDirtyUploadRange,
  RayPackedAcceleration,
  RayPackedBufferName,
} from './types.js';

export class RayBlasCache {
  private readonly _entries = new Map<string, RayBlas>();
  private _cacheHitCount = 0;
  private _destroyed = false;

  get cacheHitCount(): number { return this._cacheHitCount; }
  get size(): number { return this._entries.size; }
  get destroyed(): boolean { return this._destroyed; }
  get estimatedBytes(): number {
    let total = 0;
    for (const blas of this._entries.values()) total += blas.statistics.estimatedBytes;
    return total;
  }

  getOrBuildGeometry(geometry: RaySceneTriangleGeometry): RayBlasBuildResult {
    if (this._destroyed) return destroyedBuildResult();
    const key = blasKey(geometry.geometryId, geometry.revision);
    const sourceFingerprint = fingerprintTriangleGeometry(geometry);
    const cached = this._entries.get(key);
    if (cached?.sourceFingerprint === sourceFingerprint) {
      this._cacheHitCount++;
      return Object.freeze({ blas: cached, diagnostics: Object.freeze([]) });
    }
    const result = buildBlas(geometry);
    const diagnostics = [...result.diagnostics];
    if (cached && cached.sourceFingerprint !== sourceFingerprint) {
      diagnostics.unshift(diagnostic('blas-build', 'warning', 'RAY_BLAS_REVISION_REUSED',
        `Geometry ${geometry.geometryId}@${geometry.revision} changed without a revision change; its derived BLAS was rebuilt.`, {
          geometryId: geometry.geometryId,
          geometryRevision: geometry.revision,
        }));
    }
    if (result.blas) this._entries.set(key, result.blas);
    return Object.freeze({ blas: result.blas, diagnostics: Object.freeze(diagnostics) });
  }

  getOrBuildAnalytic(sphere: RaySceneAnalyticSphere): RayBlasBuildResult {
    if (this._destroyed) return destroyedBuildResult();
    const key = analyticBlasKey(
      sphere.identity.geometryId,
      sphere.identity.geometryRevision,
      sphere.identity.primitiveIndex,
    );
    const result = buildAnalyticSphereBlas(sphere);
    const cached = this._entries.get(key);
    if (result.blas && cached?.sourceFingerprint === result.blas.sourceFingerprint) {
      this._cacheHitCount++;
      return Object.freeze({ blas: cached, diagnostics: Object.freeze([]) });
    }
    const diagnostics = [...result.diagnostics];
    if (cached && result.blas && cached.sourceFingerprint !== result.blas.sourceFingerprint) {
      diagnostics.unshift(diagnostic('blas-build', 'warning', 'RAY_BLAS_REVISION_REUSED',
        `Analytic geometry ${sphere.identity.geometryId}@${sphere.identity.geometryRevision} changed without a revision change.`, {
          geometryId: sphere.identity.geometryId,
          geometryRevision: sphere.identity.geometryRevision,
        }));
    }
    if (result.blas) this._entries.set(key, result.blas);
    return Object.freeze({ blas: result.blas, diagnostics: Object.freeze(diagnostics) });
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this._entries.keys()) if (!keys.has(key)) this._entries.delete(key);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._entries.clear();
  }
}

export class RayAccelerationBuilder {
  private _cache = new RayBlasCache();
  private _current: RayAccelerationSnapshot | null = null;
  private _destroyed = false;
  private _buildCount = 0;
  private _refitCount = 0;
  private _materialUpdateCount = 0;
  private _peakBytes = 0;

  get current(): RayAccelerationSnapshot | null { return this._current; }

  get statistics(): RayAccelerationRuntimeStatistics {
    return Object.freeze({
      buildCount: this._buildCount,
      refitCount: this._refitCount,
      materialUpdateCount: this._materialUpdateCount,
      cacheHitCount: this._cache.cacheHitCount,
      currentBytes: this._current?.packed.memory.totalBytes ?? 0,
      peakBytes: this._peakBytes,
      liveBlasCount: this._current?.blases.size ?? 0,
      destroyed: this._destroyed,
    });
  }

  update(source: RaySceneSnapshot): RayAccelerationUpdate {
    if (this._destroyed) {
      const diagnostics = [diagnostic('lifecycle', 'error', 'RAY_ACCEL_OWNER_DESTROYED',
        'Cannot update a destroyed ray acceleration builder.', { sourceFingerprint: source.fingerprint })];
      return freezeUpdate('unchanged', null, [], diagnostics);
    }
    const diagnostics: RayAccelerationDiagnostic[] = [];
    const blases = new Map<string, RayBlas>();
    const retained = new Set<string>();
    for (const geometry of source.geometries) {
      const result = this._cache.getOrBuildGeometry(geometry);
      diagnostics.push(...result.diagnostics);
      if (result.blas) {
        if (blases.has(result.blas.key)) {
          diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_IDENTITY_DUPLICATE',
            `Snapshot contains duplicate BLAS identity ${result.blas.key}.`, { blasKey: result.blas.key }));
          continue;
        }
        blases.set(result.blas.key, result.blas);
        retained.add(result.blas.key);
      }
    }
    for (const sphere of source.analyticPrimitives) {
      const result = this._cache.getOrBuildAnalytic(sphere);
      diagnostics.push(...result.diagnostics);
      if (result.blas) {
        if (blases.has(result.blas.key)) {
          diagnostics.push(diagnostic('blas-build', 'error', 'RAY_BLAS_IDENTITY_DUPLICATE',
            `Snapshot contains duplicate BLAS identity ${result.blas.key}.`, { blasKey: result.blas.key }));
          continue;
        }
        blases.set(result.blas.key, result.blas);
        retained.add(result.blas.key);
      }
    }
    this._cache.retain(retained);
    if (diagnostics.some(entry => entry.severity === 'error')) {
      return freezeUpdate(this._current ? 'topology-rebuild' : 'initial-build', null, [], diagnostics);
    }

    const builtTlas = buildTlas(source, blases);
    diagnostics.push(...builtTlas.diagnostics);
    if (diagnostics.some(entry => entry.severity === 'error')) {
      return freezeUpdate(this._current ? 'membership-rebuild' : 'initial-build', null, [], diagnostics);
    }
    let kind = classifyUpdate(this._current, blases, builtTlas);
    let tlas = builtTlas;
    if (kind === 'transform-refit' && this._current) {
      const refitted = refitTlas(this._current.tlas, source, blases);
      if (refitted) {
        tlas = refitted;
      } else {
        kind = 'membership-rebuild';
        diagnostics.push(diagnostic('refit', 'warning', 'RAY_TLAS_REFIT_REJECTED',
          'TLAS membership changed while attempting transform refit; a deterministic rebuild was used.', {}));
      }
    }
    const packResult = packAcceleration(blases, tlas);
    diagnostics.push(...packResult.diagnostics);
    if (!packResult.packed) return freezeUpdate(kind, null, [], diagnostics);
    const acceleration = freezeAccelerationSnapshot(source, blases, tlas, packResult.packed);
    const dirtyRanges = planDirtyRanges(kind, this._current?.packed ?? null, packResult.packed);
    const transientBytes = (this._current?.packed.memory.totalBytes ?? 0) + packResult.packed.memory.totalBytes;
    this._current = acceleration;
    this._peakBytes = Math.max(this._peakBytes, transientBytes);
    if (kind === 'initial-build' || kind === 'membership-rebuild' || kind === 'topology-rebuild') this._buildCount++;
    else if (kind === 'transform-refit') this._refitCount++;
    else if (kind === 'material-update') this._materialUpdateCount++;
    return freezeUpdate(kind, acceleration, dirtyRanges, diagnostics);
  }

  rebuild(source: RaySceneSnapshot): RayAccelerationUpdate {
    if (this._destroyed) return this.update(source);
    this._current = null;
    this._cache.destroy();
    this._cache = new RayBlasCache();
    return this.update(source);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._current = null;
    this._cache.destroy();
  }
}

function classifyUpdate(
  previous: RayAccelerationSnapshot | null,
  blases: ReadonlyMap<string, RayBlas>,
  tlas: RayAccelerationSnapshot['tlas'],
): RayAccelerationUpdateKind {
  if (!previous) return 'initial-build';
  if (previous.tlas.membershipFingerprint !== tlas.membershipFingerprint) {
    return sameInstanceIdentitySet(previous.tlas.instances, tlas.instances)
      ? 'topology-rebuild'
      : 'membership-rebuild';
  }
  if (blasSetFingerprint(previous.blases) !== blasSetFingerprint(blases)) return 'topology-rebuild';
  if (previous.tlas.transformFingerprint !== tlas.transformFingerprint) return 'transform-refit';
  if (previous.tlas.materialFingerprint !== tlas.materialFingerprint) return 'material-update';
  return 'unchanged';
}

function sameInstanceIdentitySet(
  previous: RayAccelerationSnapshot['tlas']['instances'],
  next: RayAccelerationSnapshot['tlas']['instances'],
): boolean {
  if (previous.length !== next.length) return false;
  const previousIds = previous.map(instance => `${instance.instanceId}|${instance.entityId}`).sort();
  const nextIds = next.map(instance => `${instance.instanceId}|${instance.entityId}`).sort();
  return previousIds.every((identity, index) => identity === nextIds[index]);
}

function blasSetFingerprint(blases: ReadonlyMap<string, RayBlas>): string {
  return fingerprintText([...blases.values()]
    .sort((a, b) => compareText(a.key, b.key))
    .map(blas => `${blas.key}|${blas.sourceFingerprint}|${blas.fingerprint}`)
    .join('\n'));
}

function freezeAccelerationSnapshot(
  source: RaySceneSnapshot,
  blases: ReadonlyMap<string, RayBlas>,
  tlas: RayAccelerationSnapshot['tlas'],
  packed: RayPackedAcceleration,
): RayAccelerationSnapshot {
  const sorted = [...blases.entries()].sort((a, b) => compareText(a[0], b[0]));
  const frozenMap = new Map(sorted);
  return Object.freeze({
    source,
    blases: frozenMap,
    tlas,
    packed,
    fingerprint: fingerprintText(`${source.fingerprint}|${tlas.fingerprint}|${packed.fingerprint}`),
  });
}

function planDirtyRanges(
  kind: RayAccelerationUpdateKind,
  previous: RayPackedAcceleration | null,
  next: RayPackedAcceleration,
): readonly RayDirtyUploadRange[] {
  if (!previous || kind === 'initial-build') {
    return Object.freeze((Object.keys(next.buffers) as RayPackedBufferName[])
      .map(name => Object.freeze({
        buffer: name,
        mode: 'replace' as const,
        byteOffset: 0,
        byteLength: next.buffers[name].data.byteLength,
        targetByteLength: next.buffers[name].data.byteLength,
      })));
  }
  const ranges: RayDirtyUploadRange[] = [];
  for (const name of Object.keys(next.buffers) as RayPackedBufferName[]) {
    ranges.push(...diffRecordRanges(previous, next, name));
  }
  return Object.freeze(ranges);
}

function diffRecordRanges(
  previous: RayPackedAcceleration,
  next: RayPackedAcceleration,
  name: RayPackedBufferName,
): RayDirtyUploadRange[] {
  const before = previous.buffers[name];
  const after = next.buffers[name];
  if (before.stride !== after.stride || before.count !== after.count) {
    return [Object.freeze({
      buffer: name,
      mode: 'replace',
      byteOffset: 0,
      byteLength: after.data.byteLength,
      targetByteLength: after.data.byteLength,
    })];
  }
  const a = new Uint8Array(before.data);
  const b = new Uint8Array(after.data);
  const dirtyRecords: number[] = [];
  for (let record = 0; record < after.count; record++) {
    const start = record * after.stride;
    let changed = false;
    for (let byte = start; byte < start + after.stride; byte++) {
      if (a[byte] !== b[byte]) { changed = true; break; }
    }
    if (changed) dirtyRecords.push(record);
  }
  const ranges: RayDirtyUploadRange[] = [];
  for (let cursor = 0; cursor < dirtyRecords.length;) {
    const first = dirtyRecords[cursor]!;
    let last = first;
    cursor++;
    while (cursor < dirtyRecords.length && dirtyRecords[cursor] === last + 1) last = dirtyRecords[cursor++]!;
    ranges.push(Object.freeze({
      buffer: name,
      mode: 'write',
      byteOffset: first * after.stride,
      byteLength: (last - first + 1) * after.stride,
      targetByteLength: after.data.byteLength,
    }));
  }
  return ranges;
}

function freezeUpdate(
  kind: RayAccelerationUpdateKind,
  snapshot: RayAccelerationSnapshot | null,
  dirtyRanges: readonly RayDirtyUploadRange[],
  diagnostics: readonly RayAccelerationDiagnostic[],
): RayAccelerationUpdate {
  return Object.freeze({
    kind,
    snapshot,
    dirtyRanges: Object.freeze([...dirtyRanges]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function destroyedBuildResult(): RayBlasBuildResult {
  const diagnostics = Object.freeze([diagnostic('lifecycle', 'error', 'RAY_ACCEL_OWNER_DESTROYED',
    'Cannot build BLAS from a destroyed cache.', {})]);
  return Object.freeze({ blas: null, diagnostics });
}
