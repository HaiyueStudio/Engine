export const EngineErrorCode = {
  WebGpuUnsupported: 'E_WEBGPU_UNSUPPORTED',
  WebGpuAdapterUnavailable: 'E_WEBGPU_ADAPTER_UNAVAILABLE',
  WebGpuContextUnavailable: 'E_WEBGPU_CONTEXT_UNAVAILABLE',
  EngineDestroyed: 'E_ENGINE_DESTROYED',
  EngineNotInitialized: 'E_ENGINE_NOT_INITIALIZED',
  EngineInvalidState: 'E_ENGINE_INVALID_STATE',
  EngineRecoveryFailed: 'E_ENGINE_RECOVERY_FAILED',
  EventPathInvalid: 'E_EVENT_PATH_INVALID',
  ResourceOwnerReleased: 'E_RESOURCE_OWNER_RELEASED',
  ResourceUnrecoverable: 'E_RESOURCE_UNRECOVERABLE',
  RenderPipelineMissing: 'E_RENDER_PIPELINE_MISSING',
  RenderPipelineUnregisteredSystem: 'E_RENDER_PIPELINE_UNREGISTERED_SYSTEM',
  RenderPipelineInvalidPassState: 'E_RENDER_PIPELINE_INVALID_PASS_STATE',
  RenderPipelineUnsupportedMaterial: 'E_RENDER_PIPELINE_UNSUPPORTED_MATERIAL',
  RenderPipelineCompilationFailed: 'E_RENDER_PIPELINE_COMPILATION_FAILED',
  RenderCommandContextInvalid: 'E_RENDER_COMMAND_CONTEXT_INVALID',
  RendererResourceNotReady: 'E_RENDERER_RESOURCE_NOT_READY',
  AssetManagerDisposed: 'E_ASSET_MANAGER_DISPOSED',
  AssetDisposed: 'E_ASSET_DISPOSED',
  AssetHandleReleased: 'E_ASSET_HANDLE_RELEASED',
  AssetNotReady: 'E_ASSET_NOT_READY',
  AssetLoadFailed: 'E_ASSET_LOAD_FAILED',
  AssetInvalidData: 'E_ASSET_INVALID_DATA',
  AssetJobAborted: 'E_ASSET_JOB_ABORTED',
  WorkerProtocolInvalid: 'E_WORKER_PROTOCOL_INVALID',
  SceneDataInvalid: 'E_SCENE_DATA_INVALID',
  SceneDestroyed: 'E_SCENE_DESTROYED',
  SceneInvalidState: 'E_SCENE_INVALID_STATE',
  SessionDataInvalid: 'E_SESSION_DATA_INVALID',
  EditorImportFailed: 'E_EDITOR_IMPORT_FAILED',
  ComponentCloneUnsupported: 'E_COMPONENT_CLONE_UNSUPPORTED',
  ComponentScriptExecutionDisabled: 'E_COMPONENT_SCRIPT_EXECUTION_DISABLED',
  ComponentScriptFailed: 'E_COMPONENT_SCRIPT_FAILED',
  EcsEntityDestroyed: 'E_ECS_ENTITY_DESTROYED',
  EcsWorldDestroyed: 'E_ECS_WORLD_DESTROYED',
  EcsWorldOwnershipConflict: 'E_ECS_WORLD_OWNERSHIP_CONFLICT',
  EcsHierarchyInvalid: 'E_ECS_HIERARCHY_INVALID',
  PluginInstallFailed: 'E_PLUGIN_INSTALL_FAILED',
  PluginDependencyMissing: 'E_PLUGIN_DEPENDENCY_MISSING',
  PluginDependencyCycle: 'E_PLUGIN_DEPENDENCY_CYCLE',
  PluginDependencyInUse: 'E_PLUGIN_DEPENDENCY_IN_USE',
  PluginLifecycleFailed: 'E_PLUGIN_LIFECYCLE_FAILED',
  GeometryInvalidParameter: 'E_GEOMETRY_INVALID_PARAMETER',
  ComputeInvalidParameter: 'E_COMPUTE_INVALID_PARAMETER',
} as const;

export type EngineErrorCode = typeof EngineErrorCode[keyof typeof EngineErrorCode];

