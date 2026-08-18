import { mergeSceneDefaults, type SceneDefaults } from '../core/EngineDefaults';
import type { ComponentRegistration, EnginePlugin, ScenePluginScene } from '../core/EnginePlugin';
import type { IEngine } from '../core/IEngine';
import type { SceneLifecycleState } from '../core/Lifecycle';
import { Entity } from '../ecs/Entity';
import type { System } from '../ecs/System';
import type { World } from '../ecs/World';
import type { GuiSystem } from '../gui/systems/GuiSystem';
import type { RenderIntegration } from '../renderer/RenderIntegration';
import type { RenderPipeline, RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { PipelineWarmupPlan, PipelineWarmupProgress, PipelineWarmupRunOptions } from '../renderer/PipelineWarmup';
import type { Mesh2DRenderSystem } from '../systems/Mesh2DRenderSystem';
import type { Render3DSystem } from '../systems/Render3DSystem';
import { SceneAssets } from './internal/SceneAssets';
import type {
  SceneAssetRequest,
  SceneCameraOptions,
  SceneCreateOptions,
  SceneLoadedAssets,
  SceneOptions,
  ScenePreset,
  SceneRenderViewOptions,
} from './internal/SceneContracts';
import { ScenePlugins } from './internal/ScenePlugins';
import { normalizeSceneOptions } from './internal/ScenePresetFactory';
import { SceneRuntime } from './internal/SceneRuntime';
import { SceneSystems } from './internal/SceneSystems';

export type {
  SceneAssetRequest,
  SceneCameraOptions,
  SceneCreateOptions,
  SceneLoadedAssets,
  SceneOptions,
  ScenePreset,
  SceneRenderViewOptions,
} from './internal/SceneContracts';
export { normalizeSceneOptions } from './internal/ScenePresetFactory';

const systemsByScene = new WeakMap<Scene, SceneSystems>();

/** Experimental scheduler accessor. Import from `@haiyue/engine/experimental`. */
export function getSceneRenderPipeline(scene: Scene): RenderPipeline {
  return systemsByScene.get(scene)!.renderPipeline;
}

/** Experimental scheduler accessor. Import from `@haiyue/engine/experimental`. */
export function getSceneRenderIntegration(scene: Scene): RenderIntegration {
  return systemsByScene.get(scene)!.renderIntegration;
}

/** Public scene facade; lifecycle, systems, assets, presets and plugins live in replaceable services. */
export class Scene implements ScenePluginScene {
  readonly defaults: SceneDefaults;
  private readonly _runtime: SceneRuntime;
  private readonly _systems: SceneSystems;
  private readonly _assets: SceneAssets;
  private readonly _plugins: ScenePlugins;

  constructor(
    readonly engine: IEngine,
    options: SceneOptions = {},
  ) {
    this.defaults = mergeSceneDefaults(engine.defaults, engine.defaults?.scene, options.defaults);
    this._runtime = new SceneRuntime(engine, options.name ?? 'Scene');
    this._systems = new SceneSystems(engine, this._runtime.world, this.defaults, options);
    systemsByScene.set(this, this._systems);
    this._assets = new SceneAssets(engine, this._runtime);
    this._plugins = new ScenePlugins(engine, this, this._systems);
  }

  get state(): SceneLifecycleState { return this._runtime.state; }
  get world(): World { return this._runtime.world; }
  get renderView() { return this._systems.renderView; }
  get cameraEntity(): Entity { return this._systems.cameraEntity; }
  get activeCameraEntity(): Entity { return this._systems.activeCameraEntity; }
  get render3DSystem(): Render3DSystem | null { return this._systems.render3DSystem; }
  get render2DSystem(): Mesh2DRenderSystem | null { return this._systems.render2DSystem; }
  get guiSystem(): GuiSystem | null { return this._systems.guiSystem; }

  add(entity: Entity): this {
    this._runtime.assertUsable('add');
    this.world.addEntity(entity);
    return this;
  }

  remove(entity: Entity | string | number): this {
    this._runtime.assertUsable('remove');
    const target = entity instanceof Entity ? entity : this.world.getEntity(entity);
    if (target && target !== this.cameraEntity) this.world.removeEntity(target);
    return this;
  }

  clear(options: { keepCamera?: boolean } = {}): this {
    this._runtime.assertUsable('clear');
    this._systems.clearEntities(options.keepCamera ?? true);
    return this;
  }

  setCamera(entity: Entity): this {
    this._runtime.assertUsable('setCamera');
    this._systems.setCamera(entity);
    return this;
  }

  addSystem(system: System, renderOptions?: RenderPipelineEntryOptions | false | null): this {
    this._runtime.assertUsable('addSystem');
    this._systems.addSystem(system, renderOptions);
    return this;
  }

  installPlugin(plugin: EnginePlugin): this { this._plugins.install(plugin); return this; }
  enablePlugin(name: string): this { this._plugins.enable(name); return this; }
  disablePlugin(name: string): this { this._plugins.disable(name); return this; }
  removePlugin(name: string): this { this._plugins.remove(name); return this; }
  hasPlugin(name: string): boolean { return this._plugins.hasPlugin(name); }
  isPluginEnabled(name: string): boolean { return this._plugins.isPluginEnabled(name); }

  registerComponent(registration: ComponentRegistration): this {
    this._runtime.assertUsable('registerComponent');
    this._plugins.registerComponent(registration);
    return this;
  }

  getRegisteredComponent(type: string): ComponentRegistration | undefined {
    return this._plugins.getRegisteredComponent(type);
  }

  update(time = performance.now(), delta = 0): this { this._runtime.update(time, delta); return this; }
  async load<T = unknown>(request: SceneAssetRequest<T>): Promise<T> { return await this._assets.load(request, this); }
  async loadMany<T = unknown>(requests: readonly SceneAssetRequest<T>[]): Promise<SceneLoadedAssets<T>> {
    return await this._assets.loadMany(requests, this);
  }
  /** Builds a composable shader warmup plan from the scene's installed systems. */
  createPipelineWarmupPlan(label?: string): PipelineWarmupPlan {
    this._runtime.assertUsable('createPipelineWarmupPlan');
    return this._systems.createPipelineWarmupPlan(label);
  }
  /** Compiles common scene pipeline variants outside the first-frame render path. */
  async warmupPipelines(options: PipelineWarmupRunOptions = {}): Promise<PipelineWarmupProgress> {
    this._runtime.assertUsable('warmupPipelines');
    return await this.createPipelineWarmupPlan().run(options);
  }
  releaseAssets(): this { this._assets.releaseAll(); return this; }

  destroy(): void {
    if (!this._runtime.beginDestroy()) return;
    this._plugins.destroy();
    this._assets.destroy();
    this._runtime.finishDestroy();
  }

  activate(): this { this._runtime.activate(); return this; }
  deactivate(): this { this._runtime.deactivate(); return this; }

  async suspendForDeviceLoss(): Promise<void> {
    this._runtime.assertUsable('suspendForDeviceLoss');
    this._assets.suspendForDeviceLoss();
    this._plugins.disableAll();
  }

  async recoverDevice(_device: GPUDevice, signal: AbortSignal): Promise<readonly string[]> {
    this._runtime.assertUsable('recoverDevice');
    if (signal.aborted) return [];
    this._assets.recoverDevice();
    this._plugins.enableAll();
    return [];
  }
}
