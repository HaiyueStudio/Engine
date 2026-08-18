import type { Render3DOpaqueSortMode } from './Render3DOpaqueSorter';

export interface Render3DFrameTelemetrySurface {
  lastVisibleCount: number;
  lastTotalCount: number;
  lastViewCount: number;
  lastSpatialIndexUsed: boolean;
  lastSpatialQueryCount: number;
  lastSpatialShadowQueryCount: number;
  lastSpatialCandidateCount: number;
  lastDirectionalShadowPassCount: number;
  lastDirectionalShadowCasterCount: number;
  lastDirectionalShadowCacheHit: boolean;
  lastGpuDrivenBatchCount: number;
  lastGpuDrivenMaterialCount: number;
  lastGpuDrivenGlobalCommandBuilds: number;
  lastGpuDrivenGlobalCommandUpdates: number;
  lastGpuDrivenCommandObjectsCreated: number;
  lastGpuDrivenMaterialRendererResolutions: number;
  lastOpaqueSortMode: Render3DOpaqueSortMode;
  lastOpaqueSortCount: number;
}

const TELEMETRY_KEYS = [
  'lastVisibleCount',
  'lastTotalCount',
  'lastViewCount',
  'lastSpatialIndexUsed',
  'lastSpatialQueryCount',
  'lastSpatialShadowQueryCount',
  'lastSpatialCandidateCount',
  'lastDirectionalShadowPassCount',
  'lastDirectionalShadowCasterCount',
  'lastDirectionalShadowCacheHit',
  'lastGpuDrivenBatchCount',
  'lastGpuDrivenMaterialCount',
  'lastGpuDrivenGlobalCommandBuilds',
  'lastGpuDrivenGlobalCommandUpdates',
  'lastGpuDrivenCommandObjectsCreated',
  'lastGpuDrivenMaterialRendererResolutions',
  'lastOpaqueSortMode',
  'lastOpaqueSortCount',
] as const satisfies readonly (keyof Render3DFrameTelemetrySurface)[];

/**
 * Owns the mutable diagnostic state for one Render3DSystem.
 * The system keeps its existing public fields as bound compatibility mirrors,
 * so the stable API surface and external write semantics remain unchanged.
 */
export class Render3DFrameTelemetry {
  readonly state: Render3DFrameTelemetrySurface = {
    lastVisibleCount: 0,
    lastTotalCount: 0,
    lastViewCount: 0,
    lastSpatialIndexUsed: false,
    lastSpatialQueryCount: 0,
    lastSpatialShadowQueryCount: 0,
    lastSpatialCandidateCount: 0,
    lastDirectionalShadowPassCount: 0,
    lastDirectionalShadowCasterCount: 0,
    lastDirectionalShadowCacheHit: false,
    lastGpuDrivenBatchCount: 0,
    lastGpuDrivenMaterialCount: 0,
    lastGpuDrivenGlobalCommandBuilds: 0,
    lastGpuDrivenGlobalCommandUpdates: 0,
    lastGpuDrivenCommandObjectsCreated: 0,
    lastGpuDrivenMaterialRendererResolutions: 0,
    lastOpaqueSortMode: 'none',
    lastOpaqueSortCount: 0,
  };

  bind(surface: Render3DFrameTelemetrySurface): void {
    for (const key of TELEMETRY_KEYS) {
      Object.defineProperty(surface, key, {
        configurable: true,
        enumerable: true,
        get: () => this.state[key],
        set: (value: Render3DFrameTelemetrySurface[typeof key]) => {
          this.state[key] = value as never;
        },
      });
    }
  }

  beginFrame(): void {
    this.state.lastGpuDrivenGlobalCommandBuilds = 0;
    this.state.lastGpuDrivenGlobalCommandUpdates = 0;
    this.state.lastGpuDrivenCommandObjectsCreated = 0;
    this.state.lastGpuDrivenMaterialRendererResolutions = 0;
    this.state.lastOpaqueSortMode = 'none';
    this.state.lastOpaqueSortCount = 0;
  }

  resetGpuState(): void {
    this.state.lastGpuDrivenBatchCount = 0;
    this.state.lastGpuDrivenMaterialCount = 0;
    this.state.lastGpuDrivenGlobalCommandBuilds = 0;
    this.state.lastGpuDrivenGlobalCommandUpdates = 0;
    this.state.lastGpuDrivenCommandObjectsCreated = 0;
    this.state.lastGpuDrivenMaterialRendererResolutions = 0;
  }
}
