import type {
  Collider,
  ImpulseJoint,
  JointData,
  RigidBody,
  RigidBodyType,
  World,
} from '@dimforge/rapier3d-compat';
import type {
  MutablePhysics3DBodyTransform,
  MutablePhysics3DVector,
  Physics3DBackend,
  Physics3DBackendBodyDesc,
  Physics3DBackendColliderDesc,
  Physics3DBackendDragDesc,
  Physics3DBackendJointDesc,
  Physics3DBackendWorldOptions,
  Physics3DBodyHandle,
  Physics3DCapabilities,
  Physics3DContactEvent,
  Physics3DDragHandle,
  Physics3DJointHandle,
  Physics3DQuaternionLike,
  Physics3DRayCastDesc,
  Physics3DRayHit,
  Physics3DShapeQueryDesc,
  Physics3DVectorLike,
  Physics3DWorldDriver,
} from './Physics3DBackend';
import type { Physics3DBodyType } from './Physics3DBody';

const RAPIER_3D_CAPABILITIES: Physics3DCapabilities = Object.freeze({
  bodyTypes: Object.freeze(['static', 'dynamic', 'kinematic'] as const),
  shapeTypes: Object.freeze(['box', 'sphere', 'capsule', 'cylinder'] as const),
  jointTypes: Object.freeze(['fixed', 'spherical', 'revolute', 'prismatic', 'spring', 'rope'] as const),
  continuousCollision: true,
  rayCast: true,
  shapeQuery: true,
  contactEvents: true,
  forceAtPoint: true,
  dragConstraint: true,
});

interface JointRecord {
  joint: ImpulseJoint;
  bodyA: Physics3DBodyHandle;
  bodyB: Physics3DBodyHandle;
}

interface DragRecord {
  body: Physics3DBodyHandle;
  localAnchor: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
  stiffness: number;
  damping: number;
  maxForce: number;
}

let initialization: Promise<void> | null = null;
type RapierApi = typeof import('@dimforge/rapier3d-compat').default;
let RAPIER: RapierApi;
const RAPIER_DEPRECATED_WASM_INIT_WARNING =
  'using deprecated parameters for the initialization function; pass a single object instead';

/**
 * Initializes Rapier's inlined WASM module and returns it behind the
 * backend-neutral Physics3DBackend contract.
 */
export async function createRapierPhysics3DBackend(): Promise<Physics3DBackend> {
  initialization ??= (async () => {
    const module = await import('@dimforge/rapier3d-compat');
    RAPIER = module.default;
    await initializeRapierCompat();
  })();
  await initialization;
  return new RapierPhysics3DBackend();
}

function initializeRapierCompat(): Promise<void> {
  // rapier3d-compat 0.19.3 still invokes wasm-bindgen's initializer with the
  // legacy positional input. The warning is emitted synchronously, before the
  // returned initialization promise starts compiling the embedded WASM.
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === RAPIER_DEPRECATED_WASM_INIT_WARNING) return;
    warn.apply(console, args);
  };
  try {
    return RAPIER.init();
  } finally {
    console.warn = warn;
  }
}

class RapierPhysics3DBackend implements Physics3DBackend {
  readonly id = 'rapier3d';
  readonly capabilities = RAPIER_3D_CAPABILITIES;

  createWorld(options: Physics3DBackendWorldOptions): Physics3DWorldDriver {
    return new RapierPhysics3DWorld(options);
  }
}

class RapierPhysics3DWorld implements Physics3DWorldDriver {
  readonly backendId = 'rapier3d';
  readonly capabilities = RAPIER_3D_CAPABILITIES;

