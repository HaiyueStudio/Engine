import { Camera2D } from '../../components/Camera2D';
import { Camera3D } from '../../components/Camera3D';
import { SphericalTransform3D } from '../../components/SphericalTransform3D';
import type { SceneDefaults } from '../../core/EngineDefaults';
import type { IEngine } from '../../core/IEngine';
import { Entity } from '../../ecs/Entity';
import type { System } from '../../ecs/System';
import type { World } from '../../ecs/World';
import { GuiSystem, type GuiSystemOptions } from '../../gui/systems/GuiSystem';
import { RenderIntegration, getSystemRenderPipelineOptions, isRenderPipelineSystem } from '../../renderer/RenderIntegration';
import type { RenderPipeline, RenderPipelineEntryOptions } from '../../renderer/RenderPipeline';
import { PipelineWarmupPlan, isPipelineWarmupParticipant } from '../../renderer/PipelineWarmup';
import { Mesh2DRenderSystem, type Mesh2DRenderSystemOptions } from '../../systems/Mesh2DRenderSystem';
import { Render3DSystem, type Render3DSystemOptions } from '../../systems/Render3DSystem';
import type { SceneCameraOptions, SceneOptions } from './SceneContracts';
import { createSceneSystemPlan, type SceneSystemPlanEntry, type SceneSystemRole } from './ScenePresetFactory';
import { RenderView } from '../../core/RenderView';

type SystemInstaller = (entry: SceneSystemPlanEntry) => void;

export class SceneSystems {
  readonly renderIntegration: RenderIntegration;
  readonly renderPipeline: RenderPipeline;
  readonly renderView: RenderView;
  readonly cameraEntity: Entity;
  render3DSystem: Render3DSystem | null = null;
  render2DSystem: Mesh2DRenderSystem | null = null;
  guiSystem: GuiSystem | null = null;
  private _activeCameraEntity: Entity;
  private readonly _installers: Readonly<Record<SceneSystemRole, SystemInstaller>>;

  constructor(
    private readonly _engine: IEngine,
    private readonly _world: World,
    private readonly _defaults: SceneDefaults,
    options: SceneOptions,
  ) {
    this.cameraEntity = createCamera(_defaults.camera, options.camera);
    this._activeCameraEntity = this.cameraEntity;
    const render3DDefaults = _defaults.render3D ?? {};
    const render3DOptions = options.render3D && options.render3D !== true ? options.render3D : {};
    this.renderView = new RenderView({
      camera: this.cameraEntity,
      target: options.view?.target ?? _engine.renderTarget,
      clearColor: options.view?.clearColor ?? _defaults.clearColor ?? _engine.clearColor,
      depthConvention: options.view?.depthConvention
        ?? ((render3DOptions.reverseZ ?? render3DDefaults.reverseZ ?? _defaults.reverseZ ?? _engine.reverseZ) ? 'reverse' : 'standard'),
      sampleCount: options.view?.sampleCount ?? render3DOptions.msaaSamples ?? render3DDefaults.msaaSamples ?? _engine.msaaSamples,
      viewport: options.view?.viewport ?? render3DOptions.viewport ?? render3DDefaults.viewport ?? null,
      scissor: options.view?.scissor ?? render3DOptions.scissor ?? render3DDefaults.scissor ?? null,
    });
    this.renderIntegration = new RenderIntegration(_engine, {
      label: options.pipelineLabel ?? _defaults.renderPipeline?.label ?? `${_world.name}.render`,
      view: this.renderView,
    });
    this.renderPipeline = this.renderIntegration.pipeline;
    _world.addRuntimeIntegration(this.renderIntegration);
    _world.addEntity(this.cameraEntity);
    this._installers = {
      render3d: entry => this._installRender3D(entry.option as SceneOptions['render3D']),
      render2d: entry => this._installRender2D(entry.option as SceneOptions['render2D']),
      gui: entry => this._installGui(entry.option as SceneOptions['gui']),
    };
    for (const entry of createSceneSystemPlan(options)) this._installers[entry.role](entry);
  }

  get activeCameraEntity(): Entity { return this._activeCameraEntity; }

