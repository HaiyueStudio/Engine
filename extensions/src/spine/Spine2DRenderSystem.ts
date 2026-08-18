import {
  beginRenderCommandPass,
  type IEngine,
  type RenderCommandContext,
  type RenderPipelineEntryOptions,
} from '@haiyue/engine/extension-authoring';
import { Entity, type World } from '@haiyue/engine/ecs';
import { Spine2DComponent } from './Spine2DComponent';
import { Spine2DGpuRenderer } from './Spine2DGpuRenderer';
import { advanceSpineRuntime, buildSpineVertices, loadSpineRuntime, type SpineRuntime } from './Spine2DRuntime';
import type { SpineAssetWorker } from './SpineAssetWorkerContract';
import { RenderSystem2DBase, type RenderSystem2DBaseOptions } from '../utils/RenderSystem2DBase';
import {
  writeObjectMatrixIfChanged,
  type Object2DGpu,
} from '../utils/render2dGpu';

export interface Spine2DRenderSystemOptions extends RenderSystem2DBaseOptions {
  assetWorker?: SpineAssetWorker | null;
}

interface EntityGpu {
  objectGpu: Object2DGpu;
}

export class Spine2DRenderSystem extends RenderSystem2DBase {
  private gpuRenderer = new Spine2DGpuRenderer();
  private runtimes = new Map<Spine2DComponent, SpineRuntime>();
  private entityGpu = new Map<number, EntityGpu>();
  private readonly liveComponents = new Set<Spine2DComponent>();
  private readonly pendingLoads = new Map<Spine2DComponent, { key: string; controller: AbortController }>();
  private readonly assetWorker: SpineAssetWorker | null;
  private disposed = false;

  get renderPipelineOptions(): RenderPipelineEntryOptions {
    return {
      pass: 'shared',
      loadOp: this.loadOp,
      recordMode: 'delta',
      sort: this.priority,
    };
  }

  constructor(
    engine: IEngine,
    cameraEntity: Entity,
    options: Spine2DRenderSystemOptions = {},
  ) {
    super({ all: [Spine2DComponent] }, engine, cameraEntity, options, 'Spine2DRenderSystem');
    this.assetWorker = options.assetWorker ?? null;
  }

  record(world: World, delta: number, context: RenderCommandContext): this {
    if (this.disabled || !this.engine.device) return this;
    this.gpuRenderer.prepare(this.engine);
    this.gpuRenderer.setRenderView(
      context.view?.reverseZ ?? this.engine.reverseZ,
      context.view?.sampleCount ?? this.engine.msaaSamples,
    );
    const liveEntities = this.beginLiveEntityTracking();
    this.liveComponents.clear();
    if (!this.writeCameraBuffer(this.engine.device.queue, this.gpuRenderer.cameraBuffer, context)) return this;

    const { passEncoder: pass, ownsPass } = beginRenderCommandPass(context);

    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (!this.isEntityRenderable(entity)) continue;
      const component = entity.getComponent(Spine2DComponent);
      if (!component || !component.jsonUrl) continue;
      this.liveComponents.add(component);
      this.ensureRuntime(component);
      const runtime = this.runtimes.get(component);
      if (!runtime || component.status !== 'loaded') continue;
      advanceSpineRuntime(component, delta);
      const {
        vertices,
        debugVertices,
        vertexDirtyRanges,
        debugDirtyRanges,
        verticesChanged,
        debugVerticesChanged,
      } = buildSpineVertices(component, runtime);
      if (vertices.length === 0) continue;
      if (verticesChanged) this.gpuRenderer.writeVertices(runtime, vertices, vertexDirtyRanges);
      const gpu = this.getEntityGpu(entity);
      this.markEntityLive(entity);
      const worldMatrix = this.getWorldMatrix2D(entity, context);
      writeObjectMatrixIfChanged(this.engine.device.queue, gpu.objectGpu, worldMatrix);
      if (debugVertices.length > 0) {
        if (debugVerticesChanged) this.gpuRenderer.writeDebugVertices(runtime, debugVertices, debugDirtyRanges);
      }
      this.gpuRenderer.drawRuntime(pass, runtime, gpu.objectGpu.bindGroup, debugVertices.length / 8);
    }

