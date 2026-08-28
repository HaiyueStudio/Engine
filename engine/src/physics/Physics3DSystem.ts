import { Transform3D } from '../components/Transform3D';
import { Entity } from '../ecs/Entity';
import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { requiredItemAt } from '../math/arrayAccess';
import { mat4, quat } from 'wgpu-matrix';
import type {
  MutablePhysics3DBodyTransform,
  MutablePhysics3DVector,
  Physics3DBackend,
  Physics3DBackendBodyDesc,
  Physics3DBackendColliderDesc,
  Physics3DBackendJointDesc,
  Physics3DBodyHandle,
  Physics3DCapabilities,
  Physics3DContactEvent as Physics3DBackendContactEvent,
  Physics3DDragHandle,
  Physics3DJointHandle,
  Physics3DQuaternionLike,
  Physics3DRayCastDesc,
  Physics3DVectorLike,
  Physics3DWorldDriver,
} from './Physics3DBackend';
import { Physics3DBody } from './Physics3DBody';
import { Physics3DJoint } from './Physics3DJoint';
import {
  setPhysics3DBodyHandle,
  setPhysics3DJointHandle,
} from './Physics3DRuntimeHandles';

export interface Physics3DSystemOptions {
  gravity?: readonly [number, number, number];
  fixedTimeStep?: number;
  maxSubSteps?: number;
  solverIterations?: number;
  syncStaticBodiesFromTransform?: boolean;
  priority?: number;
  /** Required: the core 3D system never imports a concrete physics engine. */
  backend: Physics3DBackend;
}

export interface Physics3DDragOptions {
  stiffness?: number;
  damping?: number;
  maxForce?: number;
}

export interface Physics3DRaycastResult {
  entity: Entity;
  body: Physics3DBody;
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
}

export type Physics3DBodyRef = Physics3DBody | Physics3DBodyHandle;

export interface Physics3DContactEvent {
  readonly tick: number;
  readonly phase: 'enter' | 'stay' | 'exit';
  readonly kind: 'collision' | 'trigger';
  readonly entityA: Entity;
  readonly entityB: Entity;
}

export interface Physics3DResourceSnapshot {
  readonly backendId: string;
  readonly bodies: number;
  readonly colliders: number;
  readonly joints: number;
  readonly activeContacts: number;
}

const DEFAULT_GRAVITY: readonly [number, number, number] = [0, -9.81, 0];

export class Physics3DSystem extends System {
  readonly backend: Physics3DBackend;
  readonly capabilities: Physics3DCapabilities;
  fixedTimeStep: number;
  maxSubSteps: number;
  solverIterations: number;
  syncStaticBodiesFromTransform: boolean;

  private readonly physicsWorld: Physics3DWorldDriver;
  private readonly bodyEntities = new Map<Physics3DBody, Entity>();
  private readonly bodyHandles = new Map<Physics3DBody, Physics3DBodyHandle>();
  private readonly bodyHandleEntities = new Map<Physics3DBodyHandle, Entity>();
  private readonly jointEntities = new Map<Physics3DJoint, Entity>();
  private readonly jointHandles = new Map<Physics3DJoint, Physics3DJointHandle>();
  private readonly bodyPropertySignatures = new Map<Physics3DBody, string>();
  private readonly colliderSignatures = new Map<Physics3DBody, string>();
  private readonly jointSignatures = new Map<Physics3DJoint, string>();
  private readonly activeBodies = new Set<Physics3DBody>();
  private readonly activeJoints = new Set<Physics3DJoint>();
  private readonly contactPairs = new Map<string, Readonly<{ entityA: Entity; entityB: Entity; sensor: boolean }>>();
  private contactEvents: readonly Physics3DContactEvent[] = Object.freeze([]);
  private readonly staleBodies: Physics3DBody[] = [];
  private readonly staleJoints: Physics3DJoint[] = [];
  private readonly transformScratch: MutablePhysics3DBodyTransform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  private readonly vectorScratch = { x: 0, y: 0, z: 0 };
  private readonly pointScratch = { x: 0, y: 0, z: 0 };
  private readonly quaternionScratch = { x: 0, y: 0, z: 0, w: 1 };
  private readonly descPosition = { x: 0, y: 0, z: 0 };
  private readonly descRotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly bodyDescScratch: Physics3DBackendBodyDesc = {
    type: 'static',
    position: this.descPosition,
    rotation: this.descRotation,
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccd: false,
    allowSleep: true,
    lockTranslations: [false, false, false],
    lockRotations: [false, false, false],
  };
  private readonly _gravity: [number, number, number];
  private accumulator = 0;
  private physicsTick = 0;

