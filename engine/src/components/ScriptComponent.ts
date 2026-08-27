import { Component, ComponentLifecycleFlags, ComponentWithData, UniqueCheckType } from '../ecs/Component';
import { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { ScriptResource } from '../script/ScriptResource';
import { EngineError, EngineErrorCode, ErrorDomain, ErrorRecovery } from '../core/EngineError';
import { DataComponent } from './DataComponent';
import {
  createScriptDebugApi,
  DEFAULT_SCRIPT_CAPABILITIES,
  DEFAULT_SCRIPT_INPUT_API,
  filterScriptRuntimeApi,
  type ScriptCapabilityName,
  type ScriptRuntimeApi,
} from '../script/ScriptRuntimeContract';
import { ScriptExecutionScope } from '../script/ScriptExecutionScope';

export type ScriptLifecycleName =
  | 'onUpdate'
  | 'onEntityAddComponent'
  | 'onEntityRemoveComponent'
  | 'onEntityAddToWorld'
  | 'onEntityRemoveFromWorld';

export interface ScriptComponentScripts {
  onUpdate?: string;
  onEntityAddComponent?: string;
  onEntityRemoveComponent?: string;
  onEntityAddToWorld?: string;
  onEntityRemoveFromWorld?: string;
}

export interface ScriptLifecycleEvent { component?: Component; }

export interface ScriptRuntimeContext {
  lifecycle: ScriptLifecycleName;
  entity: Entity;
  component: ScriptComponent;
  world: World | null;
  time: number;
  delta: number;
  event: ScriptLifecycleEvent;
}

export interface ScriptDebuggerEvent extends ScriptRuntimeContext { code: string; }
export type ScriptDebuggerDecision = 'continue' | 'pause';
export type ScriptDebuggerHook = (event: ScriptDebuggerEvent) => ScriptDebuggerDecision | void;
export type ScriptRuntimeApiFactory = (baseApi: ScriptRuntimeApi, context: ScriptRuntimeContext) => ScriptRuntimeApi;

export type ScriptCompiledFunction = (
  entity: Entity,
  component: ScriptComponent,
  world: World | null,
  time: number,
  delta: number,
  event: ScriptLifecycleEvent,
  api: ScriptRuntimeApi,
) => unknown;

export interface ScriptCompilerContext {
  lifecycle: ScriptLifecycleName;
  component: ScriptComponent;
  code: string;
  sourceUrl: string;
}

export type ScriptCompiler = (code: string, context: ScriptCompilerContext) => ScriptCompiledFunction;
export type ScriptExecutor = (compiled: ScriptCompiledFunction, context: ScriptRuntimeContext, api: ScriptRuntimeApi) => unknown;
export type ScriptExecutionPolicy = 'disabled' | 'trusted-project' | 'custom-isolate';
export type ScriptErrorPolicy = 'disable-script' | 'pause-script' | 'continue';

export interface ScriptSourceLocation {
  source: string;
  line: number | null;
  column: number | null;
}

export interface ScriptRuntimeErrorEvent extends ScriptRuntimeContext {
  readonly error: EngineError;
  readonly cause: unknown;
  readonly sourceLocation: ScriptSourceLocation;
  readonly scriptResource: Readonly<{ id: number; name: string; sourcePath: string }> | null;
}

export type ScriptSourceMapResolver = (
  location: ScriptSourceLocation,
  context: ScriptRuntimeContext,
) => ScriptSourceLocation | null;

export interface ScriptExecutionOptions {
  enabled?: boolean;
  policy?: ScriptExecutionPolicy;
  compiler?: ScriptCompiler | null;
  executor?: ScriptExecutor | null;
  capabilities?: readonly ScriptCapabilityName[];
  debugger?: ScriptDebuggerHook | null;
  errorPolicy?: ScriptErrorPolicy;
  onError?: ((event: ScriptRuntimeErrorEvent) => void) | null;
  sourceMap?: ScriptSourceMapResolver | null;
}

interface NormalizedScriptExecutionOptions {
  enabled: boolean;
  policy: ScriptExecutionPolicy;
  compiler: ScriptCompiler;
  executor: ScriptExecutor;
  capabilities: ReadonlySet<ScriptCapabilityName>;
  debugger: ScriptDebuggerHook | null;
  errorPolicy: ScriptErrorPolicy;
  onError: ((event: ScriptRuntimeErrorEvent) => void) | null;
  sourceMap: ScriptSourceMapResolver | null;
}

const LIFECYCLES: ScriptLifecycleName[] = [
  'onUpdate',
  'onEntityAddComponent',
  'onEntityRemoveComponent',
  'onEntityAddToWorld',
  'onEntityRemoveFromWorld',
];

const DEFAULT_EXECUTION_OPTIONS: NormalizedScriptExecutionOptions = {
  enabled: false,
  policy: 'disabled',
  compiler: disabledScriptCompiler,
  executor: defaultScriptExecutor,
  capabilities: new Set(DEFAULT_SCRIPT_CAPABILITIES),
  debugger: null,
  errorPolicy: 'disable-script',
  onError: null,
  sourceMap: null,
};

export class ScriptComponent extends ComponentWithData<Required<ScriptComponentScripts>> {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('ScriptComponent');
  static override Lifecycle =
    ComponentLifecycleFlags.Update |
    ComponentLifecycleFlags.EntityAddComponent |
    ComponentLifecycleFlags.EntityRemoveComponent |
    ComponentLifecycleFlags.EntityAddToWorld |
    ComponentLifecycleFlags.EntityRemoveFromWorld;
  private static _runtimeApiFactory: ScriptRuntimeApiFactory | null = null;
  private static _executionOptions: NormalizedScriptExecutionOptions = DEFAULT_EXECUTION_OPTIONS;
  private static _executionVersion = 0;

  readonly scripts: Required<ScriptComponentScripts>;
  private _resource: ScriptResource | null = null;
  private _unsubscribeResource: (() => void) | null = null;
  private readonly _compiled = new Map<ScriptLifecycleName, ScriptCompiledFunction>();
  private readonly _compiledSource = new Map<ScriptLifecycleName, string>();
  private readonly _compiledVersion = new Map<ScriptLifecycleName, number>();
  private _scope = new ScriptExecutionScope('unbound-script');
  private _currentRuntimeContext: ScriptRuntimeContext | null = null;
  private _paused = false;
  private _faulted = false;
  private _disabledByError = false;
  private _lastError: ScriptRuntimeErrorEvent | null = null;

  constructor(scripts: ScriptComponentScripts = {}, resource: ScriptResource | null = null) {
    const normalized = normalizeScripts(scripts);
    super(normalized, 'ScriptComponent');
    this.scripts = this.data;
    this.resource = resource;
    this._resetScope();
  }

  get resource(): ScriptResource | null { return this._resource; }
  set resource(value: ScriptResource | null) {
    if (value === this._resource) return;
    this._unsubscribeResource?.();
    this._unsubscribeResource = null;
    this._resource = value;
    if (value) this._unsubscribeResource = value.onChange(() => this.reload());
    this.reload();
  }

  get paused(): boolean { return this._paused; }
  get faulted(): boolean { return this._faulted; }
  get lastError(): ScriptRuntimeErrorEvent | null { return this._lastError; }
  get disposableCount(): number { return this._scope.disposableCount; }

  setScript(lifecycle: ScriptLifecycleName, code: string): this {
    if (this.scripts[lifecycle] === code) return this;
    this.scripts[lifecycle] = code;
    this.reload();
    return this;
  }

  getScript(lifecycle: ScriptLifecycleName): string { return this.resource?.getScript(lifecycle) ?? this.scripts[lifecycle]; }

  pause(): this { this._paused = true; return this; }
  resume(): this { this._paused = false; return this; }
  restart(): this {
    this._paused = false;
    this._faulted = false;
    this._disabledByError = false;
    this._lastError = null;
    this.disabled = false;
    this.reload();
    return this;
  }

  reload(): this {
    const recoverFromError = this._disabledByError;
    this._disposeScope();
    this._compiled.clear();
    this._compiledSource.clear();
    this._compiledVersion.clear();
    this._faulted = false;
    this._disabledByError = false;
    this._lastError = null;
    if (recoverFromError) this.disabled = false;
    this._resetScope();
    return this;
  }

  onUpdate(entity: Entity, time: number, delta: number, world: World): void { this._run('onUpdate', entity, world, time, delta); }
  onEntityAddComponent(entity: Entity, component: Component): void {
    this._run('onEntityAddComponent', entity, entity.usedBy[0] ?? null, 0, 0, { component });
  }
  onEntityRemoveComponent(entity: Entity, component: Component): void {
    this._run('onEntityRemoveComponent', entity, entity.usedBy[0] ?? null, 0, 0, { component });
    if (component === this) this._disposeScope();
  }
  onEntityAddToWorld(entity: Entity, world: World): void { this._run('onEntityAddToWorld', entity, world, 0, 0); }
  onEntityRemoveFromWorld(entity: Entity, world: World): void {
    this._run('onEntityRemoveFromWorld', entity, world, 0, 0);
    this._disposeScope();
  }

  override clone(): ScriptComponent { return new ScriptComponent({ ...this.scripts }, this.resource); }
  override destroy(): void {
    this._unsubscribeResource?.();
    this._unsubscribeResource = null;
    this._disposeScope();
    super.destroy();
  }

  static setRuntimeApiFactory(factory: ScriptRuntimeApiFactory | null): void { ScriptComponent._runtimeApiFactory = factory; }
  static resetRuntimeApiFactory(): void { ScriptComponent._runtimeApiFactory = null; }

  static setExecutionOptions(options: ScriptExecutionOptions): void {
    ScriptComponent._executionOptions = normalizeExecutionOptions(options, ScriptComponent._executionOptions);
    ScriptComponent._executionVersion++;
  }
  static configureExecution(options: ScriptExecutionOptions): void { ScriptComponent.setExecutionOptions(options); }

  /** Trusted project code runs in the page realm. Capabilities are an API boundary, not a security sandbox. */
  static enableTrustedProject(options: Omit<ScriptExecutionOptions, 'enabled' | 'policy' | 'compiler'> = {}): void {
    ScriptComponent.setExecutionOptions({ ...options, enabled: true, policy: 'trusted-project', compiler: defaultScriptCompiler });
  }

  static configureIsolate(options: Omit<ScriptExecutionOptions, 'enabled' | 'policy'> & { compiler: ScriptCompiler }): void {
    ScriptComponent.setExecutionOptions({ ...options, enabled: true, policy: 'custom-isolate' });
  }

  static disableExecution(): void {
    ScriptComponent.setExecutionOptions({ enabled: false, policy: 'disabled', compiler: disabledScriptCompiler });
  }
  static resetExecutionOptions(): void {
    ScriptComponent._executionOptions = DEFAULT_EXECUTION_OPTIONS;
    ScriptComponent._executionVersion++;
  }
  static withExecutionOptions<T>(options: ScriptExecutionOptions, callback: () => T): T {
    const previous = ScriptComponent._executionOptions;
    ScriptComponent.setExecutionOptions(options);
    try { return callback(); }
    finally {
      ScriptComponent._executionOptions = previous;
      ScriptComponent._executionVersion++;
    }
  }

  private _run(
    lifecycle: ScriptLifecycleName,
    entity: Entity,
    world: World | null,
    time: number,
    delta: number,
    event: ScriptLifecycleEvent = {},
  ): void {
    if (this.disabled || this._paused || this._faulted) return;
    const options = ScriptComponent._executionOptions;
    if (!options.enabled || options.policy === 'disabled') return;
    const code = this.getScript(lifecycle)?.trim();
    if (!code) return;
    const context: ScriptRuntimeContext = { lifecycle, entity, component: this, world, time, delta, event };
    try {
      if (options.debugger?.({ ...context, code }) === 'pause') {
        this._paused = true;
        return;
      }
      const fn = this._getCompiled(lifecycle, code);
      options.executor(fn, context, this._createApi(context));
    } catch (cause) {
      this._handleError(cause, context);
    }
  }

  private _getCompiled(lifecycle: ScriptLifecycleName, code: string): ScriptCompiledFunction {
    const cached = this._compiled.get(lifecycle);
    if (cached && this._compiledSource.get(lifecycle) === code && this._compiledVersion.get(lifecycle) === ScriptComponent._executionVersion) return cached;
    const sourceUrl = this._sourceUrl(lifecycle);
    const fn = ScriptComponent._executionOptions.compiler(code, { lifecycle, component: this, code, sourceUrl });
    this._compiled.set(lifecycle, fn);
    this._compiledSource.set(lifecycle, code);
    this._compiledVersion.set(lifecycle, ScriptComponent._executionVersion);
    return fn;
  }

  private _createApi(context: ScriptRuntimeContext): ScriptRuntimeApi {
    this._currentRuntimeContext = context;
    const baseApi: ScriptRuntimeApi = {
      read: Object.freeze({
        data: (target?: Entity | number | string | null) => {
          const current = this._currentRuntimeContext;
          if (!current) return null;
          const entity = target instanceof Entity ? target : target == null ? current.entity : current.world?.getEntity(target) ?? null;
          return entity?.getComponent(DataComponent)?.value ?? null;
        },
        find: (nameOrId: string | number) => context.world?.getEntity(nameOrId) ?? null,
        findAll: (name?: string) => [...context.world?.entities.values() ?? []].filter(entity => name === undefined || entity.name === name),
        findByComponent: () => [],
        getSystem: () => null,
        components: Object.freeze({}),
        canvas: Object.freeze({}),
        pointer: Object.freeze({}),
        engine: Object.freeze({}),
      }),
      input: DEFAULT_SCRIPT_INPUT_API,
      debug: createScriptDebugApi(this._scope, this._createConsole()),
    };
    const extended = ScriptComponent._runtimeApiFactory?.(baseApi, context) ?? baseApi;
    return filterScriptRuntimeApi(extended, ScriptComponent._executionOptions.capabilities);
  }

  private _handleError(cause: unknown, context: ScriptRuntimeContext): void {
    const options = ScriptComponent._executionOptions;
    const rawLocation = parseSourceLocation(cause, this._sourceUrl(context.lifecycle));
    const sourceLocation = options.sourceMap?.(rawLocation, context) ?? rawLocation;
    const resource = this.resource;
    const error = new EngineError(EngineErrorCode.ComponentScriptFailed, cause instanceof Error ? cause.message : String(cause), {
      domain: ErrorDomain.Script,
      recovery: ErrorRecovery.Ignore,
      recoverable: true,
      context: {
        scriptResourceId: resource?.id ?? null,
        scriptResourceName: resource?.name ?? null,
        entityId: context.entity.id,
        entityName: context.entity.name,
        componentId: this.id,
        lifecycle: context.lifecycle,
        source: sourceLocation.source,
        line: sourceLocation.line,
        column: sourceLocation.column,
      },
      path: resource ? `scripts[${resource.id}].${context.lifecycle}` : `components[${this.id}].scripts.${context.lifecycle}`,
      docsPath: 'errors/E_COMPONENT_SCRIPT_FAILED',
      cause,
    });
    const event: ScriptRuntimeErrorEvent = {
      ...context,
      error,
      cause,
      sourceLocation,
      scriptResource: resource ? { id: resource.id, name: resource.name, sourcePath: resource.sourcePath } : null,
    };
    this._lastError = event;
    if (options.errorPolicy === 'disable-script') {
      this._faulted = true;
      this._disabledByError = true;
      this.disabled = true;
      this._disposeScope();
    } else if (options.errorPolicy === 'pause-script') {
      this._paused = true;
    }
    options.onError?.(event);
    this._createConsole().error(error);
  }

  private _sourceUrl(lifecycle: ScriptLifecycleName): string {
    const source = this.resource?.sourcePath ?? `inline-component-${this.id}.js`;
    return `haiyue-script://${encodeURI(source)}?resource=${this.resource?.id ?? 'inline'}&lifecycle=${lifecycle}`;
  }

  private _createConsole(): Console {
    const scoped = Object.create(console) as Console;
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      scoped[level] = (...args: unknown[]) => console[level](this._consolePrefix(), ...args);
    }
    return scoped;
  }

  private _consolePrefix(): string {
    const context = this._currentRuntimeContext;
    if (!context) return `[ScriptComponent script=${this.id}]`;
    return `[ScriptComponent entity=${context.entity.id}:${context.entity.name} script=${this.id} lifecycle=${context.lifecycle}]`;
  }

  private _disposeScope(): void { this._scope.dispose(); }
  private _resetScope(): void { this._scope = new ScriptExecutionScope(`script:${this.resource?.id ?? this.id}`); }
}