    if (ownsPass) pass.end();
    this.releaseEntityGpuEntriesNotIn(this.entityGpu, gpu => this.destroyEntityGpu(gpu), liveEntities);
    this.releaseRuntimesNotIn(this.liveComponents);
    return this;
  }

  override destroy(): this {
    this.disposed = true;
    for (const pending of this.pendingLoads.values()) pending.controller.abort('system-destroyed');
    this.pendingLoads.clear();
    this.releaseGpuResourcesForRecovery();
    return super.destroy();
  }

  protected releaseGpuResourcesForRecovery(): void {
    for (const pending of this.pendingLoads.values()) pending.controller.abort('device-lost');
    this.pendingLoads.clear();
    this.destroyEntityGpuEntries(this.entityGpu, gpu => this.destroyEntityGpu(gpu));
    for (const [component, runtime] of this.runtimes) {
      this.destroyRuntime(runtime);
      component.runtimeKey = '';
      component.loadingKey = '';
    }
    this.runtimes.clear();
    this.gpuRenderer.destroy();
  }

  protected override restoreGpuResourcesAfterRecovery(): void {
    this.gpuRenderer = new Spine2DGpuRenderer();
    this.disposed = false;
  }

  private getEntityGpu(entity: Entity): EntityGpu {
    return this.getOrCreateEntityGpu(this.entityGpu, entity, () => ({
      objectGpu: this.createObjectGpu(this.gpuRenderer.objectLayout),
    }));
  }

  private releaseRuntimesNotIn(liveComponents: ReadonlySet<Spine2DComponent>): void {
    for (const [component, pending] of this.pendingLoads) {
      if (liveComponents.has(component)) continue;
      pending.controller.abort('component-removed');
      this.pendingLoads.delete(component);
      component.loadingKey = '';
    }
    for (const [component, runtime] of this.runtimes) {
      if (!liveComponents.has(component)) {
        this.destroyRuntime(runtime);
        this.runtimes.delete(component);
        component.runtimeKey = '';
      }
    }
  }

  private destroyEntityGpu(gpu: EntityGpu): void {
    this.destroyObjectGpu(gpu.objectGpu);
  }

  private destroyRuntime(runtime: SpineRuntime): void {
    this.gpuRenderer.destroyRuntime(runtime);
  }

  private ensureRuntime(component: Spine2DComponent): void {
    const key = component.sourceKey;
    if (component.runtimeKey === key || component.loadingKey === key) return;
    const previousPending = this.pendingLoads.get(component);
    previousPending?.controller.abort('source-changed');
    this.pendingLoads.delete(component);
    const previous = this.runtimes.get(component);
    if (previous) {
      this.destroyRuntime(previous);
      this.runtimes.delete(component);
      component.runtimeKey = '';
    }
    component.status = 'loading';
    component.error = null;
    component.loadingKey = key;
    const controller = new AbortController();
    const pending = { key, controller };
    this.pendingLoads.set(component, pending);
    void loadSpineRuntime(this.gpuRenderer, component, { assetWorker: this.assetWorker, signal: controller.signal })
      .then((runtime) => {
        if (this.disposed || component.loadingKey !== key) {
          this.destroyRuntime(runtime);
          return;
        }
        this.runtimes.set(component, runtime);
        component.runtimeKey = key;
        component.status = 'loaded';
        component.elapsed = 0;
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        component.status = 'error';
        component.error = error instanceof Error ? error.message : String(error);
        console.warn(`[Spine2DRenderSystem] ${component.error}`);
      })
      .finally(() => {
        if (this.pendingLoads.get(component) === pending) this.pendingLoads.delete(component);
        if (component.loadingKey === key) component.loadingKey = '';
      });
  }

}
