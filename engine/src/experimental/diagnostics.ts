export { FrameDiagnostics } from '../core/FrameDiagnostics';
export type {
  FrameDiagnosticsOptions,
  FrameMetricCounter,
  FrameMetricStage,
  FrameMetricsSnapshot,
} from '../core/FrameDiagnostics';
export {
  getEngineFrameDiagnostics,
  getEngineGPUResourceTracker,
  registerEngineDiagnostics,
} from '../core/EngineDiagnosticsAccess';
export type { EngineDiagnosticsState } from '../core/EngineDiagnosticsAccess';
export {
  createGPUResourceOwner,
  estimateTextureBytes,
  GPUResourceScope,
  GPUResourceTracker,
} from '../core/GPUResourceTracker';
export type {
  GPUCacheStats,
  GPUResourceDebugSnapshot,
  GPUResourceOwner,
  GPUResourceOwnerKind,
  GPUResourceRecord,
  GPUResourceTrackerOptions,
  GPUResourceTrackOptions,
  GPUResourceTypeStats,
  GPUResourceUsage,
  GPUTrackedResourceType,
} from '../core/GPUResourceTracker';
