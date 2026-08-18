import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { Camera3D } from '../components/Camera3D';
import { Mesh3D } from '../components/Mesh3D';
import { Transform3D } from '../components/Transform3D';
import { RadialShadowMaterial } from '../material/RadialShadowMaterial';
import { RadialShadowRenderer } from '../renderer/RadialShadowRenderer';
import { mat4 } from 'wgpu-matrix';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { updateEntityWorldMatrix } from './worldMatrix';
import { IDENTITY_MAT4 } from '../math/constants';
import { getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../core/RenderCommandContext';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderPassContributor } from '../renderer/RenderFeature';
import type { RenderPipelineEntryOptions } from '../renderer/RenderPipeline';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getRenderViewPassOptions } from '../core/RenderView';
import { cloneRenderPassDescriptor } from '../core/renderPassDescriptor';

export interface RadialShadowRenderFeatureOptions {
  loadOp?: 'clear' | 'load';
  priority?: number;
}

export class RadialShadowRenderFeature extends System implements RenderPassContributor {
  private engine: IEngine;
  private cameraEntity: Entity;
  private renderer: RadialShadowRenderer | null = null;
  private readonly _viewMatrix = mat4.identity() as Float32Array;
  private readonly _viewProjMatrix = mat4.identity() as Float32Array;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _liveMaterials = new Set<number>();
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _worldMatrixCache = new Map<Entity, Transform3D | null>();
  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'RadialShadowRenderFeature' as const };
  private readonly unregisterRecovery: (() => void) | null;

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return { pass: 'shared', loadOp: this.loadOp };
  }

  constructor(engine: IEngine, cameraEntity: Entity, options: RadialShadowRenderFeatureOptions = {}) {
    super({ all: [Mesh3D] });
    this.engine = engine;
    this.cameraEntity = cameraEntity;
    this.loadOp = options.loadOp ?? 'load';
    this.name = 'RadialShadowRenderFeature';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
    if (options.priority !== undefined) this.priority = options.priority;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    if (!this.renderer) {
      this.renderer = new RadialShadowRenderer();
      this.renderer.prepare(this.engine);
    }
    this.renderer.reverseZ = this.engine.reverseZ;
    this.renderer.msaaSamples = this.engine.msaaSamples;
    this.renderer.contributePipelineWarmup(plan);
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    const { device } = context;
    if (!device) return this;

    if (!this.renderer) {
      this.renderer = new RadialShadowRenderer();
      this.renderer.prepare(this.engine);
    }
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._liveMaterials.clear();
    this._worldMatrixCache.clear();
    const reverseZ = context.view?.reverseZ ?? this.engine.reverseZ;
    this.renderer.reverseZ = reverseZ;
    this.renderer.msaaSamples = context.view?.sampleCount ?? this.engine.msaaSamples;

    const cameraEntity = context.view?.camera.getComponent(Camera3D) ? context.view.camera : this.cameraEntity;
    const cam3D = cameraEntity.getComponent(Camera3D);
    if (!cam3D) return this;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera3D(
      cameraEntity,
      cam3D,
      context.view?.width ?? this.engine.width,
      context.view?.height ?? this.engine.height,
      reverseZ,
    );
    const viewProj = cameraFrame.viewProjectionMatrix;
    this.renderer.updateCamera(viewProj);

    if (!context.passEncoder) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(
            context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)),
            this.loadOp,
          )
        : getCachedRenderPassDescriptor(this.engine, this.loadOp);
      context.loadOp = this.loadOp;
    }
    const { passEncoder: pass, ownsPass } = beginRenderCommandPass(context);

    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      const mesh = entity.getComponent(Mesh3D);
      if (!mesh) continue;
      if (mesh.material.type !== 'radial-shadow') continue;
      const t = updateEntityWorldMatrix(entity, this._worldMatrixCache);
      this._liveEntities.add(entity.id);
      this._liveGeometries.add(mesh.geometry.id);
      this._liveMaterials.add((mesh.material as RadialShadowMaterial).id);
      this.renderer!.render(pass, entity.id, mesh.geometry, mesh.material as RadialShadowMaterial, t ? t.worldMatrix : IDENTITY_MAT4);
    }

    if (ownsPass) pass.end();
    this.renderer.releaseEntitiesNotIn(this._liveEntities);
    this.renderer.releaseGeometriesNotIn(this._liveGeometries);
    this.renderer.releaseMaterialsNotIn(this._liveMaterials);
    return this;
  }

  override destroy(): this {
    this.unregisterRecovery?.();
    this.suspendForDeviceLoss();
    return super.destroy();
  }

  suspendForDeviceLoss(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = null;
  }
}