  private readonly world: World;
  private readonly bodies = new Map<Physics3DBodyHandle, RigidBody>();
  private readonly bodyAllowSleep = new Map<Physics3DBodyHandle, boolean>();
  private readonly bodyHandlesByNative = new Map<number, Physics3DBodyHandle>();
  private readonly colliders = new Map<Physics3DBodyHandle, Collider>();
  private readonly bodyHandlesByCollider = new Map<number, Physics3DBodyHandle>();
  private readonly joints = new Map<Physics3DJointHandle, JointRecord>();
  private readonly drags = new Map<Physics3DDragHandle, DragRecord>();
  private readonly eventQueue: InstanceType<RapierApi['EventQueue']>;
  private readonly contactEvents: Physics3DContactEvent[] = [];
  private nextBodyHandle = 1;
  private nextJointHandle = 1;
  private nextDragHandle = 1;
  private destroyed = false;

  constructor(options: Physics3DBackendWorldOptions) {
    this.world = new RAPIER.World(copyVector(options.gravity));
    this.eventQueue = new RAPIER.EventQueue(true);
    this.world.numSolverIterations = Math.max(1, Math.floor(options.solverIterations));
  }

  setGravity(x: number, y: number, z: number): void {
    this.world.gravity = { x, y, z };
  }

  createBody(desc: Physics3DBackendBodyDesc): Physics3DBodyHandle {
    this.assertAlive();
    const handle = this.nextBodyHandle++ as Physics3DBodyHandle;
    const definition = rigidBodyDesc(desc.type)
      .setTranslation(desc.position.x, desc.position.y, desc.position.z)
      .setRotation(copyQuaternion(desc.rotation))
      .setLinearDamping(Math.max(0, desc.linearDamping))
      .setAngularDamping(Math.max(0, desc.angularDamping))
      .setGravityScale(desc.gravityScale)
      .setCcdEnabled(desc.ccd)
      .setCanSleep(desc.allowSleep)
      .enabledTranslations(
        !desc.lockTranslations[0],
        !desc.lockTranslations[1],
        !desc.lockTranslations[2],
      )
      .enabledRotations(
        !desc.lockRotations[0],
        !desc.lockRotations[1],
        !desc.lockRotations[2],
      )
      .setUserData(handle);
    const body = this.world.createRigidBody(definition);
    this.bodies.set(handle, body);
    this.bodyAllowSleep.set(handle, desc.allowSleep);
    this.bodyHandlesByNative.set(body.handle, handle);
    return handle;
  }

  hasBody(handle: Physics3DBodyHandle): boolean {
    return this.bodies.get(handle)?.isValid() ?? false;
  }

