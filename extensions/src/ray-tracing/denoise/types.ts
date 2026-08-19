import type { RayProgressiveDiagnostic } from '../sampling/types.js';

export interface RayDenoiseOptions {
  readonly temporalFeedback?: number;
  readonly phiColor?: number;
  readonly phiFeature?: number;
  readonly varianceBoost?: number;
}

export interface RayDenoiseCreateResult {
  readonly denoiser: import('./runtime.js').RaySpatialTemporalDenoiser | null;
  readonly diagnostics: readonly RayProgressiveDiagnostic[];
}

export interface RayDenoiseRecordOptions {
  readonly encoder: GPUCommandEncoder;
  readonly accumulation: GPUTexture;
  readonly moments: GPUTexture;
  readonly feature: GPUTexture;
  readonly width: number;
  readonly height: number;
  readonly sampleIndex: number;
  readonly reset: boolean;
  readonly querySet: GPUQuerySet | null;
  readonly temporalTimestampStart: number;
  readonly spatialTimestampStart: number;
}

export interface RayDenoiseRecordResult {
  readonly output: GPUTexture;
  readonly transientBuffers: readonly GPUBuffer[];
}