  constructor(options: Physics3DSystemOptions) {
    super({ any: [Physics3DBody, Physics3DJoint] });
    this.backend = options.backend;
    this._gravity = [...(options.gravity ?? DEFAULT_GRAVITY)];
    this.fixedTimeStep = options.fixedTimeStep ?? 1 / 60;
    this.maxSubSteps = options.maxSubSteps ?? 5;
    this.solverIterations = options.solverIterations ?? 6;
    this.syncStaticBodiesFromTransform = options.syncStaticBodiesFromTransform ?? true;
    if (!(this.fixedTimeStep > 0)) throw new RangeError('Physics3DSystem fixedTimeStep must be greater than zero.');
    if (!(this.maxSubSteps > 0)) throw new RangeError('Physics3DSystem maxSubSteps must be greater than zero.');
    this.physicsWorld = this.backend.createWorld({
      gravity: vector(this._gravity),
      solverIterations: this.solverIterations,
    });
    this.capabilities = this.physicsWorld.capabilities;
    this.name = 'Physics3DSystem';
    if (options.priority !== undefined) this.priority = options.priority;
  }

  get backendId(): string {
    return this.physicsWorld.backendId;
  }

  get gravity(): readonly [number, number, number] {
    return this._gravity;
  }

  setGravity(gravity: readonly [number, number, number]): void {
    this._gravity[0] = gravity[0];
    this._gravity[1] = gravity[1];
    this._gravity[2] = gravity[2];
    this.physicsWorld.setGravity(gravity[0], gravity[1], gravity[2]);
  }