  updateBody(handle: Physics3DBodyHandle, desc: Physics3DBackendBodyDesc): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    // Rapier only exposes canSleep on RigidBodyDesc. Tell the generic system
    // to recreate the body if that construction-time setting changes.
    if (this.bodyAllowSleep.get(handle) !== desc.allowSleep) return false;
    body.setBodyType(rigidBodyType(desc.type), true);
    body.setLinearDamping(Math.max(0, desc.linearDamping));
    body.setAngularDamping(Math.max(0, desc.angularDamping));
    body.setGravityScale(desc.gravityScale, true);
    body.enableCcd(desc.ccd);
    body.setEnabledTranslations(
      !desc.lockTranslations[0],
      !desc.lockTranslations[1],
      !desc.lockTranslations[2],
      true,
    );
    body.setEnabledRotations(
      !desc.lockRotations[0],
      !desc.lockRotations[1],
      !desc.lockRotations[2],
      true,
    );
    return true;
  }

  destroyBody(handle: Physics3DBodyHandle): void {
    const body = this.bodies.get(handle);
    if (!body) return;
    for (const [jointHandle, record] of this.joints) {
      if (record.bodyA === handle || record.bodyB === handle) this.destroyJoint(jointHandle);
    }
    for (const [dragHandle, record] of this.drags) {
      if (record.body === handle) this.drags.delete(dragHandle);
    }
    const collider = this.colliders.get(handle);
    if (collider) this.bodyHandlesByCollider.delete(collider.handle);
    this.colliders.delete(handle);
    this.bodyHandlesByNative.delete(body.handle);
    this.bodyAllowSleep.delete(handle);
    if (body.isValid()) this.world.removeRigidBody(body);
    this.bodies.delete(handle);
  }

  setBodyCollider(handle: Physics3DBodyHandle, desc: Physics3DBackendColliderDesc): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    const previous = this.colliders.get(handle);
    if (previous?.isValid()) {
      this.bodyHandlesByCollider.delete(previous.handle);
      this.world.removeCollider(previous, true);
    }
    const definition = colliderDesc(desc)
      .setDensity(Math.max(0, desc.density))
      .setFriction(Math.max(0, desc.friction))
      .setRestitution(Math.max(0, Math.min(1, desc.restitution)))
      .setSensor(desc.isSensor)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(interactionGroups(desc.categoryBits, desc.maskBits));
    const collider = this.world.createCollider(definition, body);
    this.colliders.set(handle, collider);
    this.bodyHandlesByCollider.set(collider.handle, handle);
    return true;
  }

  setBodyTransform(
    handle: Physics3DBodyHandle,
    position: Physics3DVectorLike,
    rotation: Physics3DQuaternionLike,
    wake: boolean,
    kinematic: boolean,
  ): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    if (kinematic && body.isKinematic()) {
      body.setNextKinematicTranslation(copyVector(position));
      body.setNextKinematicRotation(copyQuaternion(rotation));
    } else {
      body.setTranslation(copyVector(position), wake);
      body.setRotation(copyQuaternion(rotation), wake);
    }
    return true;
  }

  getBodyTransform(handle: Physics3DBodyHandle, out: MutablePhysics3DBodyTransform): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    writeVector(out.position, body.translation());
    writeQuaternion(out.rotation, body.rotation());
    return true;
  }

  getBodyLinearVelocity(handle: Physics3DBodyHandle, out: MutablePhysics3DVector): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    writeVector(out, body.linvel());
    return true;
  }

  setBodyLinearVelocity(handle: Physics3DBodyHandle, velocity: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.setLinvel(copyVector(velocity), wake);
    return true;
  }

  getBodyAngularVelocity(handle: Physics3DBodyHandle, out: MutablePhysics3DVector): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    writeVector(out, body.angvel());
    return true;
  }

  setBodyAngularVelocity(handle: Physics3DBodyHandle, velocity: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.setAngvel(copyVector(velocity), wake);
    return true;
  }

  getBodyMass(handle: Physics3DBodyHandle): number | null {
    const body = this.bodies.get(handle);
    return body?.isValid() ? body.mass() : null;
  }

  setBodyAwake(handle: Physics3DBodyHandle, awake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    if (awake) body.wakeUp();
    else body.sleep();
    return true;
  }

  applyBodyForce(handle: Physics3DBodyHandle, force: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.addForce(copyVector(force), wake);
    return true;
  }

  applyBodyForceAtPoint(
    handle: Physics3DBodyHandle,
    force: Physics3DVectorLike,
    point: Physics3DVectorLike,
    wake: boolean,
  ): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.addForceAtPoint(copyVector(force), copyVector(point), wake);
    return true;
  }

  applyBodyTorque(handle: Physics3DBodyHandle, torque: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.addTorque(copyVector(torque), wake);
    return true;
  }

  applyBodyLinearImpulse(handle: Physics3DBodyHandle, impulse: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.applyImpulse(copyVector(impulse), wake);
    return true;
  }

  applyBodyAngularImpulse(handle: Physics3DBodyHandle, impulse: Physics3DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body?.isValid()) return false;
    body.applyTorqueImpulse(copyVector(impulse), wake);
    return true;
  }

  castRay(desc: Physics3DRayCastDesc): Physics3DRayHit | null {
    const length = Math.hypot(desc.direction.x, desc.direction.y, desc.direction.z);
    if (!(length > 0) || !(desc.maxDistance > 0)) return null;
    const direction = {
      x: desc.direction.x / length,
      y: desc.direction.y / length,
      z: desc.direction.z / length,
    };
    const ray = new RAPIER.Ray(copyVector(desc.origin), direction);
    const groups = desc.categoryBits === undefined && desc.maskBits === undefined
      ? undefined
      : interactionGroups(desc.categoryBits ?? 0xffff, desc.maskBits ?? 0xffff);
    const hit = this.world.castRayAndGetNormal(
      ray,
      desc.maxDistance,
      desc.solid,
      undefined,
      groups,
    );
    const parent = hit?.collider.parent();
    const body = parent ? this.bodyHandlesByNative.get(parent.handle) : undefined;
    if (!hit || body === undefined) return null;
    const distance = hit.timeOfImpact;
    return {
      body,
      distance,
      point: {
        x: desc.origin.x + direction.x * distance,
        y: desc.origin.y + direction.y * distance,
        z: desc.origin.z + direction.z * distance,
      },
      normal: copyVector(hit.normal),
    };
  }

  queryShape(desc: Physics3DShapeQueryDesc, visitor: (body: Physics3DBodyHandle) => boolean): void {
    const groups = desc.categoryBits === undefined && desc.maskBits === undefined
      ? undefined
      : interactionGroups(desc.categoryBits ?? 0xffff, desc.maskBits ?? 0xffff);
    const shape = queryShape(desc);
    const visited = new Set<Physics3DBodyHandle>();
    this.world.intersectionsWithShape(copyVector(desc.position), copyQuaternion(desc.rotation), shape, (collider) => {
      const body = this.bodyHandlesByCollider.get(collider.handle);
      if (body === undefined || visited.has(body)) return true;
      visited.add(body);
      return visitor(body);
    }, undefined, groups);
  }

  drainContactEvents(visitor: (event: Physics3DContactEvent) => void): void {
    for (const event of this.contactEvents.splice(0)) visitor(event);
  }

  createJoint(desc: Physics3DBackendJointDesc): Physics3DJointHandle | null {
    const bodyA = this.bodies.get(desc.bodyA);
    const bodyB = this.bodies.get(desc.bodyB);
    if (!bodyA?.isValid() || !bodyB?.isValid()) return null;
    const data = jointData(desc);
    const joint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
    joint.setContactsEnabled(desc.collideConnected);
    if ((desc.type === 'revolute' || desc.type === 'prismatic') && desc.limits) {
      const limited = joint as ImpulseJoint & { setLimits(min: number, max: number): void };
      limited.setLimits(desc.limits[0], desc.limits[1]);
    }
    const handle = this.nextJointHandle++ as Physics3DJointHandle;
    this.joints.set(handle, { joint, bodyA: desc.bodyA, bodyB: desc.bodyB });
    return handle;
  }

  hasJoint(handle: Physics3DJointHandle): boolean {
    return this.joints.get(handle)?.joint.isValid() ?? false;
  }

  destroyJoint(handle: Physics3DJointHandle): void {
    const record = this.joints.get(handle);
    if (!record) return;
    if (record.joint.isValid()) this.world.removeImpulseJoint(record.joint, true);
    this.joints.delete(handle);
  }

  createDragConstraint(desc: Physics3DBackendDragDesc): Physics3DDragHandle | null {
    if (!this.hasBody(desc.body)) return null;
    const handle = this.nextDragHandle++ as Physics3DDragHandle;
    this.drags.set(handle, {
      body: desc.body,
      localAnchor: copyVector(desc.localAnchor),
      target: copyVector(desc.target),
      stiffness: Math.max(0, desc.stiffness),
      damping: Math.max(0, desc.damping),
      maxForce: Math.max(0, desc.maxForce),
    });
    this.setBodyAwake(desc.body, true);
    return handle;
  }

  updateDragConstraint(handle: Physics3DDragHandle, target: Physics3DVectorLike): boolean {
    const drag = this.drags.get(handle);
    if (!drag) return false;
    writeVector(drag.target, target);
    this.setBodyAwake(drag.body, true);
    return true;
  }

  destroyDragConstraint(handle: Physics3DDragHandle): void {
    this.drags.delete(handle);
  }

  step(timeStep: number): void {
    this.applyDragForces();
    this.world.timestep = timeStep;
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((colliderA, colliderB, started) => {
      const bodyA = this.bodyHandlesByCollider.get(colliderA);
      const bodyB = this.bodyHandlesByCollider.get(colliderB);
      if (bodyA === undefined || bodyB === undefined || bodyA === bodyB) return;
      const first = bodyA < bodyB ? bodyA : bodyB;
      const second = bodyA < bodyB ? bodyB : bodyA;
      this.contactEvents.push(Object.freeze({
        bodyA: first,
        bodyB: second,
        started,
        sensor: (this.colliders.get(first)?.isSensor() ?? false) || (this.colliders.get(second)?.isSensor() ?? false),
      }));
    });
    this.resetTransientForces();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.drags.clear();
    for (const handle of [...this.joints.keys()]) this.destroyJoint(handle);
    for (const handle of [...this.bodies.keys()]) this.destroyBody(handle);
    this.world.free();
    this.eventQueue.free();
    this.bodyHandlesByCollider.clear();
    this.contactEvents.length = 0;
    this.destroyed = true;
  }

  private applyDragForces(): void {
    for (const drag of this.drags.values()) {
      const body = this.bodies.get(drag.body);
      if (!body?.isValid()) continue;
      const translation = body.translation();
      const worldOffset = rotateVector(body.rotation(), drag.localAnchor);
      const point = {
        x: translation.x + worldOffset.x,
        y: translation.y + worldOffset.y,
        z: translation.z + worldOffset.z,
      };
      const velocity = body.velocityAtPoint(point);
      let fx = (drag.target.x - point.x) * drag.stiffness - velocity.x * drag.damping;
      let fy = (drag.target.y - point.y) * drag.stiffness - velocity.y * drag.damping;
      let fz = (drag.target.z - point.z) * drag.stiffness - velocity.z * drag.damping;
      const magnitude = Math.hypot(fx, fy, fz);
      if (magnitude > drag.maxForce && magnitude > 0) {
        const scale = drag.maxForce / magnitude;
        fx *= scale;
        fy *= scale;
        fz *= scale;
      }
      body.addForceAtPoint({ x: fx, y: fy, z: fz }, point, true);
    }
  }

  /**
   * Rapier keeps user forces and torques until they are explicitly reset.
   * The backend contract treats applyForce/applyTorque as inputs for the next
   * simulation step, matching the one-step semantics used by the engine's
   * force systems and preventing drag/buoyancy from accumulating forever.
   */
  private resetTransientForces(): void {
    for (const body of this.bodies.values()) {
      if (!body.isValid() || !body.isDynamic()) continue;
      body.resetForces(false);
      body.resetTorques(false);
    }
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Cannot use a destroyed Rapier 3D physics world.');
  }
}