function normalizeScripts(scripts: ScriptComponentScripts): Required<ScriptComponentScripts> {
  return {
    onUpdate: scripts.onUpdate ?? '',
    onEntityAddComponent: scripts.onEntityAddComponent ?? '',
    onEntityRemoveComponent: scripts.onEntityRemoveComponent ?? '',
    onEntityAddToWorld: scripts.onEntityAddToWorld ?? '',
    onEntityRemoveFromWorld: scripts.onEntityRemoveFromWorld ?? '',
  };
}

function normalizeExecutionOptions(
  options: ScriptExecutionOptions,
  previous: NormalizedScriptExecutionOptions,
): NormalizedScriptExecutionOptions {
  return {
    enabled: options.enabled ?? previous.enabled,
    policy: options.policy ?? previous.policy,
    compiler: options.compiler ?? previous.compiler,
    executor: options.executor ?? previous.executor,
    capabilities: options.capabilities ? new Set(options.capabilities) : previous.capabilities,
    debugger: Object.prototype.hasOwnProperty.call(options, 'debugger') ? options.debugger ?? null : previous.debugger,
    errorPolicy: options.errorPolicy ?? previous.errorPolicy,
    onError: Object.prototype.hasOwnProperty.call(options, 'onError') ? options.onError ?? null : previous.onError,
    sourceMap: Object.prototype.hasOwnProperty.call(options, 'sourceMap') ? options.sourceMap ?? null : previous.sourceMap,
  };
}

