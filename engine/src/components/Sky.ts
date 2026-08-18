import { Component, ComponentLifecycleFlags, UniqueCheckType } from '../ecs/Component';
import type { Entity } from '../ecs/Entity';
import type { World } from '../ecs/World';

export interface SkyOptions {
  /** Atmospheric haze amount, matching the Three.js Sky parameter name. */
  turbidity?: number;
  /** Rayleigh scattering strength. */
  rayleigh?: number;
  /** Mie scattering coefficient for the sun halo. */
  mieCoefficient?: number;
  /** Mie directional anisotropy, clamped in the shader. */
  mieDirectionalG?: number;
  /** World-space sun direction or position. The renderer normalizes it. */
  sunPosition?: [number, number, number];
  /** Simple exposure multiplier before tone mapping. */
  exposure?: number;
}

const skyEntitiesByWorld = new WeakMap<World, Set<Entity>>();

export function getSkyEntityCandidates(world: World): ReadonlySet<Entity> | null {
  return skyEntitiesByWorld.get(world) ?? null;
}

function registerSkyEntity(world: World, entity: Entity): void {
  let entities = skyEntitiesByWorld.get(world);
  if (!entities) {
    entities = new Set();
    skyEntitiesByWorld.set(world, entities);
  }
  entities.add(entity);
}

function unregisterSkyEntity(world: World, entity: Entity): void {
  const entities = skyEntitiesByWorld.get(world);
  if (!entities) return;
  entities.delete(entity);
  if (entities.size === 0) skyEntitiesByWorld.delete(world);
}

export class Sky extends Component {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Sky');
  static override Lifecycle =
    ComponentLifecycleFlags.EntityAddComponent |
    ComponentLifecycleFlags.EntityRemoveComponent |
    ComponentLifecycleFlags.EntityAddToWorld |
    ComponentLifecycleFlags.EntityRemoveFromWorld;

  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunPosition: [number, number, number];
  exposure: number;

  constructor(options: SkyOptions = {}) {
    super('Sky');
    this.turbidity       = options.turbidity       ?? 10;
    this.rayleigh        = options.rayleigh        ?? 3;
    this.mieCoefficient  = options.mieCoefficient  ?? 0.005;
    this.mieDirectionalG = options.mieDirectionalG ?? 0.7;
    this.sunPosition     = options.sunPosition     ?? [0, 1, 0];
    this.exposure        = options.exposure        ?? 1;
  }

  setSunPosition(x: number, y: number, z: number): this {
    this.sunPosition = [x, y, z];
    return this;
  }

  onEntityAddToWorld(entity: Entity, world: World): void {
    if (entity.getComponent(Sky) === this) registerSkyEntity(world, entity);
  }

  onEntityRemoveFromWorld(entity: Entity, world: World): void {
    unregisterSkyEntity(world, entity);
  }

  onEntityAddComponent(entity: Entity, component: Component): void {
    if (component !== this) return;
    for (const world of entity.usedBy) registerSkyEntity(world, entity);
  }

  onEntityRemoveComponent(entity: Entity, component: Component): void {
    if (component !== this) return;
    for (const world of entity.usedBy) unregisterSkyEntity(world, entity);
  }
}