  hasBody(body: Physics3DBodyRef): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.hasBody(handle);
  }

  getBodyEntity(body: Physics3DBodyRef): Entity | null {
    const handle = this.resolveHandle(body);
    return handle === null ? null : this.bodyHandleEntities.get(handle) ?? null;
  }

  getBodyMass(body: Physics3DBodyRef): number | null {
    const handle = this.resolveHandle(body);
    return handle === null ? null : this.physicsWorld.getBodyMass(handle);
  }

  getBodyTransform(body: Physics3DBodyRef, out: MutablePhysics3DBodyTransform): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.getBodyTransform(handle, out);
  }

  getLinearVelocity(body: Physics3DBodyRef, out: MutablePhysics3DVector): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.getBodyLinearVelocity(handle, out);
  }

  setLinearVelocity(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.setBodyLinearVelocity(handle, this.vectorScratch, wake);
  }

  getAngularVelocity(body: Physics3DBodyRef, out: MutablePhysics3DVector): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.getBodyAngularVelocity(handle, out);
  }

  setAngularVelocity(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.setBodyAngularVelocity(handle, this.vectorScratch, wake);
  }

  setBodyAwake(body: Physics3DBodyRef, awake: boolean): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.setBodyAwake(handle, awake);
  }

  applyForce(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.applyBodyForce(handle, this.vectorScratch, wake);
  }

  applyForceAtPoint(
    body: Physics3DBodyRef,
    force: readonly [number, number, number],
    point: readonly [number, number, number],
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, force[0], force[1], force[2]);
    setVector(this.pointScratch, point[0], point[1], point[2]);
    return this.physicsWorld.applyBodyForceAtPoint(handle, this.vectorScratch, this.pointScratch, wake);
  }

  applyTorque(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.applyBodyTorque(handle, this.vectorScratch, wake);
  }

  applyLinearImpulse(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.applyBodyLinearImpulse(handle, this.vectorScratch, wake);
  }

  applyAngularImpulse(
    body: Physics3DBodyRef,
    x: number,
    y: number,
    z: number,
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    setVector(this.vectorScratch, x, y, z);
    return this.physicsWorld.applyBodyAngularImpulse(handle, this.vectorScratch, wake);
  }

  teleportBody(
    body: Physics3DBodyRef,
    position: readonly [number, number, number],
    rotation?: readonly [number, number, number, number],
    wake = true,
  ): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    let resolvedRotation = rotation;
    if (!resolvedRotation) {
      if (!this.physicsWorld.getBodyTransform(handle, this.transformScratch)) return false;
      const current = this.transformScratch.rotation;
      resolvedRotation = [current.x, current.y, current.z, current.w];
    }
    setVector(this.pointScratch, position[0], position[1], position[2]);
    setQuaternion(
      this.quaternionScratch,
      resolvedRotation[0],
      resolvedRotation[1],
      resolvedRotation[2],
      resolvedRotation[3],
    );
    return this.physicsWorld.setBodyTransform(
      handle,
      this.pointScratch,
      this.quaternionScratch,
      wake,
      false,
    );
  }

  castRay(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maxDistance = 1000,
    options: Omit<Physics3DRayCastDesc, 'origin' | 'direction' | 'maxDistance'> = { solid: true },
  ): Physics3DRaycastResult | null {
    const hit = this.physicsWorld.castRay({
      origin: { x: origin[0], y: origin[1], z: origin[2] },
      direction: { x: direction[0], y: direction[1], z: direction[2] },
      maxDistance,
      solid: options.solid,
      ...(options.categoryBits === undefined ? {} : { categoryBits: options.categoryBits }),
      ...(options.maskBits === undefined ? {} : { maskBits: options.maskBits }),
    });
    if (!hit) return null;
    const entity = this.bodyHandleEntities.get(hit.body);
    const body = entity?.getComponent(Physics3DBody);
    if (!entity || !body) return null;
    return {
      entity,
      body,
      distance: hit.distance,
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
    };
  }

  queryShape(
    shape: Readonly<{
      type: Physics3DBody['shape']; position: readonly [number, number, number]; rotation?: readonly [number, number, number, number];
      width?: number; height?: number; depth?: number; radius?: number; halfHeight?: number;
    }>,
    options: Readonly<{ categoryBits?: number; maskBits?: number; limit?: number }> = {},
  ): readonly Entity[] {
    if (!this.capabilities.shapeQuery) return Object.freeze([]);
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 256)));
    const entities = new Map<number, Entity>();
    this.physicsWorld.queryShape({
      shape: shape.type,
      position: vector(shape.position),
      rotation: quaternion(shape.rotation ?? [0, 0, 0, 1]),
      width: shape.width ?? 1,
      height: shape.height ?? 1,
      depth: shape.depth ?? 1,
      radius: shape.radius ?? 0.5,
      halfHeight: shape.halfHeight ?? 0.5,
      ...(options.categoryBits === undefined ? {} : { categoryBits: options.categoryBits }),
      ...(options.maskBits === undefined ? {} : { maskBits: options.maskBits }),
    }, handle => {
      const entity = this.bodyHandleEntities.get(handle);
      if (entity) entities.set(entity.id, entity);
      return entities.size < limit;
    });
    return Object.freeze([...entities.values()].sort((left, right) => left.id - right.id));
  }

  events(): readonly Physics3DContactEvent[] { return this.contactEvents; }

  resourceSnapshot(): Physics3DResourceSnapshot {
    return Object.freeze({ backendId: this.backendId, bodies: this.bodyHandles.size, colliders: this.colliderSignatures.size, joints: this.jointHandles.size, activeContacts: this.contactPairs.size });
  }

  createDragConstraint(
    body: Physics3DBodyRef,
    worldAnchor: readonly [number, number, number],
    target: readonly [number, number, number],
    options: Physics3DDragOptions = {},
  ): Physics3DDragHandle | null {
    const handle = this.resolveHandle(body);
    if (handle === null || !this.physicsWorld.getBodyTransform(handle, this.transformScratch)) return null;
    const transform = this.transformScratch;
    setVector(
      this.vectorScratch,
      worldAnchor[0] - transform.position.x,
      worldAnchor[1] - transform.position.y,
      worldAnchor[2] - transform.position.z,
    );
    const localAnchor = rotateByConjugate(transform.rotation, this.vectorScratch);
    const mass = this.physicsWorld.getBodyMass(handle) ?? 1;
    return this.physicsWorld.createDragConstraint({
      body: handle,
      localAnchor,
      target: { x: target[0], y: target[1], z: target[2] },
      stiffness: options.stiffness ?? 90 * mass,
      damping: options.damping ?? 12 * mass,
      maxForce: options.maxForce ?? 250 * mass,
    });
  }

  updateDragConstraint(
    handle: Physics3DDragHandle | null,
    target: readonly [number, number, number],
  ): boolean {
    if (handle === null) return false;
    setVector(this.pointScratch, target[0], target[1], target[2]);
    return this.physicsWorld.updateDragConstraint(handle, this.pointScratch);
  }

  destroyDragConstraint(handle: Physics3DDragHandle | null): void {
    if (handle !== null) this.physicsWorld.destroyDragConstraint(handle);
  }

  override update(world: World, _time: number, delta: number): this {
    if (this.disabled) return this;
    this.contactEvents = Object.freeze([]);
    this.syncBodies(world);
    this.syncJoints(world);

    const dt = Math.min(Math.max(delta / 1000, 0), this.fixedTimeStep * this.maxSubSteps);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedTimeStep && steps < this.maxSubSteps) {
      this.physicsWorld.step(this.fixedTimeStep);
      this.captureContactStep();
      this.accumulator -= this.fixedTimeStep;
      steps++;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;

    this.writeBackTransforms();
    return this;
  }

  override destroy(): this {
    for (const joint of this.jointEntities.keys()) this.destroyJoint(joint);
    for (const body of this.bodyEntities.keys()) this.destroyBody(body);
    this.physicsWorld.destroy();
    this.bodyEntities.clear();
    this.bodyHandles.clear();
    this.bodyHandleEntities.clear();
    this.jointEntities.clear();
    this.jointHandles.clear();
    this.bodyPropertySignatures.clear();
    this.colliderSignatures.clear();
    this.jointSignatures.clear();
    this.activeBodies.clear();
    this.activeJoints.clear();
    this.contactPairs.clear();
    this.contactEvents = Object.freeze([]);
    this.staleBodies.length = 0;
    this.staleJoints.length = 0;
    return super.destroy();
  }

  private syncBodies(world: World): void {
    const active = this.activeBodies;
    const stale = this.staleBodies;
    const entities = this.entitySet.get(world);
    active.clear();
    stale.length = 0;
    if (entities) for (const entity of entities) {
      const body = entity.getComponent(Physics3DBody);
      if (!body || entity.disabled) continue;
      active.add(body);
      const handle = this.bodyHandles.get(body) ?? null;
      if (handle === null || !this.physicsWorld.hasBody(handle)) {
        this.createBody(entity, body);
      } else {
        this.syncBodyProperties(entity, body, handle);
      }
      this.syncCollider(body);
    }

    for (const body of this.bodyEntities.keys()) {
      if (!active.has(body)) stale.push(body);
    }
    for (let index = 0; index < stale.length; index++) {
      this.destroyBody(requiredItemAt(stale, index, 'stale Physics3D bodies'));
    }
  }

  private createBody(entity: Entity, body: Physics3DBody): void {
    const staleHandle = this.bodyHandles.get(body) ?? null;
    if (staleHandle !== null) {
      this.bodyHandleEntities.delete(staleHandle);
      this.bodyHandles.delete(body);
      setPhysics3DBodyHandle(body, this, null);
    }
    const transform = entity.getComponent(Transform3D);
    const handle = this.physicsWorld.createBody(this.fillBodyDesc(body, transform));
    this.bodyHandles.set(body, handle);
    this.bodyHandleEntities.set(handle, entity);
    this.bodyEntities.set(body, entity);
    setPhysics3DBodyHandle(body, this, handle);
    this.bodyPropertySignatures.set(body, bodyPropertySignature(body));
    this.colliderSignatures.delete(body);
  }

  private syncBodyProperties(
    entity: Entity,
    body: Physics3DBody,
    handle: Physics3DBodyHandle,
  ): void {
    const transform = entity.getComponent(Transform3D);
    const desc = this.fillBodyDesc(body, transform);
    const signature = bodyPropertySignature(body);
    if (this.bodyPropertySignatures.get(body) !== signature) {
      if (!this.physicsWorld.updateBody(handle, desc)) {
        this.destroyBody(body);
        this.createBody(entity, body);
        return;
      }
      this.bodyPropertySignatures.set(body, signature);
    }
    if (
      transform
      && (body.type === 'kinematic' || (this.syncStaticBodiesFromTransform && body.type === 'static'))
    ) {
      this.physicsWorld.setBodyTransform(
        handle,
        desc.position,
        desc.rotation,
        true,
        body.type === 'kinematic',
      );
    }
  }

  private fillBodyDesc(body: Physics3DBody, transform: Transform3D | null): Physics3DBackendBodyDesc {
    const desc = this.bodyDescScratch;
    desc.type = body.type;
    extractMatrixTransform(transform?.localMatrix ?? null, this.descPosition, this.descRotation);
    desc.linearDamping = body.linearDamping;
    desc.angularDamping = body.angularDamping;
    desc.gravityScale = body.gravityScale;
    desc.ccd = body.ccd;
    desc.allowSleep = body.allowSleep;
    desc.lockTranslations = body.lockTranslations;
    desc.lockRotations = body.lockRotations;
    return desc;
  }

  private syncCollider(body: Physics3DBody): void {
    const handle = this.bodyHandles.get(body) ?? null;
    if (handle === null) return;
    const signature = colliderSignature(body);
    if (this.colliderSignatures.get(body) === signature) return;
    const desc: Physics3DBackendColliderDesc = {
      shape: body.shape,
      width: body.width,
      height: body.height,
      depth: body.depth,
      radius: body.radius,
      halfHeight: body.halfHeight,
      density: body.density,
      friction: body.friction,
      restitution: body.restitution,
      isSensor: body.isSensor,
      categoryBits: body.categoryBits,
      maskBits: body.maskBits,
    };
    if (this.physicsWorld.setBodyCollider(handle, desc)) this.colliderSignatures.set(body, signature);
  }

  private syncJoints(world: World): void {
    const active = this.activeJoints;
    const stale = this.staleJoints;
    const entities = this.entitySet.get(world);
    active.clear();
    stale.length = 0;
    if (entities) for (const entity of entities) {
      const joint = entity.getComponent(Physics3DJoint);
      if (!joint || entity.disabled) continue;
      active.add(joint);
      const bodyA = this.resolveBody(world, joint.bodyA);
      const bodyB = this.resolveBody(world, joint.bodyB);
      const handleA = bodyA ? this.bodyHandles.get(bodyA) ?? null : null;
      const handleB = bodyB ? this.bodyHandles.get(bodyB) ?? null : null;
      let handle = this.jointHandles.get(joint) ?? null;
      if (handle !== null && !this.physicsWorld.hasJoint(handle)) {
        this.clearJointBinding(joint);
        handle = null;
      }
      if (handleA === null || handleB === null) {
        if (handle !== null) this.destroyJoint(joint);
        continue;
      }
      const signature = jointSignature(joint, handleA, handleB);
      if (handle !== null && this.jointSignatures.get(joint) !== signature) {
        this.destroyJoint(joint);
        handle = null;
      }
      if (handle === null) {
        const created = this.physicsWorld.createJoint(createJointDesc(joint, handleA, handleB));
        if (created !== null) {
          this.jointHandles.set(joint, created);
          this.jointEntities.set(joint, entity);
          this.jointSignatures.set(joint, signature);
          setPhysics3DJointHandle(joint, this, created);
        }
      }
    }

    for (const joint of this.jointEntities.keys()) {
      if (!active.has(joint)) stale.push(joint);
    }
    for (let index = 0; index < stale.length; index++) {
      this.destroyJoint(requiredItemAt(stale, index, 'stale Physics3D joints'));
    }
  }

  private resolveBody(world: World, target: Entity | string | number): Physics3DBody | null {
    const entity = target instanceof Entity ? target : world.getEntity(target);
    return entity?.getComponent(Physics3DBody) ?? null;
  }

  private writeBackTransforms(): void {
    for (const [body, entity] of this.bodyEntities) {
      if (!body.syncTransform || body.type === 'static') continue;
      const handle = this.bodyHandles.get(body) ?? null;
      const transform = entity.getComponent(Transform3D);
      if (
        handle === null
        || !transform
        || !this.physicsWorld.getBodyTransform(handle, this.transformScratch)
      ) continue;
      writeMatrixTransform(transform, this.transformScratch);
    }
  }

  private destroyBody(body: Physics3DBody): void {
    const handle = this.bodyHandles.get(body) ?? null;
    if (handle === null) return;
    this.physicsWorld.destroyBody(handle);
    this.bodyHandleEntities.delete(handle);
    this.bodyEntities.delete(body);
    this.bodyHandles.delete(body);
    this.bodyPropertySignatures.delete(body);
    this.colliderSignatures.delete(body);
    setPhysics3DBodyHandle(body, this, null);
  }

  private destroyJoint(joint: Physics3DJoint): void {
    const handle = this.jointHandles.get(joint) ?? null;
    if (handle !== null) this.physicsWorld.destroyJoint(handle);
    this.clearJointBinding(joint);
  }

  private clearJointBinding(joint: Physics3DJoint): void {
    this.jointEntities.delete(joint);
    this.jointHandles.delete(joint);
    this.jointSignatures.delete(joint);
    setPhysics3DJointHandle(joint, this, null);
  }

  private resolveHandle(body: Physics3DBodyRef): Physics3DBodyHandle | null {
    return typeof body === 'number' ? body : this.bodyHandles.get(body) ?? null;
  }

  private captureContactStep(): void {
    this.physicsTick += 1;
    if (!this.capabilities.contactEvents) { this.contactEvents = Object.freeze([]); return; }
    const entered = new Set<string>();
    const output: Physics3DContactEvent[] = [...this.contactEvents];
    this.physicsWorld.drainContactEvents((event: Physics3DBackendContactEvent) => {
      const key = contactKey(event.bodyA, event.bodyB);
      if (event.started) {
        if (this.contactPairs.has(key)) return;
        const entityA = this.bodyHandleEntities.get(event.bodyA);
        const entityB = this.bodyHandleEntities.get(event.bodyB);
        if (!entityA || !entityB) return;
        this.contactPairs.set(key, Object.freeze({ entityA, entityB, sensor: event.sensor }));
        entered.add(key);
        output.push(contactEvent(this.physicsTick, 'enter', entityA, entityB, event.sensor));
      } else {
        const active = this.contactPairs.get(key);
        if (!active) return;
        this.contactPairs.delete(key);
        output.push(contactEvent(this.physicsTick, 'exit', active.entityA, active.entityB, active.sensor));
      }
    });
    for (const [key, active] of this.contactPairs) {
      if (!entered.has(key)) output.push(contactEvent(this.physicsTick, 'stay', active.entityA, active.entityB, active.sensor));
    }
    output.sort(compareContactEvents);
    this.contactEvents = Object.freeze(output.slice(-1_024));
  }
}

