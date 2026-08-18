import { EngineError, EngineErrorCode } from '../core/EngineError';
import type { IEngine } from '../core/IEngine';
import { getEngineGPUResourceTracker } from '../core/EngineDiagnosticsAccess';
import type { World, WorldRuntimeIntegration } from '../ecs/World';
import { System } from '../ecs/System';
import { RenderPipeline } from './RenderPipeline';
import type {
  RenderPipelineEntryOptions,
  RenderPipelineExecuteOptions,
  RenderPipelineSystem,
} from './RenderPipeline';
import { RenderSystemResourceOwnership } from './RenderSystemResourceOwnership';
import type { WorldFrameToken } from '../frame/FrameData';

export interface RenderIntegrationOptions extends RenderPipelineExecuteOptions {
  pipeline?: RenderPipeline;
}

export type RenderPipelineEntryOptionsFactory = (
  system: RenderPipelineSystem & Partial<System>,
) => RenderPipelineEntryOptions | false | null | undefined;

export class RenderIntegration implements WorldRuntimeIntegration {
  readonly pipeline: RenderPipeline;
  private _world: World | null = null;
  private _executeOptions: RenderPipelineExecuteOptions;
  private _systems = new WeakSet<RenderPipelineSystem>();
  private _systemSet = new Set<System>();
  private _autoUpdate = new WeakMap<object, boolean>();

  constructor(
    private readonly _engine: IEngine,
    options: RenderIntegrationOptions = {},
  ) {
    const resourceTracker = getEngineGPUResourceTracker(_engine);
    this.pipeline = options.pipeline ?? new RenderPipeline(
      _engine,
      resourceTracker ? new RenderSystemResourceOwnership(resourceTracker) : undefined,
    );
    const { pipeline: _pipeline, ...executeOptions } = options;
    this._executeOptions = executeOptions;
  }

  onAttach(world: World): void {
    this._world = world;
  }

  onDetach(): void {
    this.clear();
    this._world = null;
  }

  setExecuteOptions(options: RenderPipelineExecuteOptions): this {
    this._executeOptions = { ...options };
    return this;
  }

  register(system: RenderPipelineSystem & Partial<System>, options?: RenderPipelineEntryOptions): this {
    if (this._systems.has(system)) return this;
    if (typeof system.autoUpdate === 'boolean') {
      this._autoUpdate.set(system, system.autoUpdate);
      system.autoUpdate = false;
    }
    this.pipeline.add(system, mergeRenderPipelineOptions(getSystemRenderPipelineOptions(system), options));
    this._systems.add(system);
    if (system instanceof System) this._systemSet.add(system);
    return this;
  }

  registerAll(world: World = this._requireWorld(), optionsForSystem?: RenderPipelineEntryOptionsFactory): this {
    for (const system of world.systems.values()) {
      if (!isRenderPipelineSystem(system)) continue;
      const options = optionsForSystem?.(system);
      if (options === false) continue;
      this.register(system, options ?? getSystemRenderPipelineOptions(system));
    }
    return this;
  }

  unregister(system: RenderPipelineSystem | System): this {
    if (!this._systems.has(system as RenderPipelineSystem)) return this;
    this.pipeline.remove(system as RenderPipelineSystem);
    this._systems.delete(system as RenderPipelineSystem);
    this._restoreAutoUpdate(system as RenderPipelineSystem & Partial<System>);
    if (system instanceof System) this._systemSet.delete(system);
    return this;
  }

  clear(): void {
    for (const system of this._systemSet) this._restoreAutoUpdate(system);
    this.pipeline.clear();
    this._systems = new WeakSet<RenderPipelineSystem>();
    this._autoUpdate = new WeakMap<object, boolean>();
    this._systemSet.clear();
  }

  onSystemRemoved(system: System): void {
    this.unregister(system);
  }

  shouldUpdateSystem(system: System): boolean {
    return !this._systemSet.has(system);
  }

  update(world: World, time: number, delta: number, frameToken: WorldFrameToken): void {
    const options = this._executeOptions;
    const previousFrameData = options.frameData;
    const previousFrameToken = options.frameToken;
    if (!options.frameData) options.frameData = world.frameData;
    options.frameToken = options.frameData === world.frameData ? frameToken : undefined;
    try {
      this.pipeline.execute(world, time, delta, options);
    } finally {
      options.frameData = previousFrameData;
      options.frameToken = previousFrameToken;
    }
  }

  private _restoreAutoUpdate(system: object & Partial<System>): void {
    const previous = this._autoUpdate.get(system);
    if (typeof previous === 'boolean' && typeof system.autoUpdate === 'boolean') {
      system.autoUpdate = previous;
    }
    this._autoUpdate.delete(system);
  }

  private _requireWorld(): World {
    if (!this._world) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineMissing,
        'RenderIntegration.registerAll() requires an attached World.',
        {
          hint: 'Call world.addRuntimeIntegration(renderIntegration) before registerAll(), or pass a World explicitly.',
          docsPath: 'errors/E_RENDER_PIPELINE_MISSING',
        },
      );
    }
    return this._world;
  }
}

export function isRenderPipelineSystem(system: object): system is RenderPipelineSystem & Partial<System> {
  return typeof (system as { record?: unknown }).record === 'function';
}

export function getSystemRenderPipelineOptions(system: RenderPipelineSystem & Partial<System>): RenderPipelineEntryOptions | undefined {
  const options = (system as { renderPipelineOptions?: unknown }).renderPipelineOptions;
  return options && typeof options === 'object' ? options as RenderPipelineEntryOptions : undefined;
}

function mergeRenderPipelineOptions(
  base: RenderPipelineEntryOptions | undefined,
  override: RenderPipelineEntryOptions | undefined,
): RenderPipelineEntryOptions | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}
