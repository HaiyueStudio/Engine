import type { RayInput, RayVec3 } from '../reference/index.js';

export type RayTraversalMode = 'closest-hit' | 'any-hit';
export type RayTraversalPhase = 'shader' | 'upload' | 'traversal' | 'readback' | 'lifecycle';
export type RayTraversalSeverity = 'info' | 'warning' | 'error';

export interface RayTraversalDiagnostic {
  readonly phase: RayTraversalPhase;
  readonly severity: RayTraversalSeverity;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayTraversalHit {
  readonly primitiveKind: 'triangle' | 'sphere';
  readonly instanceIdentityIndex: number;
  readonly instanceIdentity: string;
  readonly geometryIdentityIndex: number;
  readonly geometryIdentity: string;
  readonly primitiveIndex: number;
  readonly t: number;
  readonly position: RayVec3;
  readonly barycentric: RayVec3 | null;
  readonly frontFace: boolean;
  readonly geometricNormal: RayVec3;
  readonly shadingNormal: RayVec3;
  readonly facingNormal: RayVec3;
}

export interface RayTraversalCounters {
  readonly rays: number;
  readonly tlasNodeTests: number;
  readonly blasNodeTests: number;
  readonly primitiveTests: number;
  readonly hits: number;
  readonly misses: number;
  readonly stackOverflows: number;
  readonly invalidAccesses: number;
}

export interface RayTraversalMemory {
  readonly accelerationBytes: number;
  readonly rayBytes: number;
  readonly hitBytes: number;
  readonly diagnosticBytes: number;
  readonly parameterBytes: number;
  readonly readbackBytes: number;
  readonly peakBytes: number;
  readonly liveResourceCount: number;
}

export interface RayTraversalResult {
  readonly status: 'ok' | 'failed';
  readonly mode: RayTraversalMode;
  readonly hits: readonly (RayTraversalHit | null)[];
  readonly counters: RayTraversalCounters;
  readonly dispatchCount: number;
  readonly gpuTimeNs: number | null;
  readonly gpuTimeKind: 'timestamp-query' | 'unavailable';
  readonly memory: RayTraversalMemory;
  readonly diagnostics: readonly RayTraversalDiagnostic[];
}

export interface RayTraversalExecuteOptions {
  readonly mode?: RayTraversalMode;
  readonly maxRaysPerDispatch?: number;
  /** Test/diagnostic override; production defaults to the frozen ABI limit of 64. */
  readonly stackLimit?: number;
}

export interface RayTraversalCreateResult {
  readonly runtime: import('./runtime.js').RayTraversalRuntime | null;
  readonly diagnostics: readonly RayTraversalDiagnostic[];
}

export interface RayTraversalDispatchPlanPass {
  readonly kind: 'upload' | 'traversal' | 'consumer';
  readonly label: string;
  readonly dispatchIndex: number | null;
}

export interface RayTraversalDispatchPlan {
  readonly rayCount: number;
  readonly maxRaysPerDispatch: number;
  readonly dispatchCount: number;
  readonly passes: readonly RayTraversalDispatchPlanPass[];
}

export type RayTraversalInput = RayInput;
