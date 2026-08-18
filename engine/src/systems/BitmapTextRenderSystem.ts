import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import type { IEngine } from '../core/IEngine';
import { BitmapText } from '../components/BitmapText';
import { Transform3D } from '../components/Transform3D';
import { Camera3D } from '../components/Camera3D';
import { BitmapTextRenderer } from '../renderer/BitmapTextRenderer';
import { mat4 } from 'wgpu-matrix';
import type { ViewportRect, ScissorRect } from '../core/ViewportRect';
import { updateEntityWorldMatrix } from './worldMatrix';
import { IDENTITY_MAT4 } from '../math/constants';
import { isEntityDisabledInHierarchyCached } from '../ecs/utils/hierarchy';
import type { EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';
import { getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import { beginRenderCommandPass } from '../core/RenderCommandContext';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import { requiredItemAt } from '../math/arrayAccess';
import type { PipelineWarmupPlan } from '../renderer/PipelineWarmup';
import { getRenderViewPassOptions } from '../core/RenderView';
import { cloneRenderPassDescriptor } from '../core/renderPassDescriptor';

export interface BitmapTextRenderSystemOptions {
  reverseZ?: boolean;
  msaaSamples?: 1 | 4;
  viewport?: ViewportRect | null;
  scissor?:  ScissorRect  | null;
  loadOp?: 'clear' | 'load';
}

export class BitmapTextRenderSystem extends System {
  private engine: IEngine;
  private cameraEntity: Entity;
  private renderer: BitmapTextRenderer;
  private _prepared = false;
  private readonly _viewMatrix = mat4.identity() as Float32Array;
  private readonly _viewProjMatrix = mat4.identity() as Float32Array;
  private readonly _liveEntities = new Set<number>();
  private readonly _liveFonts = new Set<number>();
  private readonly _disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  private readonly _worldMatrixCache = new Map<Entity, Transform3D | null>();

  reverseZ: boolean;
  msaaSamples: 1 | 4;
  viewport: ViewportRect | null;
  scissor:  ScissorRect  | null;
  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource = { kind: 'render-system' as const, system: 'BitmapTextRenderSystem' as const };
  private readonly unregisterRecovery: (() => void) | null;

  constructor(
    engine: IEngine,
    cameraEntity: Entity,
    options: BitmapTextRenderSystemOptions = {},
  ) {
    super({ all: [BitmapText] });
    this.engine      = engine;
    this.cameraEntity = cameraEntity;
    this.reverseZ    = options.reverseZ    ?? engine.reverseZ;
    this.msaaSamples = options.msaaSamples ?? engine.msaaSamples;
    this.viewport    = options.viewport    ?? null;
    this.scissor     = options.scissor     ?? null;
    this.loadOp      = options.loadOp      ?? 'load';
    this.renderer    = new BitmapTextRenderer();
    this.name        = 'BitmapTextRenderSystem';
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
    this._liveFonts.clear();
    this._worldMatrixCache.clear();

    const reverseZ = context.view?.reverseZ ?? this.reverseZ;
    this.renderer.reverseZ    = reverseZ;
    this.renderer.msaaSamples = context.view?.sampleCount ?? this.msaaSamples;

    const cameraEntity = context.view?.camera.getComponent(Camera3D) ? context.view.camera : this.cameraEntity;
    const camera = cameraEntity.getComponent(Camera3D);
    if (!camera) return this;

    const vpW = context.view?.width ?? this.viewport?.width ?? this.engine.width;
    const vpH = context.view?.height ?? this.viewport?.height ?? this.engine.height;
    const frameData = context.frameData ?? world.frameData;
    const cameraFrame = frameData.getCamera3D(cameraEntity, camera, vpW, vpH, reverseZ);
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
      const colorAtt = requiredItemAt(
        context.descriptor.colorAttachments as GPURenderPassColorAttachment[],
        0,
        'BitmapText color attachments',
      );
      colorAtt.storeOp = 'store';
    }
    const { passEncoder, ownsPass } = beginRenderCommandPass(context);

    const viewport = context.view?.viewport ?? this.viewport;
    const scissor = context.view?.scissor ?? this.scissor;
    if (viewport) {
      const vp = viewport;
      passEncoder.setViewport(vp.x, vp.y, vp.width, vp.height, vp.minDepth ?? 0, vp.maxDepth ?? 1);
    }
    if (scissor) {
      const s = scissor;
      passEncoder.setScissorRect(s.x, s.y, s.width, s.height);
    }

    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledHierarchyCache)) continue;
      updateEntityWorldMatrix(entity, this._worldMatrixCache);
      const text = entity.getComponent(BitmapText);
      if (!text) continue;
      const transform  = entity.getComponent(Transform3D);
      const worldMatrix = transform ? transform.worldMatrix : IDENTITY_MAT4;
      this._liveEntities.add(entity.id);
      this._liveFonts.add(text.font.id);
      this.renderer.render(passEncoder, entity.id, text, worldMatrix);
    }

    if (ownsPass) passEncoder.end();
    this.renderer.releaseEntitiesNotIn(this._liveEntities);
    this.renderer.releaseFontsNotIn(this._liveFonts);
    return this;
  }

  suspendForDeviceLoss(): void {
    this.renderer.destroy();
    this._prepared = false;
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.renderer = new BitmapTextRenderer();
    this._prepared = false;
  }

  override destroy(): this {
    this.unregisterRecovery?.();
    this.suspendForDeviceLoss();
    return super.destroy();
  }

}
