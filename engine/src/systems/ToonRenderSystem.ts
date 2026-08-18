import type { IEngine } from '../core/IEngine';
import type { Entity } from '../ecs/Entity';
import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { ToonMaterial } from '../material/ToonMaterial';
import type { InternalMaterialRenderContext, MaterialRenderContext } from '../renderer/MaterialRendererRegistry';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { ToonRenderer } from '../renderer/ToonRenderer';
import { Render3DSystem } from './Render3DSystem';

export interface ToonRenderSystemOptions {
  priority?: number;
  render3DSystem?: Render3DSystem | null;
}

function getInternalContext(context: MaterialRenderContext<ToonMaterial>) {
  return context as InternalMaterialRenderContext<ToonMaterial>;
}

/** Registers ToonMaterial with an existing Render3DSystem. */
export class ToonRenderSystem extends System {
  private readonly _engine: IEngine;
  private _renderer: ToonRenderer | null = null;
  private _render3DSystem: Render3DSystem | null = null;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _liveMaterials = new Set<number>();
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'ToonRenderSystem' as const };
  private readonly _unregisterRecovery: (() => void) | null;

  constructor(engine: IEngine, _cameraEntity?: Entity | null, options: ToonRenderSystemOptions = {}) {
    super(() => false);
    this._engine = engine;
    this.name = 'ToonRenderSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    if (options.priority !== undefined) this.priority = options.priority;
    if (options.render3DSystem) this.attachRender3DSystem(options.render3DSystem);
  }

  attachRender3DSystem(render3DSystem: Render3DSystem): this {
    if (this._render3DSystem === render3DSystem) return this;
    this._render3DSystem?.materialRenderers.unregister(ToonMaterial);
    this._render3DSystem = render3DSystem;
    render3DSystem.registerMaterialRenderer<ToonMaterial>({
      materialType: ToonMaterial,
      receivesDirectionalShadow: true,
      shadowCullMode: material => material.doubleSided ? 'none' : 'back',
      isTransparent: material => material.alphaMode === 'blend',
      transparentDepthSort: material => material.alphaMode === 'blend',
      beginView: context => this._requireRenderer().beginView(context),
      prepareObjects: (context, items, first, count, firstBatchIndex) => {
        this._requireRenderer().prepareObjects(items, first, count, firstBatchIndex, context.gpuDrivenBatchBuffer);
      },
      flushUploads: () => this._requireRenderer().flushUploads(),
      endView: () => this._requireRenderer().endView(),
      renderItem: context => {
        const renderer = this._requireRenderer();
        this._track(context.entityId, context.geometry.id, context.material.id);
        renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
          gpuDrivenBatch: context.material.alphaMode === 'opaque' ? getInternalContext(context).gpuDrivenBatch : undefined,
        }, context.clippingPlanes);
      },
      renderBatch: (context, items, first, count, batchBuffer) => {
        const end = Math.min(items.length, first + count);
        for (let index = first; index < end; index++) {
          const item = items[index];
          if (!item?.geometry || !item.material) continue;
          this._track(item.entityId, item.geometry.id, item.material.id);
        }
        this._requireRenderer().renderBatch(context.passEncoder, items, first, count, batchBuffer);
      },
    });
    return this;
  }

  update(_world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    this._renderer?.releaseEntitiesNotIn(this._liveEntities);
    this._renderer?.releaseGeometriesNotIn(this._liveGeometries);
    this._renderer?.releaseMaterialsNotIn(this._liveMaterials);
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._liveMaterials.clear();
    return this;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    const renderer = this._requireRenderer();
    renderer.reverseZ = this._engine.reverseZ;
    renderer.msaaSamples = this._engine.msaaSamples;
    renderer.contributePipelineWarmup(plan);
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
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._liveMaterials.clear();
    this._render3DSystem?.materialRenderers.unregister(ToonMaterial);
    this._render3DSystem = null;
    return super.destroy();
  }

  private _track(entityId: number, geometryId: number, materialId: number): void {
    this._liveEntities.add(entityId);
    this._liveGeometries.add(geometryId);
    this._liveMaterials.add(materialId);
  }

  private _requireRenderer(): ToonRenderer {
    if (!this._renderer) {
      this._renderer = new ToonRenderer();
      this._renderer.prepare(this._engine);
    }
    return this._renderer;
  }
}