export const ErrorDomain = {
  Engine: 'engine',
  Asset: 'asset',
  Component: 'component',
  Editor: 'editor',
  Worker: 'worker',
  Serialization: 'serialization',
  Script: 'script',
} as const;

export type ErrorDomain = typeof ErrorDomain[keyof typeof ErrorDomain];

export const ErrorRecovery = {
  Ignore: 'ignore',
  Retry: 'retry',
  ReleaseResource: 'release-resource',
  TerminateRuntime: 'terminate-runtime',
} as const;

export type ErrorRecovery = typeof ErrorRecovery[keyof typeof ErrorRecovery];
export type ErrorContext = Readonly<Record<string, unknown>>;

export interface EngineErrorOptions {
  domain?: ErrorDomain;
  recoverable?: boolean;
  recovery?: ErrorRecovery;
  context?: ErrorContext;
  path?: string;
  hint?: string;
  docsPath?: string;
  cause?: unknown;
}

export interface SerializedErrorCause {
  name: string;
  message: string;
  stack?: string;
}

/** Structured-clone-safe representation used at worker and persistence boundaries. */
export interface SerializedEngineError {
  name: 'EngineError';
  domain: ErrorDomain;
  code: EngineErrorCode;
  message: string;
  recoverable: boolean;
  recovery: ErrorRecovery;
  context: Record<string, unknown>;
  path?: string;
  hint?: string;
  docsPath?: string;
  cause?: SerializedEngineError | SerializedErrorCause;
  stack?: string;
}

export class EngineError extends Error {
  readonly domain: ErrorDomain;
  readonly code: EngineErrorCode;
  readonly recoverable: boolean;
  readonly recovery: ErrorRecovery;
  readonly context: ErrorContext;
  readonly path: string | undefined;
  readonly hint: string | undefined;
  readonly docsPath: string | undefined;
  override readonly cause: unknown;

  constructor(code: EngineErrorCode, message: string, options: EngineErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'EngineError';
    this.domain = options.domain ?? inferDomain(code);
    this.code = code;
    this.recovery = options.recovery ?? inferRecovery(code);
    this.recoverable = options.recoverable ?? isRecoverableStrategy(this.recovery);
    this.context = options.context ?? {};
    this.path = options.path;
    this.hint = options.hint;
    this.docsPath = options.docsPath;
    this.cause = options.cause;
  }

  toJSON(): SerializedEngineError {
    return serializeEngineError(this);
  }
}

export function isSerializedEngineError(value: unknown): value is SerializedEngineError {
  if (!isRecord(value)) return false;
  return value.name === 'EngineError'
    && isErrorDomain(value.domain)
    && isEngineErrorCode(value.code)
    && typeof value.message === 'string'
    && typeof value.recoverable === 'boolean'
    && isErrorRecovery(value.recovery)
    && isRecord(value.context)
    && (value.path === undefined || typeof value.path === 'string')
    && (value.hint === undefined || typeof value.hint === 'string')
    && (value.docsPath === undefined || typeof value.docsPath === 'string')
    && (value.stack === undefined || typeof value.stack === 'string')
    && (value.cause === undefined || isSerializedEngineError(value.cause) || isSerializedErrorCause(value.cause));
}

export function serializeEngineError(
  error: unknown,
  fallback: { code?: EngineErrorCode; message?: string; options?: EngineErrorOptions } = {},
): SerializedEngineError {
  const normalized = error instanceof EngineError
    ? error
    : new EngineError(
        fallback.code ?? EngineErrorCode.WorkerProtocolInvalid,
        error instanceof Error ? error.message : fallback.message ?? String(error),
        { ...fallback.options, cause: error instanceof Error ? error : fallback.options?.cause },
      );
  const serialized: SerializedEngineError = {
    name: 'EngineError',
    domain: normalized.domain,
    code: normalized.code,
    message: normalized.message,
    recoverable: normalized.recoverable,
    recovery: normalized.recovery,
    context: sanitizeContext(normalized.context),
  };
  if (normalized.path !== undefined) serialized.path = normalized.path;
  if (normalized.hint !== undefined) serialized.hint = normalized.hint;
  if (normalized.docsPath !== undefined) serialized.docsPath = normalized.docsPath;
  if (normalized.stack !== undefined) serialized.stack = normalized.stack;
  const cause = serializeCause(normalized.cause);
  if (cause !== undefined) serialized.cause = cause;
  return serialized;
}

