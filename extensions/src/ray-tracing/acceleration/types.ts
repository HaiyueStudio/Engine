import type { RayMatrix4, RayPrimitiveIdentity, RayVec3 } from '../reference/index.js';
import type { RaySceneMaterialFacts, RaySceneSnapshot } from '../scene/index.js';

export type RayAccelerationPhase = 'blas-build' | 'tlas-build' | 'refit' | 'pack' | 'lifecycle';
export type RayAccelerationSeverity = 'info' | 'warning' | 'error';

export interface RayAccelerationDiagnostic {
  readonly phase: RayAccelerationPhase;
  readonly severity: RayAccelerationSeverity;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayBounds3 {
  readonly min: RayVec3;
  readonly max: RayVec3;
}

export interface RayBvhNode {
  readonly bounds: RayBounds3;
  readonly leftChild: number;
  readonly rightChild: number;
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly depth: number;
}

export interface RayAccelerationPrimitive {
  readonly kind: 'triangle' | 'sphere';
  readonly primitiveIndex: number;
  readonly bounds: RayBounds3;
  /** triangle = v0.xyz,v1.xyz,v2.xyz; sphere = center.xyz,radius */
  readonly data: readonly number[];
}

export interface RayBlasStatistics {
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly primitiveCount: number;
  readonly maxDepth: number;
  readonly estimatedBytes: number;
}

export interface RayBlas {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly geometryId: string;
  readonly geometryRevision: number;
  readonly sourceKind: 'triangle-mesh' | 'analytic-sphere';
  readonly sourceFingerprint: string;
  readonly fingerprint: string;
  readonly rootNode: number;
  readonly bounds: RayBounds3 | null;
  readonly nodes: readonly RayBvhNode[];
  readonly primitives: readonly RayAccelerationPrimitive[];
  /** Leaf ranges address this deterministic primitive-order array. */
  readonly primitiveIndices: readonly number[];
  readonly statistics: RayBlasStatistics;
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export interface RayBlasBuildResult {
  readonly blas: RayBlas | null;
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export interface RayTlasInstance {
  readonly instanceId: string;
  readonly entityId: string;
  readonly geometryId: string;
  readonly geometryRevision: number;
  readonly blasKey: string;
  readonly transform: RayMatrix4;
  readonly inverseTransform: RayMatrix4;
  readonly bounds: RayBounds3;
  readonly material: RaySceneMaterialFacts | null;
  readonly analyticIdentity: RayPrimitiveIdentity | null;
}

export interface RayTlasStatistics {
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly instanceCount: number;
  readonly maxDepth: number;
  readonly estimatedBytes: number;
}

export interface RayTlas {
  readonly schemaVersion: 1;
  readonly sourceFingerprint: string;
  readonly membershipFingerprint: string;
  readonly transformFingerprint: string;
  readonly materialFingerprint: string;
  readonly fingerprint: string;
  readonly rootNode: number;
  readonly bounds: RayBounds3 | null;
  readonly nodes: readonly RayBvhNode[];
  readonly instances: readonly RayTlasInstance[];
  /** Leaf ranges address this deterministic instance-order array. */
  readonly instanceIndices: readonly number[];
  readonly statistics: RayTlasStatistics;
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export type RayAccelerationUpdateKind =
  | 'initial-build'
  | 'unchanged'
  | 'material-update'
  | 'transform-refit'
  | 'membership-rebuild'
  | 'topology-rebuild';

export type RayPackedBufferName = 'blasNodes' | 'blasTable' | 'tlasNodes' | 'primitives' | 'instances' | 'materials';

export interface RayDirtyUploadRange {
  readonly buffer: RayPackedBufferName;
  /** replace also carries targetByteLength=0 so removals release stale GPU storage. */
  readonly mode: 'write' | 'replace';
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly targetByteLength: number;
}

export interface RayPackedBuffer {
  readonly name: RayPackedBufferName;
  readonly stride: number;
  readonly count: number;
  readonly data: ArrayBuffer;
}

export interface RayPackedAccelerationMemory {
  readonly blasNodesBytes: number;
  readonly blasTableBytes: number;
  readonly tlasNodesBytes: number;
  readonly primitivesBytes: number;
  readonly instancesBytes: number;
  readonly materialsBytes: number;
  readonly totalBytes: number;
}

export interface RayPackedAcceleration {
  readonly schemaVersion: 1;
  readonly abiFingerprint: string;
  readonly sourceFingerprint: string;
  readonly fingerprint: string;
  readonly tlasRootNode: number;
  readonly buffers: Readonly<Record<RayPackedBufferName, RayPackedBuffer>>;
  readonly geometryIdentities: readonly string[];
  readonly instanceIdentities: readonly string[];
  readonly materialIdentities: readonly string[];
  readonly memory: RayPackedAccelerationMemory;
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export interface RayPackResult {
  readonly packed: RayPackedAcceleration | null;
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export interface RayAccelerationSnapshot {
  readonly source: RaySceneSnapshot;
  readonly blases: ReadonlyMap<string, RayBlas>;
  readonly tlas: RayTlas;
  readonly packed: RayPackedAcceleration;
  readonly fingerprint: string;
}

export interface RayAccelerationUpdate {
  readonly kind: RayAccelerationUpdateKind;
  readonly snapshot: RayAccelerationSnapshot | null;
  readonly dirtyRanges: readonly RayDirtyUploadRange[];
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
}

export interface RayAccelerationRuntimeStatistics {
  readonly buildCount: number;
  readonly refitCount: number;
  readonly materialUpdateCount: number;
  readonly cacheHitCount: number;
  readonly currentBytes: number;
  readonly peakBytes: number;
  readonly liveBlasCount: number;
  readonly destroyed: boolean;
}

export interface RayAccelerationCandidateQuery {
  readonly candidates: readonly RayPrimitiveIdentity[];
  readonly diagnostics: readonly RayAccelerationDiagnostic[];
  readonly tlasNodeTests: number;
  readonly blasNodeTests: number;
  readonly aborted: boolean;
}