function queryShape(desc: Physics3DShapeQueryDesc): InstanceType<RapierApi['Shape']> {
  if (desc.shape === 'sphere') return new RAPIER.Ball(Math.max(0.0001, desc.radius));
  if (desc.shape === 'capsule') return new RAPIER.Capsule(Math.max(0, desc.halfHeight), Math.max(0.0001, desc.radius));
  if (desc.shape === 'cylinder') return new RAPIER.Cylinder(Math.max(0.0001, desc.halfHeight), Math.max(0.0001, desc.radius));
  return new RAPIER.Cuboid(
    Math.max(0.0001, desc.width * 0.5),
    Math.max(0.0001, desc.height * 0.5),
    Math.max(0.0001, desc.depth * 0.5),
  );
}

function rigidBodyDesc(type: Physics3DBodyType): InstanceType<typeof RAPIER.RigidBodyDesc> {
  if (type === 'dynamic') return RAPIER.RigidBodyDesc.dynamic();
  if (type === 'kinematic') return RAPIER.RigidBodyDesc.kinematicPositionBased();
  return RAPIER.RigidBodyDesc.fixed();
}

function rigidBodyType(type: Physics3DBodyType): RigidBodyType {
  if (type === 'dynamic') return RAPIER.RigidBodyType.Dynamic;
  if (type === 'kinematic') return RAPIER.RigidBodyType.KinematicPositionBased;
  return RAPIER.RigidBodyType.Fixed;
}