function contactKey(bodyA: Physics3DBodyHandle, bodyB: Physics3DBodyHandle): string { return `${bodyA}:${bodyB}`; }
function contactEvent(tick: number, phase: Physics3DContactEvent['phase'], entityA: Entity, entityB: Entity, sensor: boolean): Physics3DContactEvent {
  return Object.freeze({ tick, phase, kind: sensor ? 'trigger' : 'collision', entityA, entityB });
}
function compareContactEvents(left: Physics3DContactEvent, right: Physics3DContactEvent): number {
  return left.tick - right.tick || left.entityA.id - right.entityA.id || left.entityB.id - right.entityB.id || phaseOrder(left.phase) - phaseOrder(right.phase);
}
function phaseOrder(value: Physics3DContactEvent['phase']): number { return value === 'enter' ? 0 : value === 'stay' ? 1 : 2; }

const rotationMatrixScratch = mat4.identity() as Float32Array;
const quaternionArrayScratch = quat.identity() as Float32Array;
const outputMatrixScratch = mat4.identity() as Float32Array;

function extractMatrixTransform(
  matrix: Float32Array | null,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
): void {
  if (!matrix) {
    setVector(position, 0, 0, 0);
    setQuaternion(rotation, 0, 0, 0, 1);
    return;
  }
  position.x = matrix[12] ?? 0;
  position.y = matrix[13] ?? 0;
  position.z = matrix[14] ?? 0;
  const sx = Math.hypot(matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0) || 1;
  const sy = Math.hypot(matrix[4] ?? 0, matrix[5] ?? 1, matrix[6] ?? 0) || 1;
  const sz = Math.hypot(matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 1) || 1;
  mat4.identity(rotationMatrixScratch);
  rotationMatrixScratch[0] = (matrix[0] ?? 1) / sx;
  rotationMatrixScratch[1] = (matrix[1] ?? 0) / sx;
  rotationMatrixScratch[2] = (matrix[2] ?? 0) / sx;
  rotationMatrixScratch[4] = (matrix[4] ?? 0) / sy;
  rotationMatrixScratch[5] = (matrix[5] ?? 1) / sy;
  rotationMatrixScratch[6] = (matrix[6] ?? 0) / sy;
  rotationMatrixScratch[8] = (matrix[8] ?? 0) / sz;
  rotationMatrixScratch[9] = (matrix[9] ?? 0) / sz;
  rotationMatrixScratch[10] = (matrix[10] ?? 1) / sz;
  quat.fromMat(rotationMatrixScratch, quaternionArrayScratch);
  quat.normalize(quaternionArrayScratch, quaternionArrayScratch);
  setQuaternion(
    rotation,
    quaternionArrayScratch[0] ?? 0,
    quaternionArrayScratch[1] ?? 0,
    quaternionArrayScratch[2] ?? 0,
    quaternionArrayScratch[3] ?? 1,
  );
}

