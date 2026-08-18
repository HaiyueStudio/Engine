import {
  beginRenderCommandPass,
  type IEngine,
  type RenderCommandContext,
} from '@haiyue/engine/extension-authoring';
import { Entity, World } from '@haiyue/engine/ecs';
import { Tilemap2DComponent } from './Tilemap2DComponent';
import { Tilemap2DRenderer } from './Tilemap2DRenderer';
import { RenderSystem2DBase, type RenderSystem2DBaseOptions } from '../utils/RenderSystem2DBase';

export type Tilemap2DRenderSystemOptions = RenderSystem2DBaseOptions;

export class Tilemap2DRenderSystem extends RenderSystem2DBase {
  private renderer: Tilemap2DRenderer | null = null;

  constructor(engine: IEngine, cameraEntity: Entity, options: Tilemap2DRenderSystemOptions = {}) {
    super({ all: [Tilemap2DComponent] }, engine, cameraEntity, options, 'Tilemap2DRenderSystem');
  }

  record(world: World, context: RenderCommandContext): this {
    if (this.disabled) return this;
    if (!this.renderer) {
      this.renderer = new Tilemap2DRenderer();
      this.renderer.prepare(this.engine);
    }
    this.renderer.reverseZ = context.view?.reverseZ ?? this.engine.reverseZ;
    this.renderer.msaaSamples = context.view?.sampleCount ?? this.engine.msaaSamples;
    const liveEntities = this.beginLiveEntityTracking();

    const camera = this.getCamera2D(context);
    if (!camera) return this;
    this.renderer.updateCamera(this.computeCameraViewProjection(camera, context));

    const { passEncoder, ownsPass } = beginRenderCommandPass(context);
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) {
      if (!this.isEntityRenderable(entity)) continue;
      const tilemap = entity.getComponent(Tilemap2DComponent);
      if (!tilemap) continue;
      this.renderer!.render(passEncoder, entity.id, tilemap, this.getWorldMatrix2D(entity, context));
      this.markEntityLive(entity);
    }
    if (ownsPass) passEncoder.end();
    this.renderer.releaseEntitiesNotIn(liveEntities);
    return this;
  }

  override destroy(): this {
    this.releaseGpuResourcesForRecovery();
    return super.destroy();
  }

  protected releaseGpuResourcesForRecovery(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }

}