function colliderDesc(desc: Physics3DBackendColliderDesc): InstanceType<typeof RAPIER.ColliderDesc> {
  if (desc.shape === 'sphere') return RAPIER.ColliderDesc.ball(Math.max(0.0001, desc.radius));
  if (desc.shape === 'capsule') {
    return RAPIER.ColliderDesc.capsule(Math.max(0, desc.halfHeight), Math.max(0.0001, desc.radius));
  }
  if (desc.shape === 'cylinder') {
    return RAPIER.ColliderDesc.cylinder(Math.max(0.0001, desc.halfHeight), Math.max(0.0001, desc.radius));
  }
  return RAPIER.ColliderDesc.cuboid(
    Math.max(0.0001, desc.width * 0.5),
    Math.max(0.0001, desc.height * 0.5),
    Math.max(0.0001, desc.depth * 0.5),
  );
}

function jointData(desc: Physics3DBackendJointDesc): JointData {
  const anchorA = copyVector(desc.anchorA);
  const anchorB = copyVector(desc.anchorB);
  switch (desc.type) {
    case 'fixed':
      return RAPIER.JointData.fixed(
        anchorA,
        copyQuaternion(desc.frameA),
        anchorB,
        copyQuaternion(desc.frameB),
      );
    case 'spherical':
      return RAPIER.JointData.spherical(anchorA, anchorB);
    case 'revolute':
      return RAPIER.JointData.revolute(anchorA, anchorB, normalized(desc.axis));
    case 'prismatic':
      return RAPIER.JointData.prismatic(anchorA, anchorB, normalized(desc.axis));
    case 'spring':
      return RAPIER.JointData.spring(
        Math.max(0, desc.restLength),
        Math.max(0, desc.stiffness),
        Math.max(0, desc.damping),
        anchorA,
        anchorB,
      );
    case 'rope':
      return RAPIER.JointData.rope(Math.max(0, desc.maxLength), anchorA, anchorB);
  }
}

