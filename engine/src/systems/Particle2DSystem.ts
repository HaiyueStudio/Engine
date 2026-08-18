import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { ParticleEmitter2D } from '../components/ParticleEmitter2D';
import { isEntityDisabledInHierarchyCached, type EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';

export interface Particle2DSystemOptions {
  priority?: number;
  /** Prevents a suspended tab from advancing an unbounded simulation step. Default 0.25 seconds. */
  maxDeltaSeconds?: number;
}

export class Particle2DSystem extends System {
  readonly maxDeltaSeconds: number;
  private readonly _disabledCache: EntityHierarchyDisabledCache = new Map();

  constructor(options: Particle2DSystemOptions = {}) {
    super({ all: [ParticleEmitter2D] });
    this.name = 'Particle2DSystem';
    if (options.priority !== undefined) this.priority = options.priority;
    const maxDelta = options.maxDeltaSeconds ?? 0.25;
    if (!Number.isFinite(maxDelta) || maxDelta <= 0) throw new RangeError('maxDeltaSeconds must be positive and finite.');
    this.maxDeltaSeconds = maxDelta;
  }

  override update(world: World, _time: number, delta: number): this {
    if (this.disabled || delta <= 0) return this;
    this._disabledCache.clear();
    const seconds = Math.min(delta * 0.001, this.maxDeltaSeconds);
    const entities = this.entitySet.get(world);
    if (!entities) return this;
    for (const entity of entities) {
      if (isEntityDisabledInHierarchyCached(entity, this._disabledCache)) continue;
      entity.getComponent(ParticleEmitter2D)?.advance(seconds);
    }
    return this;
  }
}
