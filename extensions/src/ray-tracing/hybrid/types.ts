import type { RayPackedAcceleration } from '../acceleration/index.js';

export type RayHybridEffect = 'shadow' | 'reflection' | 'ao';
export type RayHybridResolution = 'full' | 'half';
export type RayHybridDebugView = 'composite' | RayHybridEffect;
export type RayHybridPhase = 'admission' | 'plan' | 'upload' | 'shadow' | 'reflection' | 'ao' | 'composite' | 'lifecycle';

export interface RayHybridDiagnostic { readonly phase: RayHybridPhase; readonly severity: 'info' | 'warning' | 'error'; readonly code: string; readonly message: string; readonly context: Readonly<Record<string, string | number | boolean | null>> }
export interface RayHybridTemporalOptions { readonly enabled?: boolean; readonly feedback?: number }
interface BaseEffectOptions { readonly enabled?: boolean; readonly resolution?: RayHybridResolution; readonly raysPerPixel?: 1 | 2 | 4; readonly maxRaysPerFrame?: number; readonly bias?: number; readonly strength?: number; readonly temporal?: RayHybridTemporalOptions }
export interface RayHybridShadowOptions extends BaseEffectOptions { readonly maxDistance?: number; readonly angularRadius?: number }
export interface RayHybridReflectionOptions extends BaseEffectOptions { readonly maxDistance?: number; readonly maxRoughness?: number }
export interface RayHybridAoOptions extends BaseEffectOptions { readonly radius?: number }
export interface RayHybridOptions {
  readonly shadow?: RayHybridShadowOptions; readonly reflection?: RayHybridReflectionOptions; readonly ao?: RayHybridAoOptions;
  readonly debugView?: RayHybridDebugView; readonly transparentPolicy?: 'skip'; readonly sceneColorSpace?: 'linear' | 'srgb';
  readonly coexistence?: { readonly shadowMap?: 'multiply'; readonly ssao?: 'multiply'; readonly reflection?: 'additive-clamped' | 'prefer-existing' };
}
export interface RayHybridExistingEffects { readonly shadowMap?: boolean; readonly ssao?: boolean; readonly planarReflection?: boolean; readonly ssr?: boolean }
export interface RayHybridFrameRevision { readonly scene: string; readonly camera: string; readonly depth: string; readonly normal: string; readonly material: string; readonly sceneColor: string }
export interface RayHybridFrameInputs {
  readonly viewId: string; readonly width: number; readonly height: number; readonly acceleration: RayPackedAcceleration;
  /** Borrowed raster resources. This runtime never destroys them. */
  readonly depth: GPUTexture; readonly normal: GPUTexture; readonly material: GPUTexture; readonly sceneColor: GPUTexture;
  readonly inverseViewProjection: readonly number[]; readonly viewProjection: readonly number[];
  readonly cameraOrigin: readonly [number, number, number]; readonly directionalLight: readonly [number, number, number];
  readonly environmentColor?: readonly [number, number, number]; readonly revision: RayHybridFrameRevision; readonly existingEffects?: RayHybridExistingEffects;
}
export interface RayHybridResolvedEffect {
  readonly effect: RayHybridEffect; readonly enabled: boolean; readonly resolution: RayHybridResolution; readonly width: number; readonly height: number;
  readonly raysPerPixel: 1 | 2 | 4; readonly rayCount: number; readonly maxRaysPerFrame: number; readonly temporalEnabled: boolean;
  readonly temporalFeedback: number; readonly historyKey: string; readonly parameters: Readonly<Record<string, number>>;
}
export interface RayHybridFrameContract {
  readonly status: 'ready' | 'bypassed' | 'failed'; readonly width: number; readonly height: number;
  readonly effects: Readonly<Record<RayHybridEffect, RayHybridResolvedEffect>>; readonly debugView: RayHybridDebugView;
  readonly sceneColorSpace: 'linear' | 'srgb'; readonly diagnostics: readonly RayHybridDiagnostic[];
}
export interface RayHybridPass { readonly kind: 'upload' | RayHybridEffect | 'composite' | 'consumer'; readonly label: string; readonly enabled: boolean }
export interface RayHybridCounters { readonly rays: number; readonly tlasNodes: number; readonly blasNodes: number; readonly primitiveTests: number; readonly hits: number; readonly misses: number; readonly transparentSkips: number; readonly stackOverflows: number; readonly invalidAccesses: number }
export interface RayHybridEffectStatistics { readonly enabled: boolean; readonly width: number; readonly height: number; readonly rayCount: number; readonly historySamples: number; readonly historyReset: boolean; readonly gpuTimeNs: number | null; readonly gpuTimeKind: 'timestamp-query' | 'unavailable'; readonly ownedBytes: number; readonly counters: RayHybridCounters }
export interface RayHybridRenderResult { readonly status: 'ok' | 'bypassed' | 'failed'; readonly outputTexture: GPUTexture | null; readonly outputOwnership: 'borrowed-raster' | 'hybrid-runtime' | 'none'; readonly effects: Readonly<Record<RayHybridEffect, RayHybridEffectStatistics>>; readonly diagnostics: readonly RayHybridDiagnostic[] }
export interface RayHybridCreateResult { readonly renderer: import('./runtime.js').RayHybridRenderer | null; readonly diagnostics: readonly RayHybridDiagnostic[] }
