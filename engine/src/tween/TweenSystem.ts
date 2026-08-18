import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { TweenManager } from './TweenManager';

export interface TweenSystemOptions {
  manager?: TweenManager;
  priority?: number;
}

export class TweenSystem extends System {
  readonly manager: TweenManager;

  constructor(options: TweenSystemOptions = {}) {
    super(() => false);
    this.name = 'TweenSystem';
    this.manager = options.manager ?? new TweenManager();
    if (options.priority !== undefined) this.priority = options.priority;
  }

  override update(_world: World, time: number, delta: number): this {
    if (this.disabled) return this;
    this.manager.update(time, delta);
    return this;
  }

  override destroy(): this {
    this.manager.clear();
    return super.destroy();
  }
}
