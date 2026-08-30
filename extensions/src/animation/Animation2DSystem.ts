import { System, type Entity, type World } from '@haiyue/engine';
import type { AssetManager } from '@haiyue/engine/assets';
import { Animation2DComponent } from './Animation2DComponent';
import { Animation2DRuntime } from './Animation2DRuntime';

export interface Animation2DSystemOptions {
  priority?: number;
  /** Shared engine asset manager used by sprite2d resources. */
  assetManager?: AssetManager;
}

export class Animation2DSystem extends System {
  private readonly _assetManager: AssetManager | undefined;

  constructor(options: Animation2DSystemOptions = {}) {
    super({ all: [Animation2DComponent] });
    this.name = 'Animation2DSystem';
    if (options.priority !== undefined) this.priority = options.priority;
    this._assetManager = options.assetManager;
  }

  override update(world: World, _time: number, delta: number): this {
    if (this.disabled) return this;
    const entities = this.entitySet.get(world);
    if (!entities) return this;
    for (const entity of entities) this._updateEntity(entity, delta);
    return this;
  }

  override destroy(): this {
    for (const world of this.usedBy) {
      const entities = this.entitySet.get(world);
      if (!entities) continue;
      for (const entity of entities) entity.getComponent(Animation2DComponent)?._disposeRuntime();
    }
    return super.destroy();
  }

  private _updateEntity(entity: Entity, delta: number): void {
    const component = entity.getComponent(Animation2DComponent);
    if (!component) return;
    if (component.disabled) {
      component._disposeRuntime();
      return;
    }
    if (component.completed && component.animation.endBehavior === 'destroy' && !component.playing) return;
    component._runtime ??= new Animation2DRuntime(entity, component.animation, component.runtimeExtensions, this._assetManager, component._nodeOverrides);
    if (component.playing && delta > 0 && component.speed > 0) {
      component.currentTime += delta * 0.001 * component.speed;
      if (component.currentTime >= component.animation.duration) {
        if (component.loop) {
          component.currentTime %= component.animation.duration;
          component._forceParticleSeek = true;
        } else {
          component.currentTime = component.animation.duration;
          component.playing = false;
          component.completed = true;
          if (component.animation.endBehavior === 'destroy') {
            component._disposeRuntime();
            component._needsApply = false;
            return;
          }
        }
      }
      component._needsApply = true;
    }
    if (!component._needsApply) return;
    component._runtime.apply(component.currentTime, component.playing, component.speed, component._forceParticleSeek);
    component._needsApply = false;
    component._forceParticleSeek = false;
  }
}