  addSystem(system: System, renderOptions?: RenderPipelineEntryOptions | false | null): void {
    this._world.addSystem(system);
    if (renderOptions !== false && isRenderPipelineSystem(system)) {
      this.renderIntegration.register(system, renderOptions ?? getSystemRenderPipelineOptions(system) ?? { pass: 'shared' });
    }
  }

  setCamera(entity: Entity): void {
    if (!this._world.hasEntity(entity)) this._world.addEntity(entity);
    this._activeCameraEntity = entity;
    this.renderView.camera = entity;
    this.render3DSystem?.setCameraEntity(entity);
    this.render2DSystem?.setCameraEntity(entity);
  }

  clearEntities(keepCamera = true): void {
    if (!keepCamera) {
      this._world.clearEntities();
      return;
    }
    for (const entity of [...this._world.rootEntityList]) {
      if (entity !== this.cameraEntity) this._world.removeEntity(entity);
    }
    if (!this._world.hasEntity(this.cameraEntity)) this._world.addEntity(this.cameraEntity);
  }

  createPipelineWarmupPlan(label = `${this._world.name} shader pipelines`): PipelineWarmupPlan {
    const plan = new PipelineWarmupPlan(label);
    for (const system of this._world.systems.values()) {
      if (isPipelineWarmupParticipant(system)) system.contributePipelineWarmup(plan);
    }
    return plan;
  }

  private _installRender3D(option: SceneOptions['render3D']): void {
    const defaults = this._defaults.render3D ?? {};
    const options = option === true || option === undefined ? defaults : { ...defaults, ...option };
    const system = new Render3DSystem(this._engine, this.cameraEntity, {
      reverseZ: this.renderView.reverseZ,
      msaaSamples: this.renderView.sampleCount,
      viewport: this.renderView.viewport,
      scissor: this.renderView.scissor,
      ...(options as Render3DSystemOptions),
    });
    this.addSystem(system, { ...(this._defaults.renderPipeline?.entry ?? {}), ...system.renderPipelineOptions });
    this.render3DSystem = system;
  }

  private _installRender2D(option: SceneOptions['render2D']): void {
    const defaults = this._defaults.render2D ?? {};
    const options = option === true ? defaults : { ...defaults, ...(option as Mesh2DRenderSystemOptions) };
    const system = new Mesh2DRenderSystem(this._engine, this.cameraEntity, {
      loadOp: this.render3DSystem ? 'load' : 'clear',
      ...options,
    });
    this.addSystem(system, { ...(this._defaults.renderPipeline?.entry ?? {}), pass: 'shared', loadOp: system.loadOp });
    this.render2DSystem = system;
  }

  private _installGui(option: SceneOptions['gui']): void {
    const defaults = this._defaults.gui ?? {};
    const options = option === true ? defaults : { ...defaults, ...(option as GuiSystemOptions) };
    const system = new GuiSystem(this._engine, options);
    this.addSystem(system, { ...(this._defaults.renderPipeline?.entry ?? {}), pass: 'shared', loadOp: system.loadOp });
    this.guiSystem = system;
  }
}

function createCamera(defaults: SceneCameraOptions | undefined, cameraOption: SceneOptions['camera']): Entity {
  if (cameraOption instanceof Entity) return cameraOption;
  const options = mergeCameraInput(defaults, cameraOption ?? {});
  if (options.entity) return options.entity;
  const entity = new Entity(options.name ?? 'Camera');
  if (options.type === '2d') {
    entity.addComponent(new Camera2D(options.camera2D));
  } else {
    entity.addComponent(new Camera3D(options.camera3D));
    entity.addComponent(new SphericalTransform3D(options.orbit));
  }
  return entity;
}

function mergeCameraInput(defaults: SceneCameraOptions | undefined, input: SceneCameraOptions): SceneCameraOptions {
  return {
    ...(defaults ?? {}),
    ...input,
    camera3D: input.camera3D ? { ...(defaults?.camera3D ?? {}), ...input.camera3D } : defaults?.camera3D,
    camera2D: input.camera2D ? { ...(defaults?.camera2D ?? {}), ...input.camera2D } : defaults?.camera2D,
    orbit: input.orbit ? { ...(defaults?.orbit ?? {}), ...input.orbit } : defaults?.orbit,
  };
}
