import { Transform3D } from '../components/Transform3D';
import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import type { MutablePhysics3DBodyTransform } from './Physics3DBackend';
import { Physics3DBody } from './Physics3DBody';
import { Physics3DGravitySource } from './Physics3DGravitySource';
import { Physics3DSystem } from './Physics3DSystem';

export interface Physics3DGravitySystemOptions {
  priority?: number;
}

/** Applies inverse-square point gravity through Physics3DSystem's generic force API. */
export class Physics3DGravitySystem extends System {
  private readonly sourceTransform: MutablePhysics3DBodyTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  private readonly bodyTransform: MutablePhysics3DBodyTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };

  constructor(
    readonly physics: Physics3DSystem,
    options: Physics3DGravitySystemOptions = {},
  ) {
    super({ all: [Physics3DGravitySource] });
    this.name = 'Physics3DGravitySystem';
    this.priority = options.priority ?? physics.priority - 1;
  }

  override update(world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    const sources = this.entitySet.get(world);
    if (!sources) return this;

    for (const sourceEntity of sources) {
      const source = sourceEntity.getComponent(Physics3DGravitySource);
      if (!source || !this.readPosition(sourceEntity, this.sourceTransform)) continue;
      for (const targetEntity of world.iterQueryCandidates({ all: [Physics3DBody] })) {
        if (targetEntity === sourceEntity || targetEntity.disabled) continue;
        const body = targetEntity.getComponent(Physics3DBody);
        if (
          !body
          || body.type !== 'dynamic'
          || !this.physics.getBodyTransform(body, this.bodyTransform)
        ) continue;
        const dx = this.sourceTransform.position.x - this.bodyTransform.position.x;
        const dy = this.sourceTransform.position.y - this.bodyTransform.position.y;
        const dz = this.sourceTransform.position.z - this.bodyTransform.position.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        const distance = Math.sqrt(distanceSquared);
        if (!(distance > 0) || distance > source.maxDistance) continue;
        const mass = this.physics.getBodyMass(body) ?? 1;
        const forceMagnitude = mass * source.strength
          / (distanceSquared + source.softening * source.softening);
        const inverseDistance = 1 / distance;
        this.physics.applyForce(
          body,
          dx * inverseDistance * forceMagnitude,
          dy * inverseDistance * forceMagnitude,
          dz * inverseDistance * forceMagnitude,
        );
      }
    }
    return this;
  }

  private readPosition(
    entity: import('../ecs/Entity').Entity,
    out: MutablePhysics3DBodyTransform,
  ): boolean {
    const body = entity.getComponent(Physics3DBody);
    if (body && this.physics.getBodyTransform(body, out)) return true;
    const transform = entity.getComponent(Transform3D);
    if (!transform) return false;
    out.position.x = transform.localMatrix[12] ?? 0;
    out.position.y = transform.localMatrix[13] ?? 0;
    out.position.z = transform.localMatrix[14] ?? 0;
    return true;
  }
}