function writeMatrixTransform(transform: Transform3D, value: MutablePhysics3DBodyTransform): void {
  const previous = transform.localMatrix;
  const sx = Math.hypot(previous[0] ?? 1, previous[1] ?? 0, previous[2] ?? 0) || 1;
  const sy = Math.hypot(previous[4] ?? 0, previous[5] ?? 1, previous[6] ?? 0) || 1;
  const sz = Math.hypot(previous[8] ?? 0, previous[9] ?? 0, previous[10] ?? 1) || 1;
  setQuaternion(
    quaternionArrayScratch,
    value.rotation.x,
    value.rotation.y,
    value.rotation.z,
    value.rotation.w,
  );
  mat4.fromQuat(quaternionArrayScratch, outputMatrixScratch);
  outputMatrixScratch[0] = (outputMatrixScratch[0] ?? 0) * sx;
  outputMatrixScratch[1] = (outputMatrixScratch[1] ?? 0) * sx;
  outputMatrixScratch[2] = (outputMatrixScratch[2] ?? 0) * sx;
  outputMatrixScratch[4] = (outputMatrixScratch[4] ?? 0) * sy;
  outputMatrixScratch[5] = (outputMatrixScratch[5] ?? 0) * sy;
  outputMatrixScratch[6] = (outputMatrixScratch[6] ?? 0) * sy;
  outputMatrixScratch[8] = (outputMatrixScratch[8] ?? 0) * sz;
  outputMatrixScratch[9] = (outputMatrixScratch[9] ?? 0) * sz;
  outputMatrixScratch[10] = (outputMatrixScratch[10] ?? 0) * sz;
  outputMatrixScratch[12] = value.position.x;
  outputMatrixScratch[13] = value.position.y;
  outputMatrixScratch[14] = value.position.z;
  transform.setMatrix(outputMatrixScratch);
}

