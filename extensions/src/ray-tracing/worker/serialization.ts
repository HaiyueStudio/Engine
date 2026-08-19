import { validatePackedAcceleration, type RayPackedAcceleration, type RayPackedBufferName } from '../acceleration/index.js';
import type { RaySceneSnapshot } from '../scene/index.js';
import type { RayAccelerationWorkerResponse, RayPackedAccelerationDto, RaySceneSnapshotDto } from './types.js';

export function serializeRaySceneSnapshot(snapshot: RaySceneSnapshot): { readonly snapshot: RaySceneSnapshotDto; readonly transfer: readonly Transferable[] } {
  const transfer: Transferable[] = [];
  const geometries = snapshot.geometries.map(geometry => {
    const positions = new Float64Array(geometry.positions); transfer.push(positions.buffer);
    const normals = geometry.normals ? new Float64Array(geometry.normals) : null; if (normals) transfer.push(normals.buffer);
    const indices = geometry.indices ? new Uint32Array(geometry.indices) : null; if (indices) transfer.push(indices.buffer);
    return Object.freeze({ kind: geometry.kind, geometryId: geometry.geometryId, revision: geometry.revision, positions, normals, indices, primitiveCount: geometry.primitiveCount });
  });
  const dto: RaySceneSnapshotDto = Object.freeze({ schemaVersion: 1, sourceRevision: snapshot.sourceRevision, revision: snapshot.revision,
    fingerprint: snapshot.fingerprint, geometries: Object.freeze(geometries), instances: snapshot.instances,
    analyticPrimitives: snapshot.analyticPrimitives, provenance: snapshot.provenance, diagnostics: snapshot.diagnostics });
  return Object.freeze({ snapshot: dto, transfer: Object.freeze(transfer) });
}

export function deserializeRaySceneSnapshot(dto: RaySceneSnapshotDto): RaySceneSnapshot {
  const geometries = dto.geometries.map(geometry => Object.freeze({ kind: geometry.kind, geometryId: geometry.geometryId, revision: geometry.revision,
    positions: Object.freeze([...geometry.positions]), normals: geometry.normals ? Object.freeze([...geometry.normals]) : null,
    indices: geometry.indices ? Object.freeze([...geometry.indices]) : null, primitiveCount: geometry.primitiveCount }));
  return Object.freeze({ schemaVersion: 1, sourceRevision: Object.freeze({ ...dto.sourceRevision }), revision: dto.revision, fingerprint: dto.fingerprint,
    geometries: Object.freeze(geometries), instances: Object.freeze(dto.instances.map(value => Object.freeze({ ...value, transform: Object.freeze([...value.transform]) }))),
    analyticPrimitives: Object.freeze(dto.analyticPrimitives.map(value => Object.freeze({ ...value, identity: Object.freeze({ ...value.identity }), center: Object.freeze([...value.center]) as typeof value.center, transform: Object.freeze([...value.transform]) }))),
    provenance: Object.freeze(dto.provenance.map(value => Object.freeze({ ...value, material: Object.freeze({ ...value.material }) }))), diagnostics: Object.freeze([...dto.diagnostics]) });
}

/** Clones buffers before transfer so the worker's incremental builder keeps an intact previous revision. */
export function clonePackedAccelerationForTransfer(packed: RayPackedAcceleration): { readonly packed: RayPackedAccelerationDto; readonly transfer: readonly Transferable[]; readonly transferBytes: number } {
  const transfer: Transferable[] = []; let transferBytes = 0;
  const buffers = {} as Record<RayPackedBufferName, RayPackedAcceleration['buffers'][RayPackedBufferName]>;
  for (const name of Object.keys(packed.buffers) as RayPackedBufferName[]) { const source = packed.buffers[name]; const data = source.data.slice(0); transfer.push(data); transferBytes += data.byteLength; buffers[name] = Object.freeze({ ...source, data }); }
  const dto = Object.freeze({ ...packed, buffers: Object.freeze(buffers), diagnostics: Object.freeze([...packed.diagnostics]) });
  return Object.freeze({ packed: dto, transfer: Object.freeze(transfer), transferBytes });
}

export function deserializePackedAcceleration(dto: RayPackedAccelerationDto): RayPackedAcceleration {
  const packed = Object.freeze({ ...dto, buffers: Object.freeze({ ...dto.buffers }), geometryIdentities: Object.freeze([...dto.geometryIdentities]),
    instanceIdentities: Object.freeze([...dto.instanceIdentities]), materialIdentities: Object.freeze([...dto.materialIdentities]), diagnostics: Object.freeze([...dto.diagnostics]), memory: Object.freeze({ ...dto.memory }) });
  const diagnostics = validatePackedAcceleration(packed);
  if (diagnostics.length) throw new Error(`RAY_WORKER_PACKED_ACCELERATION_INVALID:${diagnostics.map(value => value.code).join(',')}`);
  return packed;
}

export function collectRayWorkerResponseTransferables(response: RayAccelerationWorkerResponse): readonly Transferable[] {
  if (!response.packed) return Object.freeze([]);
  return Object.freeze(Object.values(response.packed.buffers).map(buffer => buffer.data));
}
