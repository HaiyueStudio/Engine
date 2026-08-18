import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { Line3D } from '../components/Line3D';
import { Transform3D } from '../components/Transform3D';
import { Camera3D } from '../components/Camera3D';
import { Line3DRenderer } from '../renderer/Line3DRenderer';
import type { ViewportRect, ScissorRect } from '../core/ViewportRect';
import { updateEntityWorldMatrix } from './worldMatrix';
import { IDENTITY_MAT4 } from '../math/constants';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../core/RenderCommandContext';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { requiredItemAt, requiredMat4Array, requiredVec3Array } from '../math/arrayAccess';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getRenderViewPassOptions } from '../core/RenderView';
import { cloneRenderPassDescriptor } from '../core/renderPassDescriptor';

export interface Line3DRenderSystemOptions {
  reverseZ?: boolean;
  msaaSamples?: 1 | 4;
  viewport?: ViewportRect | null;
  scissor?:  ScissorRect  | null;
  loadOp?: 'clear' | 'load';
}

export class Line3DRenderSystem extends System {
  private engine: IEngine;
  private cameraEntity: Entity;
  private renderer: Line3DRenderer;
  private _prepared = false;
  private readonly _cameraPosition = new Float32Array(3);
  private readonly _liveEntities = new Set<number>();
  private readonly _liveGeometries = new Set<number>();
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _worldMatrixCache = new Map<Entity, Transform3D | null>();

  reverseZ: boolean;
  msaaSamples: 1 | 4;
  viewport: ViewportRect | null;
  scissor:  ScissorRect  | null;
  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'Line3DRenderSystem' as const };
  private readonly unregisterRecovery: (() => void) | null;

  constructor(
    engine: IEngine,
    cameraEntity: Entity,
    options: Line3DRenderSystemOptions = {},
  ) {
    super({ all: [Line3D] });
    this.engine = engine;
    this.cameraEntity = cameraEntity;
    this.reverseZ    = options.reverseZ    ?? engine.reverseZ;
    this.msaaSamples = options.msaaSamples ?? engine.msaaSamples;
    this.viewport    = options.viewport    ?? null;
    this.scissor     = options.scissor     ?? null;
    this.loadOp      = options.loadOp      ?? 'load';
    this.renderer = new Line3DRenderer();
    this.name = 'Line3DRenderSystem';
    this.recoveryLabel = `${this.name}:${this.id}`;
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
  }

  contributePipelineWarmup(plan: PipelineWarmupPlan): void {
    if (!this._prepared) {
      this.renderer.prepare(this.engine);
      this._prepared = true;
    }
    this.renderer.reverseZ = this.reverseZ;
    this.renderer.msaaSamples = this.msaaSamples;
    this.renderer.contributePipelineWarmup(plan);
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    const { device } = context;
    if (!device) return this;

    if (!this._prepared) {
      this.renderer.prepare(this.engine);
      this._prepared = true;
    }
    this._liveEntities.clear();
    this._liveGeometries.clear();
    this._worldMatrixCache.clear();

    const reverseZ = context.view?.reverseZ ?? this.reverseZ;
    const sampleCount = context.view?.sampleCount ?? this.msaaSamples;
    this.renderer.reverseZ = reverseZ;
    this.renderer.msaaSamples = sampleCount;

    const cameraEntity = context.view?.camera.getComponent(Camera3D) ? context.view.camera : this.cameraEntity;
    const camera = cameraEntity.getComponent(Camera3D);
    if (!camera) return this;

    const vpW = context.view?.width ?? this.viewport?.width ?? this.engine.width;
    const vpH = context.view?.height ?? this.viewport?.height ?? this.engine.height;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera3D(cameraEntity, camera, vpW, vpH, reverseZ);
    const camWorldMatrix = requiredMat4Array(cameraFrame.worldMatrix, 'Line3D camera world matrix');
    const viewProj = cameraFrame.viewProjectionMatrix;
    const camPos = requiredVec3Array(this._cameraPosition, 'Line3D camera position');
    camPos[0] = camWorldMatrix[12];
    camPos[1] = camWorldMatrix[13];
    camPos[2] = camWorldMatrix[14];

    // Use viewport dimensions so screen-space line widths are consistent per pane
    this.renderer.updateCamera(viewProj, camPos, vpW, vpH);

    if (!context.passEncoder) {
      context.descriptor = context.view
        ? cloneRenderPassDescriptor(
            context.view.target.getRenderPassDescriptor(getRenderViewPassOptions(context.view)),
            this.loadOp,
          )
        : getCachedRenderPassDescriptor(this.engine, this.loadOp);
      context.loadOp = this.loadOp;
      const colorAtt = requiredItemAt(
        context.descriptor.colorAttachments as GPURenderPassColorAttachment[],
        0,
        'Line3D color attachments',
      );
      colorAtt.storeOp = 'store';
    }
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);

    // ── Viewport & Scissor ────────────────────────────────────────────────────
    const viewport = context.view?.viewport ?? this.viewport;
    const scissor = context.view?.scissor ?? this.scissor;
    if (viewport) {
      const vp = viewport;
      passEncoder.setViewport(
        vp.x, vp.y, vp.width, vp.height,
        vp.minDepth ?? 0, vp.maxDepth ?? 1,
      );
    }
    if (scissor) {
      const s = scissor;
      passEncoder.setScissorRect(s.x, s.y, s.width, s.height);
    }

    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      updateEntityWorldMatrix(entity, this._worldMatrixCache);
      const line = entity.getComponent(Line3D);
      if (!line) continue;
      const transform = entity.getComponent(Transform3D);
      const worldMatrix = transform ? transform.worldMatrix : IDENTITY_MAT4;
      this._liveEntities.add(entity.id);
      this._liveGeometries.add(line.geometry.id);
      this.renderer.render(passEncoder, entity.id, line.geometry, line.material, worldMatrix);
    }

    if (ownsPass) passEncoder.end();
    this.renderer.releaseEntitiesNotIn(this._liveEntities);
    this.renderer.releaseGeometriesNotIn(this._liveGeometries);
    return this;
  }

  suspendForDeviceLoss(): void {
    this.renderer.destroy();
    this._prepared = false;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = new Line3DRenderer();
    this._prepared = false;
  }

  override destroy(): this {
    this.unregisterRecovery?.();
    this.suspendForDeviceLoss();
    return super.destroy();
  }

}