function createJointDesc(
  joint: Physics3DJoint,
  bodyA: Physics3DBodyHandle,
  bodyB: Physics3DBodyHandle,
): Physics3DBackendJointDesc {
  const base = {
    bodyA,
    bodyB,
    anchorA: vector(joint.anchorA),
    anchorB: vector(joint.anchorB),
    collideConnected: joint.collideConnected,
  };
  switch (joint.type) {
    case 'fixed':
      return {
        ...base,
        type: 'fixed',
        frameA: quaternion(joint.frameA),
        frameB: quaternion(joint.frameB),
      };
    case 'spherical':
      return { ...base, type: 'spherical' };
    case 'revolute':
      return { ...base, type: 'revolute', axis: vector(joint.axis), limits: joint.limits };
    case 'prismatic':
      return { ...base, type: 'prismatic', axis: vector(joint.axis), limits: joint.limits };
    case 'spring':
      return {
        ...base,
        type: 'spring',
        restLength: joint.restLength,
        stiffness: joint.stiffness,
        damping: joint.damping,
      };
    case 'rope':
      return { ...base, type: 'rope', maxLength: joint.maxLength };
  }
}

function colliderSignature(body: Physics3DBody): string {
  return [
    body.shape,
    body.width,
    body.height,
    body.depth,
    body.radius,
    body.halfHeight,
    body.density,
    body.friction,
    body.restitution,
    body.isSensor,
    body.categoryBits,
    body.maskBits,
  ].join('|');
}

