import { System } from '../ecs/System';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { BlinnPhongMaterial } from '../material/BlinnPhongMaterial';
import { BlinnPhongRenderer } from '../renderer/BlinnPhongRenderer';
import { Render3DSystem } from './Render3DSystem';
import type { InternalMaterialRenderContext, MaterialRenderContext } from '../renderer/MaterialRendererRegistry';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';

export interface BlinnPhongRenderSystemOptions {
  priority?: number;
  render3DSystem?: Render3DSystem | null;
}

function getInternalContext(context: MaterialRenderContext<BlinnPhongMaterial>) {
  return context as InternalMaterialRenderContext<BlinnPhongMaterial>;
}

export class BlinnPhongRenderSystem extends System {
  private engine: IEngine;

  private _renderer: BlinnPhongRenderer | null = null;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _liveMaterials = new Set<number>();
  private _render3DSystem: Render3DSystem | null = null;
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'BlinnPhongRenderSystem' as const };
  private readonly _unregisterRecovery: (() => void) | null;

  constructor(
    engine: IEngine,
    _cameraEntity?: Entity | null,
    options: BlinnPhongRenderSystemOptions = {},
  ) {
    super(() => false);
    this.engine = engine;
    this.name = 'BlinnPhongRenderSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this._unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    if (options.priority !== undefined) this.priority = options.priority;
    if (options.render3DSystem) this.attachRender3DSystem(options.render3DSystem);
  }

  attachRender3DSystem(render3DSystem: Render3DSystem): this {
    if (this._render3DSystem === render3DSystem) return this;
    this._render3DSystem?.materialRenderers.unregister(BlinnPhongMaterial);
    this._render3DSystem = render3DSystem;
    render3DSystem.registerMaterialRenderer<BlinnPhongMaterial>({
      materialType: BlinnPhongMaterial,
      isTransparent: material => material.blending !== 'none',
      transparentDepthSort: material => material.blending !== 'none',
      beginView: context => {
        const renderer = this._requireRenderer();
        renderer.reverseZ = context.reverseZ;
        renderer.msaaSamples = context.msaaSamples;
        renderer.updateCamera(context.sceneFrameUniforms, context.commandContext);
        renderer.updateLights(context.sceneEnvironment.pbrLights);
      },
      prepareObjects: (context, items, first, count, firstBatchIndex) => {
        this._requireRenderer().prepareObjects(
          items,
          first,
          count,
          firstBatchIndex,
          context.gpuDrivenBatchBuffer,
        );
      },
      flushUploads: () => this._requireRenderer().flushUploads(),
      endView: () => this._requireRenderer().endView(),
      renderItem: context => {
        const internalContext = getInternalContext(context);
        const renderer = this._requireRenderer();
        this._liveEntities.add(context.entityId);
        this._liveGeometries.add(context.geometry.id);
        this._liveMaterials.add(context.material.id);
        renderer.render(context.passEncoder, context.entityId, context.geometry, context.material, context.worldMatrix, {
          gpuDrivenBatch: internalContext.gpuDrivenBatch,
        }, context.clippingPlanes);
      },
      renderBatch: (context, items, first, count, batchBuffer) => {
        const renderer = this._requireRenderer();
        const end = Math.min(items.length, first + count);
        for (let index = first; index < end; index++) {
          const item = items[index];
          if (!item?.geometry || !item.material) continue;
          this._liveEntities.add(item.entityId);
          this._liveGeometries.add(item.geometry.id);
          this._liveMaterials.add(item.material.id);
        }
        renderer.renderBatch(context.passEncoder, items, first, count, batchBuffer);
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
    renderer.reverseZ = this.engine.reverseZ;
    renderer.msaaSamples = this.engine.msaaSamples;
    renderer.contributePipelineWarmup(plan);
  }

  override destroy(): this {
    this._unregisterRecovery?.();
    this.suspendForDeviceLoss();
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._liveMaterials.clear();
    this._render3DSystem?.materialRenderers.unregister(BlinnPhongMaterial);
    this._render3DSystem = null;
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this._renderer?.destroy();
    this._renderer = null;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this._renderer = null;
  }

  private _requireRenderer(): BlinnPhongRenderer {
    if (!this._renderer) {
      this._renderer = new BlinnPhongRenderer();
      this._renderer.prepare(this.engine);
    }
    return this._renderer;
  }

}