function interactionGroups(categoryBits: number, maskBits: number): number {
  return (((categoryBits & 0xffff) * 0x10000) + (maskBits & 0xffff)) >>> 0;
}

function normalized(value: Physics3DVectorLike): { x: number; y: number; z: number } {
  const length = Math.hypot(value.x, value.y, value.z);
  if (!(length > 0)) return { x: 1, y: 0, z: 0 };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function copyVector(value: Physics3DVectorLike): { x: number; y: number; z: number } {
  return { x: value.x, y: value.y, z: value.z };
}

function copyQuaternion(value: Physics3DQuaternionLike): { x: number; y: number; z: number; w: number } {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

function writeVector(target: MutablePhysics3DVector, value: Physics3DVectorLike): void {
  target.x = value.x;
  target.y = value.y;
  target.z = value.z;
}

function writeQuaternion(
  target: { x: number; y: number; z: number; w: number },
  value: Physics3DQuaternionLike,
): void {
  target.x = value.x;
  target.y = value.y;
  target.z = value.z;
  target.w = value.w;
}

function rotateVector(
  rotation: Physics3DQuaternionLike,
  vector: Physics3DVectorLike,
): { x: number; y: number; z: number } {
  const tx = 2 * (rotation.y * vector.z - rotation.z * vector.y);
  const ty = 2 * (rotation.z * vector.x - rotation.x * vector.z);
  const tz = 2 * (rotation.x * vector.y - rotation.y * vector.x);
  return {
    x: vector.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: vector.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: vector.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}
