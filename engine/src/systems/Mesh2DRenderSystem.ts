import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { Mesh2D } from '../components/Mesh2D';
import { Camera2D } from '../components/Camera2D';
import { Mesh2DRenderer } from '../renderer/Mesh2DRenderer';
import type { Material2D } from '../material/Material2D';
import type { Material2DRenderBatchItem, Material2DRendererRegistration } from '../renderer/Material2DRendererRegistry';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../core/RenderCommandContext';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getRenderViewPassOptions } from '../core/RenderView';
import { cloneRenderPassDescriptor } from '../core/renderPassDescriptor';

export interface Mesh2DRenderSystemOptions {
  /** 'clear' resets the canvas each frame; 'load' composites on top of prior content (default 'clear'). */
  loadOp?: 'clear' | 'load';
  /** Execution order within the World — lower runs first (default 0). */
  priority?: number;
}

export class Mesh2DRenderSystem extends System {
  private engine:       IEngine;
  private cameraEntity: Entity;

  loadOp: 'clear' | 'load';

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'shared', loadOp: this.loadOp, sort: this.priority };
  }

  private _renderer: Mesh2DRenderer | null = null;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _renderItems: Material2DRenderBatchItem[] = [];
  private readonly _renderItemPool: Material2DRenderBatchItem[] = [];
  private _renderItemCursor = 0;
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'Mesh2DRenderSystem' as const };
  private readonly _unregisterRecovery: (() => void) | null;

  constructor(
    engine:       IEngine,
    cameraEntity: Entity,
    options:      Mesh2DRenderSystemOptions = {},
  ) {
    super({ all: [Mesh2D] });
    this.engine       = engine;
    this.cameraEntity = cameraEntity;
    this.loadOp       = options.loadOp ?? 'clear';
    this.name         = 'Mesh2DRenderSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    if (options.priority !== undefined) this.priority = options.priority;
  }

  public setCameraEntity(cameraEntity: Entity): this {
    this.cameraEntity = cameraEntity;
    return this;
  }

  registerMaterialRenderer<M extends Material2D>(registration: Material2DRendererRegistration<M>): this {
    this._ensureRenderer().registerMaterialRenderer(registration);
    return this;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const renderer = this._ensureRenderer();
    renderer.prepare(this.engine);
    renderer.reverseZ = this.engine.reverseZ;
    renderer.msaaSamples = this.engine.msaaSamples;
    renderer.contributePipelineWarmup(plan);
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    const { device } = context;
    if (!device) return this;

    const renderer = this._ensureRenderer();
    renderer.prepare(this.engine);
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._renderItems.length = 0;
    this._renderItemCursor = 0;
    this._disabledHierarchyCache.clear();

    renderer.reverseZ    = context.view?.reverseZ ?? this.engine.reverseZ;
    renderer.msaaSamples = context.view?.sampleCount ?? this.engine.msaaSamples;

    // ── Camera / viewProj ────────────────────────────────────────────────────
    const cameraEntity = context.view?.camera.getComponent(Camera2D) ? context.view.camera : this.cameraEntity;
    const camera = cameraEntity.getComponent(Camera2D);
    if (!camera) return this;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera2D(
      cameraEntity,
      camera,
      context.view?.displayWidth ?? this.engine.displayWidth,
      context.view?.displayHeight ?? this.engine.displayHeight,
    );

    renderer.updateCamera(cameraFrame.viewProjectionMatrix);

    // ── Render pass ──────────────────────────────────────────────────────────
    if (!context.passEncoder) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(
            context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)),
            this.loadOp,
          )
        : getCachedRenderPassDescriptor(this.engine, this.loadOp);
      context.loadOp = this.loadOp;
    }
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);

    // ── Draw entities ────────────────────────────────────────────────────────
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const mesh = entity.getComponent(Mesh2D);
      if (!mesh) continue;

      // Update world matrix: support both Transform2D and Transform3D
      const worldMatrix = frameData.getWorldMatrix2D(entity);
      this._liveEntities.add(entity.id);
      this._liveGeometries.add(mesh.geometry.id);
      let item = this._renderItemPool[this._renderItemCursor++];
      if (!item) {
        item = { entityId: entity.id, geometry: mesh.geometry, material: mesh.material, worldMatrix };
        this._renderItemPool.push(item);
      } else {
        item.entityId = entity.id;
        item.geometry = mesh.geometry;
        item.material = mesh.material;
        item.worldMatrix = worldMatrix;
      }
      this._renderItems.push(item);
    }
    renderer.renderMany(passEncoder, this._renderItems, context);
    this._renderItems.length = 0;

    if (ownsPass) passEncoder.end();
    renderer.releaseEntitiesNotIn(this._liveEntities);
    renderer.releaseGeometriesNotIn(this._liveGeometries);
    return this;
  }

  private _ensureRenderer(): Mesh2DRenderer {
    if (!this._renderer) this._renderer = new Mesh2DRenderer();
    return this._renderer;
  }

  suspendForDeviceLoss(): void {
    this._renderer?.destroy();
    this._renderer = null;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this._renderer = null;
  }

  override destroy(): this {
    this._unregisterRecovery?.();
    this.suspendForDeviceLoss();
    this._renderItems.length = 0;
    this._renderItemPool.length = 0;
    this._renderItemCursor = 0;
    return super.destroy();
  }
}
