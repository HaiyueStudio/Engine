import { System } from '../ecs/System';
import { Entity } from '../ecs/Entity';
import { World } from '../ecs/World';
import { CartesianTransform3D } from '../components/CartesianTransform3D';
import { Transform2D } from '../components/Transform2D';
import { Physics2DTo3DTransformSync } from '../components/Physics2DTo3DTransformSync';
import { requiredVec3Array } from '../math/arrayAccess';

export interface Physics2DTo3DTransformSyncSystemOptions {
  priority?: number;
}

export class Physics2DTo3DTransformSyncSystem extends System {
  private readonly positionScratch: [number, number, number] = [0, 0, 0];
  private readonly rotationScratch: [number, number, number] = [0, 0, 0];
  private readonly sourceCache = new WeakMap<Physics2DTo3DTransformSync, {
    sourceEntity: string | number;
    entity: Entity;
  }>();

  constructor(options: Physics2DTo3DTransformSyncSystemOptions = {}) {
    super({ all: [Physics2DTo3DTransformSync, CartesianTransform3D] });
    this.name = 'Physics2DTo3DTransformSyncSystem';
    this.priority = options.priority ?? 0.5;
  }

  override update(world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    const entities = this.entitySet.get(world);
    if (entities) for (const entity of entities) this.syncEntity(world, entity);
    return this;
  }

  private syncEntity(world: World, entity: Entity): void {
    const sync = entity.getComponent(Physics2DTo3DTransformSync);
    const transform3D = entity.getComponent(CartesianTransform3D);
    if (!sync || !transform3D) return;

    const source = this.resolveSource(world, entity, sync);
    const transform2D = source?.getComponent(Transform2D);
    if (!transform2D) return;

    const position = map2DTo3D(transform2D.x, transform2D.y, sync.plane, sync.fixedAxisValue, this.positionScratch);
    transform3D.setPosition(
      position[0] + sync.offset[0],
      position[1] + sync.offset[1],
      position[2] + sync.offset[2],
    );

    if (sync.syncRotation && sync.rotationAxis !== 'none') {
      const rotation = this.rotationScratch;
      const sourceRotation = requiredVec3Array(transform3D.rotation, 'Physics2D-to-3D rotation');
      rotation[0] = sourceRotation[0];
      rotation[1] = sourceRotation[1];
      rotation[2] = sourceRotation[2];
      const angle = transform2D.rotation + sync.rotationOffset;
      if (sync.rotationAxis === 'x') rotation[0] = angle;
      else if (sync.rotationAxis === 'y') rotation[1] = angle;
      else rotation[2] = angle;
      transform3D.setRotation(rotation[0], rotation[1], rotation[2]);
    }
  }

  private resolveSource(world: World, entity: Entity, sync: Physics2DTo3DTransformSync): Entity | null {
    if (sync.sourceEntity instanceof Entity) return sync.sourceEntity;
    if (typeof sync.sourceEntity === 'number' || typeof sync.sourceEntity === 'string') {
      const cached = this.sourceCache.get(sync);
      if (
        cached &&
        cached.sourceEntity === sync.sourceEntity &&
        world.entities.get(cached.entity.id) === cached.entity
      ) {
        return cached.entity;
      }
      const source = world.getEntity(sync.sourceEntity);
      if (source) {
        this.sourceCache.set(sync, { sourceEntity: sync.sourceEntity, entity: source });
        return source;
      }
      this.sourceCache.delete(sync);
    }
    return entity;
  }
}

function map2DTo3D(
  x: number,
  y: number,
  plane: string,
  fixedAxisValue: number,
  out: [number, number, number],
): [number, number, number] {
  if (plane === 'xy') {
    out[0] = x;
    out[1] = y;
    out[2] = fixedAxisValue;
  } else if (plane === 'yz') {
    out[0] = fixedAxisValue;
    out[1] = x;
    out[2] = y;
  } else {
    out[0] = x;
    out[1] = fixedAxisValue;
    out[2] = y;
  }
  return out;
}
