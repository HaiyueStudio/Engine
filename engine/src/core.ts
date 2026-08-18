export { HaiyueEngine } from './core/Engine';
export type { HaiyueEngineEventMap, HaiyueEngineOptions } from './core/Engine';
export { EngineEvent, EventEmitter } from './core/EventEmitter';
export type { EmitEventOptions, EventListener, EventListenerOptions, EventPhase } from './core/EventEmitter';
export {
  deserializeEngineError,
  EngineError,
  EngineErrorCode,
  ErrorDomain,
  ErrorRecovery,
  isSerializedEngineError,
  serializeEngineError,
} from './core/EngineError';
export type {
  EngineErrorOptions,
  ErrorContext,
  SerializedEngineError,
  SerializedErrorCause,
} from './core/EngineError';
export { DEFAULT_ENGINE_DEFAULTS } from './core/EngineDefaults';
export type {
  AssetManagerDefaults,
  EngineClearColor,
  EngineDefaults,
  EngineDefaultsInput,
  RenderPipelineDefaults,
  SceneDefaults,
} from './core/EngineDefaults';
export type {
  ComponentRegistration,
  EditorPluginContext,
  EnginePlugin,
  EnginePluginContext,
  PluginRollbackScope,
  PluginRuntimeContext,
  RegistrationToken,
  ScenePluginScene,
  ScenePluginContext,
} from './core/EnginePlugin';
export type { IEngine } from './core/IEngine';
export type {
  AssetJobState,
  DeviceRecoveryPhase,
  DeviceRecoveryProgress,
  EngineLifecycleState,
  PluginLifecycleState,
  RecoverableGpuResource,
  SceneLifecycleState,
} from './core/Lifecycle';
export { isRecoverableGpuResource } from './core/Lifecycle';
export { DEFAULT_RENDER_PROFILE, getRenderProfile, RENDER_PROFILES } from './core/RenderProfile';
export type { RenderCapabilities, RenderCapabilityDecision, RenderCapabilityName, RenderCapabilityReport, RenderDimension, RenderProfile, RenderProfileName, RenderProfileSettings } from './core/RenderProfile';
export type { ScissorRect, ViewportRect } from './core/ViewportRect';
export { RenderView, RenderViewFamily } from './core/RenderView';
export type { RenderDepthConvention, RenderSampleCount, RenderViewFamilyOptions, RenderViewFamilySnapshot, RenderViewOptions, RenderViewSnapshot, RenderViewTarget, RenderViewTargetPassOptions } from './core/RenderView';
