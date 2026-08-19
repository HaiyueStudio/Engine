import { RayAccelerationBuilder } from '../acceleration/index.js';
import { clonePackedAccelerationForTransfer, deserializeRaySceneSnapshot } from './serialization.js';
import {
  RAY_ACCELERATION_WORKER_RESPONSE_FORMAT,
  type RayAccelerationWorkerRequest,
  type RayAccelerationWorkerResponse,
} from './types.js';

interface OwnerState { readonly builder: RayAccelerationBuilder; generation: number; fingerprint: string }

/** Worker-owned incremental BLAS/TLAS builders. No scene or GPU resource crosses this boundary. */
export class RayAccelerationWorkerRuntime {
  private readonly owners = new Map<string, OwnerState>();
  private destroyedValue = false;

  get destroyed(): boolean { return this.destroyedValue; }
  get liveOwnerCount(): number { return this.destroyedValue ? 0 : this.owners.size; }

  build(request: RayAccelerationWorkerRequest): RayAccelerationWorkerResponse {
    if (this.destroyedValue) throw new Error('RAY_WORKER_RUNTIME_DESTROYED');
    validateRequest(request);
    let owner = this.owners.get(request.ownerId);
    if (owner && request.generation <= owner.generation) {
      return freezeResponse(request, 'unchanged', null, [], [{ phase: 'lifecycle', severity: 'error', code: 'RAY_WORKER_STALE_REQUEST',
        message: 'Worker rejected a stale or duplicate acceleration generation.', context: Object.freeze({ ownerId: request.ownerId, generation: request.generation, currentGeneration: owner.generation }) }], owner.builder.statistics, 0);
    }
    if (!owner) { owner = { builder: new RayAccelerationBuilder(), generation: 0, fingerprint: '' }; this.owners.set(request.ownerId, owner); }
    const snapshot = deserializeRaySceneSnapshot(request.snapshot);
    const update = request.forceRebuild ? owner.builder.rebuild(snapshot) : owner.builder.update(snapshot);
    owner.generation = request.generation; owner.fingerprint = request.sourceFingerprint;
    const cloned = update.snapshot ? clonePackedAccelerationForTransfer(update.snapshot.packed) : null;
    return freezeResponse(request, update.kind, cloned?.packed ?? null, update.dirtyRanges, update.diagnostics, owner.builder.statistics, cloned?.transferBytes ?? 0);
  }

  release(ownerId: string): boolean {
    const owner = this.owners.get(ownerId); if (!owner) return false;
    owner.builder.destroy(); this.owners.delete(ownerId); return true;
  }

  destroy(): void {
    if (this.destroyedValue) return; this.destroyedValue = true;
    for (const owner of this.owners.values()) owner.builder.destroy(); this.owners.clear();
  }
}

function validateRequest(request: RayAccelerationWorkerRequest): void {
  if (!request || request.format !== 'haiyue-ray-acceleration-worker-request@1' || !request.ownerId
    || !Number.isSafeInteger(request.generation) || request.generation < 1 || request.sourceFingerprint !== request.snapshot?.fingerprint) {
    throw new Error('RAY_WORKER_REQUEST_INVALID');
  }
}

function freezeResponse(
  request: RayAccelerationWorkerRequest, updateKind: RayAccelerationWorkerResponse['updateKind'], packed: RayAccelerationWorkerResponse['packed'],
  dirtyRanges: RayAccelerationWorkerResponse['dirtyRanges'], diagnostics: RayAccelerationWorkerResponse['diagnostics'],
  statistics: RayAccelerationWorkerResponse['statistics'], transferBytes: number,
): RayAccelerationWorkerResponse {
  return Object.freeze({ format: RAY_ACCELERATION_WORKER_RESPONSE_FORMAT, ownerId: request.ownerId, generation: request.generation,
    sourceFingerprint: request.sourceFingerprint, updateKind, packed, dirtyRanges: Object.freeze([...dirtyRanges]),
    diagnostics: Object.freeze([...diagnostics]), statistics: Object.freeze({ ...statistics }), transferBytes });
}
