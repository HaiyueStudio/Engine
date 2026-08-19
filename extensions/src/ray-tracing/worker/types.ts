import type { RayAccelerationDiagnostic, RayAccelerationRuntimeStatistics, RayAccelerationUpdateKind, RayDirtyUploadRange, RayPackedAcceleration } from '../acceleration/index.js';
import type { RayDiagnostic, RayMatrix4, RayPrimitiveIdentity, RayVec3 } from '../reference/index.js';
import type { RaySceneInstanceProvenance, RaySceneMaterialFacts, RaySceneSourceRevision, RaySceneSnapshot } from '../scene/index.js';

export const RAY_ACCELERATION_WORKER_PROTOCOL_VERSION = 1 as const;
export const RAY_ACCELERATION_WORKER_REQUEST_FORMAT = 'haiyue-ray-acceleration-worker-request@1' as const;
export const RAY_ACCELERATION_WORKER_RESPONSE_FORMAT = 'haiyue-ray-acceleration-worker-response@1' as const;

export type RayWorkerDiagnosticCode =
  | 'RAY_WORKER_QUEUE_OVERFLOW'
  | 'RAY_WORKER_CRASH'
  | 'RAY_WORKER_MESSAGE_ERROR'
  | 'RAY_WORKER_PROTOCOL_ERROR'
  | 'RAY_WORKER_STALE_REPLY'
  | 'RAY_WORKER_ABORTED'
  | 'RAY_WORKER_RECOVERY_STARTED'
  | 'RAY_WORKER_RECOVERY_COMPLETED'
  | 'RAY_WORKER_RECOVERY_FAILED'
  | 'RAY_WORKER_OWNER_RELEASED'
  | 'RAY_WORKER_DISPOSED';

export interface RayWorkerDiagnostic {
  readonly phase: 'worker-request' | 'worker-recovery' | 'worker-lifecycle';
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: RayWorkerDiagnosticCode;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayWorkerGeometryDto {
  readonly kind: 'triangle-mesh';
  readonly geometryId: string;
  readonly revision: number;
  readonly positions: Float64Array<ArrayBuffer>;
  readonly normals: Float64Array<ArrayBuffer> | null;
  readonly indices: Uint32Array<ArrayBuffer> | null;
  readonly primitiveCount: number;
}

export interface RayWorkerInstanceDto {
  readonly instanceId: string;
  readonly entityId: string;
  readonly geometryId: string;
  readonly geometryRevision: number;
  readonly transform: readonly number[];
}

export interface RayWorkerAnalyticSphereDto {
  readonly kind: 'sphere';
  readonly identity: RayPrimitiveIdentity;
  readonly center: RayVec3;
  readonly radius: number;
  readonly transform: RayMatrix4;
}

export interface RaySceneSnapshotDto {
  readonly schemaVersion: 1;
  readonly sourceRevision: RaySceneSourceRevision;
  readonly revision: string;
  readonly fingerprint: string;
  readonly geometries: readonly RayWorkerGeometryDto[];
  readonly instances: readonly RayWorkerInstanceDto[];
  readonly analyticPrimitives: readonly RayWorkerAnalyticSphereDto[];
  readonly provenance: readonly RaySceneInstanceProvenance[];
  readonly diagnostics: readonly RayDiagnostic[];
}

export interface RayAccelerationWorkerRequest {
  readonly format: typeof RAY_ACCELERATION_WORKER_REQUEST_FORMAT;
  readonly ownerId: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly forceRebuild: boolean;
  readonly snapshot: RaySceneSnapshotDto;
}

export interface RayPackedAccelerationDto extends Omit<RayPackedAcceleration, 'buffers'> {
  readonly buffers: RayPackedAcceleration['buffers'];
}

export interface RayAccelerationWorkerResponse {
  readonly format: typeof RAY_ACCELERATION_WORKER_RESPONSE_FORMAT;
  readonly ownerId: string;
  readonly generation: number;
  readonly sourceFingerprint: string;
  readonly updateKind: RayAccelerationUpdateKind;
  readonly packed: RayPackedAccelerationDto | null;
  readonly dirtyRanges: readonly RayDirtyUploadRange[];
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
  readonly statistics: RayAccelerationRuntimeStatistics;
  readonly transferBytes: number;
}

export interface RayAccelerationWorkerBuildOptions {
  readonly signal?: AbortSignal;
  readonly forceRebuild?: boolean;
}

export interface RayAccelerationWorkerBuildResult extends Omit<RayAccelerationWorkerResponse, 'packed'> {
  readonly packed: RayPackedAcceleration | null;
  readonly workerDiagnostics: readonly RayWorkerDiagnostic[];
}

export interface RayAccelerationWorkerClientOptions {
  readonly maxPending?: number;
  readonly maxRecoveryAttempts?: number;
  readonly onDiagnostic?: (diagnostic: RayWorkerDiagnostic) => void;
}

export interface RayAccelerationWorkerClientCreateResult {
  readonly client: import('./client.js').RayAccelerationWorkerClient | null;
  readonly diagnostics: readonly RayWorkerDiagnostic[];
}

export type RayWorkerFactory = () => import('@haiyue/engine/experimental/async').WorkerChannelLike;

export function isRaySceneSnapshot(value: unknown): value is RaySceneSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RaySceneSnapshot>;
  return candidate.schemaVersion === 1 && typeof candidate.fingerprint === 'string'
    && Array.isArray(candidate.geometries) && Array.isArray(candidate.instances)
    && Array.isArray(candidate.analyticPrimitives) && Array.isArray(candidate.provenance);
}

export function isRaySceneMaterialFacts(value: unknown): value is RaySceneMaterialFacts {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RaySceneMaterialFacts>;
  return typeof candidate.materialId === 'string' && Number.isInteger(candidate.revision) && typeof candidate.type === 'string';
}
