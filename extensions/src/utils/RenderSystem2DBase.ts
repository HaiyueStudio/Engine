import {
  type EntityHierarchyDisabledCache,
  type FrameData,
  type IEngine,
  type RenderCommandContext,
  isEntityDisabledInHierarchyCached,
  getExtensionGPUResourceTracker,
  requireEngineDevice,
} from '@haiyue/engine/extension-authoring';
import { Camera2D } from '@haiyue/engine/components';
import { Entity, System, type SystemQuery, type World } from '@haiyue/engine/ecs';
import { compute2DViewProjection, write2DCameraBuffer } from './camera2d';
import { createObject2DGpu, destroyObject2DGpu, type Object2DGpu } from './render2dGpu';

export interface RenderSystem2DBaseOptions {
  loadOp?: 'clear' | 'load';
  priority?: number;
}

export abstract class RenderSystem2DBase extends System {
  protected readonly engine: IEngine;
  protected cameraEntity: Entity;
  protected readonly disabledHierarchyCache: EntityHierarchyDisabledCache = new Map();
  protected readonly liveEntityIds = new Set<number>();

  loadOp: 'clear' | 'load';
  readonly recoveryLabel: string;
  readonly recoverySource: { kind: 'component-render-system'; system: string };
  private readonly unregisterRecovery: (() => void) | null;

  protected constructor(
    rule: SystemQuery,
    engine: IEngine,
    cameraEntity: Entity,
    options: RenderSystem2DBaseOptions = {},
    name?: string,
  ) {
    super(rule);
    this.engine = engine;
    this.cameraEntity = cameraEntity;
    this.loadOp = options.loadOp ?? 'load';
    if (name) this.name = name;
    if (options.priority !== undefined) this.priority = options.priority;
    this.recoveryLabel = `${name ?? this.constructor.name}:${this.id}`;
    this.recoverySource = { kind: 'component-render-system', system: name ?? this.constructor.name };
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this) ?? null;
  }

  setCameraEntity(cameraEntity: Entity): this {
    this.cameraEntity = cameraEntity;
    return this;
  }

  protected getCamera2D(context?: RenderCommandContext): Camera2D | null {
    return this.getCameraEntity(context).getComponent(Camera2D);
  }

  protected getFrameData(context: RenderCommandContext): FrameData {
    const cameraEntity = this.getCameraEntity(context);
    const frameData = context.frameData ?? cameraEntity.world?.frameData;
    if (!frameData) throw new Error(`${this.name} requires frame data from its render context or camera usage.`);
    return frameData;
  }

  protected computeCameraViewProjection(camera: Camera2D, context?: RenderCommandContext): Float32Array {
    if (context) {
      return this.getFrameData(context).getCamera2D(
        this.getCameraEntity(context),
        camera,
        context.view?.displayWidth ?? this.engine.displayWidth,
        context.view?.displayHeight ?? this.engine.displayHeight,
      ).viewProjectionMatrix;
    }
    return compute2DViewProjection(this.engine, this.cameraEntity, camera);
  }

  protected writeCameraBuffer(queue: GPUQueue, buffer: GPUBuffer, context?: RenderCommandContext): boolean {
    const camera = this.getCamera2D(context);
    if (!camera) return false;
    write2DCameraBuffer(queue, buffer, this.computeCameraViewProjection(camera, context));
    return true;
  }

  protected getWorldMatrix2D(entity: Entity, context: RenderCommandContext): Float32Array {
    return this.getFrameData(context).getWorldMatrix2D(entity);
  }

  private getCameraEntity(context?: RenderCommandContext): Entity {
    return context?.view?.camera.getComponent(Camera2D) ? context.view.camera : this.cameraEntity;
  }

  protected isEntityRenderable(entity: Entity): boolean {
    return !isEntityDisabledInHierarchyCached(entity, this.disabledHierarchyCache);
  }

  protected beginLiveEntityTracking(): Set<number> {
    this.liveEntityIds.clear();
    this.disabledHierarchyCache.clear();
    return this.liveEntityIds;
  }

  protected markEntityLive(entity: Entity | number): void {
    this.liveEntityIds.add(typeof entity === 'number' ? entity : entity.id);
  }

  protected createObjectGpu(layout: GPUBindGroupLayout): Object2DGpu {
    return createObject2DGpu(requireEngineDevice(this.engine), layout, getExtensionGPUResourceTracker(this.engine));
  }

  protected destroyObjectGpu(objectGpu: Object2DGpu): void {
    destroyObject2DGpu(objectGpu);
  }

  protected getOrCreateEntityGpu<T>(
    cache: Map<number, T>,
    entity: Entity,
    create: () => T,
  ): T {
    let gpu = cache.get(entity.id);
    if (!gpu) {
      gpu = create();
      cache.set(entity.id, gpu);
    }
    return gpu;
  }

  protected releaseEntityGpuEntriesNotIn<T>(
    cache: Map<number, T>,
    destroy: (gpu: T) => void,
    liveEntities: ReadonlySet<number> = this.liveEntityIds,
  ): void {
    for (const [entityId, gpu] of cache) {
      if (!liveEntities.has(entityId)) {
        destroy(gpu);
        cache.delete(entityId);
      }
    }
  }

  protected destroyEntityGpuEntries<T>(
    cache: Map<number, T>,
    destroy: (gpu: T) => void,
  ): void {
    for (const gpu of cache.values()) destroy(gpu);
    cache.clear();
  }

  suspendForDeviceLoss(): void {
    this.releaseGpuResourcesForRecovery();
  }

  recoverGpuResource(_device: GPUDevice, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    this.restoreGpuResourcesAfterRecovery();
  }

  override destroy(): this {
    this.unregisterRecovery?.();
    return super.destroy();
  }

  protected abstract releaseGpuResourcesForRecovery(): void;
  protected restoreGpuResourcesAfterRecovery(): void {}
}
