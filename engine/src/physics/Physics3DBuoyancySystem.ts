import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import type { MutablePhysics3DBodyTransform } from './Physics3DBackend';
import { Physics3DBody } from './Physics3DBody';
import { Physics3DBuoyancy } from './Physics3DBuoyancy';
import { Physics3DSystem } from './Physics3DSystem';

export interface Physics3DBuoyancySystemOptions {
  priority?: number;
}

/**
 * Applies Archimedes-style lift and fluid drag through the generic force API.
 * It has no dependency on Rapier or any other concrete backend.
 */
export class Physics3DBuoyancySystem extends System {
  private readonly transformScratch: MutablePhysics3DBodyTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  private readonly linearVelocity = { x: 0, y: 0, z: 0 };
  private readonly angularVelocity = { x: 0, y: 0, z: 0 };

  constructor(
    readonly physics: Physics3DSystem,
    options: Physics3DBuoyancySystemOptions = {},
  ) {
    super({ all: [Physics3DBody, Physics3DBuoyancy] });
    this.name = 'Physics3DBuoyancySystem';
    this.priority = options.priority ?? physics.priority - 1;
  }

  override update(world: World, _time: number, _delta: number): this {
    if (this.disabled) return this;
    const entities = this.entitySet.get(world);
    if (!entities) return this;
    const gravity = this.physics.gravity;
    const gravityMagnitude = Math.hypot(gravity[0], gravity[1], gravity[2]);

    for (const entity of entities) {
      const body = entity.getComponent(Physics3DBody);
      const buoyancy = entity.getComponent(Physics3DBuoyancy);
      if (
        !body
        || !buoyancy
        || body.type !== 'dynamic'
        || !this.physics.getBodyTransform(body, this.transformScratch)
      ) continue;

      const height = Math.max(0.0001, buoyancy.bodyHeight ?? colliderHeight(body));
      const bottom = this.transformScratch.position.y - height * 0.5;
      const submerged = clamp01((buoyancy.fluidLevel - bottom) / height);
      if (submerged <= 0) continue;

      const volume = Math.max(0, buoyancy.volume ?? colliderVolume(body));
      const inverseGravity = gravityMagnitude > 0 ? 1 / gravityMagnitude : 0;
      let forceX = -gravity[0] * inverseGravity * buoyancy.fluidDensity * volume * gravityMagnitude * submerged;
      let forceY = -gravity[1] * inverseGravity * buoyancy.fluidDensity * volume * gravityMagnitude * submerged;
      let forceZ = -gravity[2] * inverseGravity * buoyancy.fluidDensity * volume * gravityMagnitude * submerged;

      if (this.physics.getLinearVelocity(body, this.linearVelocity)) {
        forceX -= this.linearVelocity.x * buoyancy.linearDrag * submerged;
        forceY -= this.linearVelocity.y * buoyancy.linearDrag * submerged;
        forceZ -= this.linearVelocity.z * buoyancy.linearDrag * submerged;
      }

      const offset = rotateVector(this.transformScratch.rotation, buoyancy.centerOfBuoyancy);
      this.physics.applyForceAtPoint(
        body,
        [forceX, forceY, forceZ],
        [
          this.transformScratch.position.x + offset[0],
          this.transformScratch.position.y + offset[1],
          this.transformScratch.position.z + offset[2],
        ],
      );

      if (this.physics.getAngularVelocity(body, this.angularVelocity)) {
        this.physics.applyTorque(
          body,
          -this.angularVelocity.x * buoyancy.angularDrag * submerged,
          -this.angularVelocity.y * buoyancy.angularDrag * submerged,
          -this.angularVelocity.z * buoyancy.angularDrag * submerged,
        );
      }
    }
    return this;
  }
}

function colliderHeight(body: Physics3DBody): number {
  if (body.shape === 'sphere') return body.radius * 2;
  if (body.shape === 'capsule') return body.halfHeight * 2 + body.radius * 2;
  if (body.shape === 'cylinder') return body.halfHeight * 2;
  return body.height;
}

function colliderVolume(body: Physics3DBody): number {
  if (body.shape === 'sphere') return 4 / 3 * Math.PI * body.radius ** 3;
  if (body.shape === 'capsule') {
    return Math.PI * body.radius ** 2 * body.halfHeight * 2 + 4 / 3 * Math.PI * body.radius ** 3;
  }
  if (body.shape === 'cylinder') return Math.PI * body.radius ** 2 * body.halfHeight * 2;
  return body.width * body.height * body.depth;
}

function rotateVector(
  rotation: { x: number; y: number; z: number; w: number },
  value: readonly [number, number, number],
): [number, number, number] {
  const tx = 2 * (rotation.y * value[2] - rotation.z * value[1]);
  const ty = 2 * (rotation.z * value[0] - rotation.x * value[2]);
  const tz = 2 * (rotation.x * value[1] - rotation.y * value[0]);
  return [
    value[0] + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    value[1] + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    value[2] + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