function disabledScriptCompiler(): ScriptCompiledFunction {
  throw new EngineError(EngineErrorCode.ComponentScriptExecutionDisabled, 'Script execution is disabled.', {
    hint: 'Call ScriptComponent.enableTrustedProject() for trusted project scripts, or configureIsolate() with an isolated compiler/executor.',
    docsPath: 'errors/E_COMPONENT_SCRIPT_EXECUTION_DISABLED',
  });
}

function defaultScriptCompiler(code: string, context: ScriptCompilerContext): ScriptCompiledFunction {
  return new Function('entity', 'component', 'world', 'time', 'delta', 'event', 'api', `${code}\n//# sourceURL=${context.sourceUrl}`) as ScriptCompiledFunction;
}

function defaultScriptExecutor(compiled: ScriptCompiledFunction, context: ScriptRuntimeContext, api: ScriptRuntimeApi): unknown {
  return compiled(context.entity, context.component, context.world, context.time, context.delta, context.event, api);
}

function parseSourceLocation(cause: unknown, fallbackSource: string): ScriptSourceLocation {
  const stack = cause instanceof Error ? cause.stack ?? '' : '';
  const escaped = fallbackSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack) ?? /(?:eval|<anonymous>):(\d+):(\d+)/.exec(stack);
  return {
    source: fallbackSource,
    line: match ? Math.max(1, Number(match[1]) - 2) : null,
    column: match ? Number(match[2]) : null,
  };
}

export { LIFECYCLES as SCRIPT_LIFECYCLES };
export type { ScriptCapabilityName, ScriptRuntimeApi } from '../script/ScriptRuntimeContract';
