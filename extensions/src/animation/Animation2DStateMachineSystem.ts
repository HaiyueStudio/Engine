import { System, type Entity, type World } from '@haiyue/engine';
import type { AssetManager } from '@haiyue/engine/assets';
import { Animation2DStateMachineComponent } from './Animation2DStateMachineComponent.js';
import { Animation2DStateMachineRuntime } from './Animation2DStateMachineRuntime.js';

export interface Animation2DStateMachineSystemOptions {
  priority?: number;
  /** Shared engine asset manager used by sprite2d resources. */
  assetManager?: AssetManager;
}

export class Animation2DStateMachineSystem extends System {
  private readonly _assetManager: AssetManager | undefined;

  constructor(options: Animation2DStateMachineSystemOptions = {}) {
    super({ all: [Animation2DStateMachineComponent] });
    this.name = 'Animation2DStateMachineSystem';
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
      for (const entity of entities) {
        entity.getComponent(Animation2DStateMachineComponent)?._disposeRuntime();
      }
    }
    return super.destroy();
  }

  private _updateEntity(entity: Entity, delta: number): void {
    const component = entity.getComponent(Animation2DStateMachineComponent);
    if (!component) return;
    if (component.disabled) {
      component._disposeRuntime();
      return;
    }
    component._runtime ??= new Animation2DStateMachineRuntime(
      entity,
      component.animation,
      component.stateMachineExtension,
      component._getParameterValues(),
      component.runtimeExtensions,
      this._assetManager,
    );
    if ((!component.playing || component.speed === 0) && !component._needsUpdate) return;
    component._runtime.update(Math.max(0, delta) * 0.001, component.playing, component.speed);
    component._needsUpdate = false;
  }
}
