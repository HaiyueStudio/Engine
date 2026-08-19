import type { RayPathDiagnostic, RayPathDiagnosticPhase, RayPathSceneFacts, RayToneMapping } from '../renderer/index.js';

export const RAY_PROGRESSIVE_SEQUENCE_ID = 'haiyue-halton23-cranley-pcg32-v1' as const;
export const RAY_ACCUMULATION_FORMAT = 'rgba16float' as const;

export interface RayProgressiveDiagnostic extends Omit<RayPathDiagnostic, 'phase'> {
  readonly phase: RayPathDiagnosticPhase | 'sampling' | 'accumulation' | 'denoise' | 'present';
}

export type RayProgressiveView = 'raw' | 'denoised' | 'variance' | 'history-age' | 'feature';
export type RayProgressiveResetReason =
  | 'initial' | 'explicit' | 'scene-owner' | 'geometry' | 'membership' | 'transform'
  | 'material' | 'camera' | 'light' | 'viewport' | 'quality' | 'sampling' | 'denoise'
  | 'renderer' | 'device';

export interface RayProgressiveSequenceSample {
  readonly sequenceId: typeof RAY_PROGRESSIVE_SEQUENCE_ID;
  readonly sampleIndex: number;
  readonly baseSeed: number;
  readonly pathSeed: number;
  readonly jitter: readonly [number, number];
}

/** Read-only revisions derived from the canonical acceleration, material and scene facts. */
export interface RayProgressiveFrameRevision {
  readonly sceneOwner: string;
  readonly acceleration: string;
  readonly geometry: string;
  readonly membership: string;
  readonly transform: string;
  readonly material: string;
  readonly camera: string;
  readonly light: string;
}

export interface RayProgressiveFrame {
  readonly facts: RayPathSceneFacts;
  readonly revision: RayProgressiveFrameRevision;
}

export interface RayProgressiveAccumulationKey extends RayProgressiveFrameRevision {
  readonly viewport: string;
  readonly quality: string;
  readonly sampling: string;
  readonly denoise: string;
}

export interface RayProgressiveOptions {
  readonly width: number;
  readonly height: number;
  readonly baseSeed?: number;
  readonly maxBounces?: number;
  readonly qualityRevision?: string;
  readonly exposure?: number;
  readonly toneMapping?: RayToneMapping;
  readonly view?: RayProgressiveView;
  readonly readback?: boolean;
}

export interface RayProgressiveResetEvent {
  readonly resetIndex: number;
  readonly reasons: readonly RayProgressiveResetReason[];
  readonly previousSampleCount: number;
  readonly revision: string;
}

export interface RayProgressiveStageTiming {
  readonly samplingNs: number | null;
  readonly accumulationNs: number | null;
  readonly denoiseTemporalNs: number | null;
  readonly denoiseSpatialNs: number | null;
  readonly presentNs: number | null;
  readonly kind: 'timestamp-query' | 'unavailable';
}

export interface RayProgressiveMemory {
  readonly historyBytes: number;
  readonly denoiseScratchBytes: number;
  readonly readbackBytes: number;
  readonly peakBytes: number;
  readonly liveResourceCount: number;
}

export interface RayProgressiveStatistics {
  readonly sampleIndex: number;
  readonly sampleCount: number;
  readonly historyAge: number;
  readonly resetCount: number;
  readonly lastReset: RayProgressiveResetEvent | null;
  readonly varianceMean: number;
  readonly varianceMax: number;
  readonly varianceSampleCount: number;
  readonly sequence: RayProgressiveSequenceSample;
}

export interface RayProgressiveRenderResult {
  readonly status: 'ok' | 'failed';
  readonly width: number;
  readonly height: number;
  readonly revision: string;
  readonly view: RayProgressiveView;
  readonly outputTexture: GPUTexture | null;
  readonly pixels: Uint8Array | null;
  readonly statistics: RayProgressiveStatistics;
  readonly timing: RayProgressiveStageTiming;
  readonly memory: RayProgressiveMemory;
  readonly diagnostics: readonly RayProgressiveDiagnostic[];
}

export interface RayProgressiveCreateResult {
  readonly renderer: import('./runtime.js').RayProgressiveRenderer | null;
  readonly diagnostics: readonly RayProgressiveDiagnostic[];
}
