import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { ParticleEmitter3D } from '../components/ParticleEmitter3D';
import { isEntityDisabledInHierarchyCached, type EntityHierarchyDisabledCache } from '../ecs/utils/hierarchy';

export interface Particle3DSystemOptions {
  priority?: number;
  /** Prevents a suspended tab from advancing an unbounded simulation step. Default 0.25 seconds. */
  maxDeltaSeconds?: number;
}

export class Particle3DSystem extends System {
  readonly maxDeltaSeconds: number;
  private readonly _disabledCache: EntityHierarchyDisabledCache = new Map();

  constructor(options: Particle3DSystemOptions = {}) {
    super({ all: [ParticleEmitter3D] });
    this.name = 'Particle3DSystem';
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
      entity.getComponent(ParticleEmitter3D)?.advance(seconds);
    }
    return this;
  }
}