function bodyPropertySignature(body: Physics3DBody): string {
  return [
    body.type,
    body.linearDamping,
    body.angularDamping,
    body.gravityScale,
    body.ccd,
    body.allowSleep,
    body.lockTranslations.join(','),
    body.lockRotations.join(','),
  ].join('|');
}

function jointSignature(
  joint: Physics3DJoint,
  bodyA: Physics3DBodyHandle,
  bodyB: Physics3DBodyHandle,
): string {
  return [
    joint.type,
    bodyA,
    bodyB,
    joint.anchorA.join(','),
    joint.anchorB.join(','),
    joint.axis.join(','),
    joint.frameA.join(','),
    joint.frameB.join(','),
    joint.collideConnected,
    joint.limits?.join(',') ?? '',
    joint.restLength,
    joint.maxLength,
    joint.stiffness,
    joint.damping,
  ].join('|');
}

function vector(value: ArrayLike<number>): { x: number; y: number; z: number } {
  return { x: value[0] ?? 0, y: value[1] ?? 0, z: value[2] ?? 0 };
}

function quaternion(value: ArrayLike<number>): { x: number; y: number; z: number; w: number } {
  return {
    x: value[0] ?? 0,
    y: value[1] ?? 0,
    z: value[2] ?? 0,
    w: value[3] ?? 1,
  };
}

