import type { RayVec3 } from '../reference/index.js';

export type RayPathDiagnosticPhase = 'extract' | 'upload' | 'path-tracing' | 'tone-mapping' | 'readback' | 'lifecycle';
export type RayPathDiagnosticSeverity = 'info' | 'warning' | 'error';
export type RayToneMapping = 'linear' | 'reinhard' | 'aces';

export interface RayPathDiagnostic {
  readonly phase: RayPathDiagnosticPhase;
  readonly severity: RayPathDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
}

export interface RayPathCamera {
  readonly projection: 'perspective' | 'orthographic';
  readonly origin: RayVec3;
  readonly right: RayVec3;
  readonly up: RayVec3;
  /** Normalized world-space viewing direction. */
  readonly forward: RayVec3;
  readonly verticalFov: number;
  readonly orthographicHeight: number;
  readonly near: number;
  readonly far: number;
  readonly revision: string;
}

export interface RayPathLight {
  readonly identity: string;
  readonly type: 'ambient' | 'directional' | 'point';
  readonly color: RayVec3;
  readonly intensity: number;
  /** Direction the directional light travels. */
  readonly direction: RayVec3;
  readonly position: RayVec3;
  readonly range: number;
  readonly revision: string;
}

export interface RayPathEnvironment {
  readonly color: RayVec3;
  readonly intensity: number;
  readonly rotation: number;
  /** Borrowed Engine texture. The renderer never destroys it. */
  readonly texture: GPUTexture | null;
  readonly textureVersion: number;
  readonly revision: string;
}

export interface RayPathSceneFacts {
  readonly camera: RayPathCamera;
  readonly lights: readonly RayPathLight[];
  readonly environment: RayPathEnvironment;
  readonly revision: string;
  readonly diagnostics: readonly RayPathDiagnostic[];
}

export interface RayPathSceneExtractionOptions {
  readonly cameraEntityId?: number;
  readonly maxLights?: number;
}

export interface RayPathSceneExtractionResult {
  readonly facts: RayPathSceneFacts | null;
  readonly diagnostics: readonly RayPathDiagnostic[];
}

export interface RayPathRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly maxBounces?: number;
  readonly seed?: number;
  readonly exposure?: number;
  readonly toneMapping?: RayToneMapping;
  readonly readback?: boolean;
}

export interface RayPathCounters {
  readonly pixels: number;
  readonly rays: number;
  readonly bounces: number;
  readonly hits: number;
  readonly misses: number;
  readonly shadowRays: number;
  readonly emissiveHits: number;
  readonly stackOverflows: number;
  readonly invalidAccesses: number;
}

export interface RayPathMemory {
  readonly accelerationBytes: number;
  readonly materialBytes: number;
  readonly textureBytes: number;
  readonly outputBytes: number;
  readonly diagnosticBytes: number;
  readonly readbackBytes: number;
  readonly peakBytes: number;
  readonly liveResourceCount: number;
}

export interface RayPathRenderResult {
  readonly status: 'ok' | 'failed';
  readonly width: number;
  readonly height: number;
  readonly revision: string;
  readonly outputTexture: GPUTexture | null;
  readonly pixels: Uint8Array | null;
  readonly counters: RayPathCounters;
  readonly gpuTimeNs: number | null;
  readonly gpuTimeKind: 'timestamp-query' | 'unavailable';
  readonly memory: RayPathMemory;
  readonly diagnostics: readonly RayPathDiagnostic[];
}

export interface RayPathRendererCreateResult {
  readonly renderer: import('./runtime.js').RayPathTracingRenderer | null;
  readonly diagnostics: readonly RayPathDiagnostic[];
}

export interface RayPathRenderPlanPass {
  readonly kind: 'upload' | 'path-tracing' | 'tone-mapping' | 'consumer';
  readonly label: string;
}

export interface RayPathRenderPlan {
  readonly width: number;
  readonly height: number;
  readonly passes: readonly RayPathRenderPlanPass[];
}