export function deserializeEngineError(value: unknown, fallback: EngineErrorOptions = {}): EngineError {
  if (!isSerializedEngineError(value)) {
    return new EngineError(
      EngineErrorCode.WorkerProtocolInvalid,
      'Received an invalid serialized error payload.',
      {
        domain: ErrorDomain.Worker,
        recovery: ErrorRecovery.TerminateRuntime,
        context: { payloadType: describeValue(value), ...fallback.context },
        path: fallback.path ?? 'worker.response.error',
        ...fallback,
        cause: value,
      },
    );
  }
  const error = new EngineError(value.code, value.message, {
    domain: value.domain,
    recoverable: value.recoverable,
    recovery: value.recovery,
    context: value.context,
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.hint === undefined ? {} : { hint: value.hint }),
    ...(value.docsPath === undefined ? {} : { docsPath: value.docsPath }),
    ...(value.cause === undefined ? {} : { cause: deserializeCause(value.cause) }),
  });
  if (value.stack !== undefined) error.stack = value.stack;
  return error;
}

function isRecoverableStrategy(recovery: ErrorRecovery): boolean {
  return recovery === ErrorRecovery.Ignore || recovery === ErrorRecovery.Retry;
}

function inferDomain(code: EngineErrorCode): ErrorDomain {
  if (code.startsWith('E_ASSET_')) return ErrorDomain.Asset;
  if (code.startsWith('E_WORKER_')) return ErrorDomain.Worker;
  if (code === EngineErrorCode.SceneDataInvalid) return ErrorDomain.Serialization;
  if (code.startsWith('E_SESSION_') || code.startsWith('E_EDITOR_')) return ErrorDomain.Editor;
  if (code === EngineErrorCode.ComponentScriptExecutionDisabled || code === EngineErrorCode.ComponentScriptFailed) return ErrorDomain.Script;
  if (code.startsWith('E_COMPONENT_')) return ErrorDomain.Component;
  return ErrorDomain.Engine;
}

function inferRecovery(code: EngineErrorCode): ErrorRecovery {
  if (code === EngineErrorCode.SessionDataInvalid || code === EngineErrorCode.EditorImportFailed) return ErrorRecovery.Ignore;
  if (code === EngineErrorCode.AssetLoadFailed
    || code === EngineErrorCode.AssetNotReady
    || code === EngineErrorCode.AssetJobAborted
    || code === EngineErrorCode.EngineRecoveryFailed) return ErrorRecovery.Retry;
  if (code === EngineErrorCode.AssetDisposed
    || code === EngineErrorCode.AssetHandleReleased
    || code === EngineErrorCode.AssetInvalidData
    || code === EngineErrorCode.ResourceOwnerReleased
    || code === EngineErrorCode.ResourceUnrecoverable
    || code === EngineErrorCode.RendererResourceNotReady) return ErrorRecovery.ReleaseResource;
  return ErrorRecovery.TerminateRuntime;
}

function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === 'string' && (Object.values(EngineErrorCode) as string[]).includes(value);
}

function isErrorDomain(value: unknown): value is ErrorDomain {
  return typeof value === 'string' && (Object.values(ErrorDomain) as string[]).includes(value);
}

function isErrorRecovery(value: unknown): value is ErrorRecovery {
  return typeof value === 'string' && (Object.values(ErrorRecovery) as string[]).includes(value);
}

function isSerializedErrorCause(value: unknown): value is SerializedErrorCause {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.message === 'string'
    && (value.stack === undefined || typeof value.stack === 'string');
}

function serializeCause(cause: unknown): SerializedEngineError | SerializedErrorCause | undefined {
  if (cause instanceof EngineError) return serializeEngineError(cause);
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack === undefined ? {} : { stack: cause.stack }),
    };
  }
  return undefined;
}

function deserializeCause(cause: SerializedEngineError | SerializedErrorCause): Error {
  if (isSerializedEngineError(cause)) return deserializeEngineError(cause);
  const error = new Error(cause.message);
  error.name = cause.name;
  if (cause.stack !== undefined) error.stack = cause.stack;
  return error;
}

function sanitizeContext(context: ErrorContext): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    try {
      sanitized[key] = structuredClone(value);
    } catch {
      sanitized[key] = describeValue(value);
    }
  }
  return sanitized;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