function setVector(target: MutablePhysics3DVector, x: number, y: number, z: number): void {
  target.x = x;
  target.y = y;
  target.z = z;
}

function setQuaternion(
  target: { [index: number]: number } | { x: number; y: number; z: number; w: number },
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  if ('x' in target) {
    target.x = x;
    target.y = y;
    target.z = z;
    target.w = w;
  } else {
    target[0] = x;
    target[1] = y;
    target[2] = z;
    target[3] = w;
  }
}

function rotateByConjugate(
  rotation: Physics3DQuaternionLike,
  value: Physics3DVectorLike,
): { x: number; y: number; z: number } {
  return rotateVector(
    { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w },
    value,
  );
}

function rotateVector(
  rotation: Physics3DQuaternionLike,
  value: Physics3DVectorLike,
): { x: number; y: number; z: number } {
  const tx = 2 * (rotation.y * value.z - rotation.z * value.y);
  const ty = 2 * (rotation.z * value.x - rotation.x * value.z);
  const tz = 2 * (rotation.x * value.y - rotation.y * value.x);
  return {
    x: value.x + rotation.w * tx + (rotation.y * tz - rotation.z * ty),
    y: value.y + rotation.w * ty + (rotation.z * tx - rotation.x * tz),
    z: value.z + rotation.w * tz + (rotation.x * ty - rotation.y * tx),
  };
}
