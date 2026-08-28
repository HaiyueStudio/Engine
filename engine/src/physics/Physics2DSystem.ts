import { Transform2D } from '../components/Transform2D';
import { Entity } from '../ecs/Entity';
import { System } from '../ecs/System';
import type { World } from '../ecs/World';
import { requiredItemAt } from '../math/arrayAccess';
import { createBox2DPhysics2DBackend } from './Box2DPhysics2DBackend';
import type {
  MutablePhysics2DBodyTransform,
  MutablePhysics2DVector,
  Physics2DBackend,
  Physics2DBackendBodyDesc,
  Physics2DBackendColliderDesc,
  Physics2DContactEvent as Physics2DBackendContactEvent,
  Physics2DBackendDistanceJointDesc,
  Physics2DBackendRevoluteJointDesc,
  Physics2DBodyHandle,
  Physics2DCapabilities,
  Physics2DJointHandle,
  Physics2DWorldDriver,
} from './Physics2DBackend';
import { Physics2DBody } from './Physics2DBody';
import { Physics2DJoint } from './Physics2DJoint';
import {
  setPhysics2DBodyHandle,
  setPhysics2DJointHandle,
} from './Physics2DRuntimeHandles';

export interface Physics2DSystemOptions {
  /** Acceleration in engine/render units per second squared. */
  gravity?: [number, number];
  /** Conversion from engine/render lengths to one physics meter. */
  pixelsPerMeter?: number;
  fixedTimeStep?: number;
  maxSubSteps?: number;
  velocityIterations?: number;
  positionIterations?: number;
  syncStaticBodiesFromTransform?: boolean;
  priority?: number;
  /** Defaults to the built-in Box2D adapter. */
  backend?: Physics2DBackend;
}

export interface Physics2DMouseJointOptions {
  /** Force in backend physics units. */
  maxForce?: number;
  frequencyHz?: number;
  dampingRatio?: number;
}

export type Physics2DBodyRef = Physics2DBody | Physics2DBodyHandle;

export interface Physics2DContactEvent {
  readonly tick: number;
  readonly phase: 'enter' | 'stay' | 'exit';
  readonly kind: 'collision' | 'trigger';
  readonly entityA: Entity;
  readonly entityB: Entity;
}

export interface Physics2DRaycastResult {
  readonly entity: Entity;
  readonly body: Physics2DBody;
  readonly distance: number;
  readonly point: readonly [number, number];
  readonly normal: readonly [number, number];
}

export interface Physics2DResourceSnapshot {
  readonly backendId: string;
  readonly bodies: number;
  readonly colliders: number;
  readonly joints: number;
  readonly activeContacts: number;
}

const DEFAULT_GRAVITY: [number, number] = [0, -980];

export class Physics2DSystem extends System {
  readonly backend: Physics2DBackend;
  readonly capabilities: Physics2DCapabilities;
  pixelsPerMeter: number;
  fixedTimeStep: number;
  maxSubSteps: number;
  velocityIterations: number;
  positionIterations: number;
  syncStaticBodiesFromTransform: boolean;

  private readonly physicsWorld: Physics2DWorldDriver;
  private readonly bodyEntities = new Map<Physics2DBody, Entity>();
  private readonly bodyHandles = new Map<Physics2DBody, Physics2DBodyHandle>();
  private readonly bodyHandleEntities = new Map<Physics2DBodyHandle, Entity>();
  private readonly jointEntities = new Map<Physics2DJoint, Entity>();
  private readonly jointHandles = new Map<Physics2DJoint, Physics2DJointHandle>();
  private readonly fixtureSignatures = new Map<Physics2DBody, string>();
  private readonly jointSignatures = new Map<Physics2DJoint, string>();
  private readonly activeBodies = new Set<Physics2DBody>();
  private readonly activeJoints = new Set<Physics2DJoint>();
  private readonly contactPairs = new Map<string, Readonly<{ entityA: Entity; entityB: Entity; sensor: boolean }>>();
  private contactEvents: readonly Physics2DContactEvent[] = Object.freeze([]);
  private readonly staleBodies: Physics2DBody[] = [];
  private readonly staleJoints: Physics2DJoint[] = [];
  private readonly transformScratch: MutablePhysics2DBodyTransform = { x: 0, y: 0, angle: 0 };
  private readonly vectorScratch = { x: 0, y: 0 };
  private readonly bodyDescScratch: Physics2DBackendBodyDesc = {
    type: 'static',
    positionX: 0,
    positionY: 0,
    angle: 0,
    fixedRotation: false,
    linearDamping: 0,
    angularDamping: 0,
    bullet: false,
    allowSleep: true,
  };
  private accumulator = 0;
  private physicsTick = 0;

  constructor(options: Physics2DSystemOptions = {}) {
    super({ any: [Physics2DBody, Physics2DJoint] });
    this.pixelsPerMeter = options.pixelsPerMeter ?? 100;
    if (!(this.pixelsPerMeter > 0)) throw new RangeError('Physics2DSystem pixelsPerMeter must be greater than zero.');
    const gravity = options.gravity ?? DEFAULT_GRAVITY;
    this.backend = options.backend ?? createBox2DPhysics2DBackend();
    this.physicsWorld = this.backend.createWorld({
      gravityX: gravity[0] / this.pixelsPerMeter,
      gravityY: gravity[1] / this.pixelsPerMeter,
    });
    this.capabilities = this.physicsWorld.capabilities;
    this.fixedTimeStep = options.fixedTimeStep ?? 1 / 60;
    this.maxSubSteps = options.maxSubSteps ?? 5;
    this.velocityIterations = options.velocityIterations ?? 8;
    this.positionIterations = options.positionIterations ?? 3;
    this.syncStaticBodiesFromTransform = options.syncStaticBodiesFromTransform ?? true;
    this.name = 'Physics2DSystem';
    if (options.priority !== undefined) this.priority = options.priority;
  }

  get backendId(): string {
    return this.physicsWorld.backendId;
  }

  setGravity(gravity: [number, number]): void {
    this.physicsWorld.setGravity(gravity[0] / this.pixelsPerMeter, gravity[1] / this.pixelsPerMeter);
  }

  hasBody(body: Physics2DBodyRef): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.hasBody(handle);
  }

  getBodyMass(body: Physics2DBodyRef): number | null {
    const handle = this.resolveHandle(body);
    return handle === null ? null : this.physicsWorld.getBodyMass(handle);
  }

  /** Writes linear velocity in physics meters per second. */
  getLinearVelocity(body: Physics2DBodyRef, out: MutablePhysics2DVector): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.getBodyLinearVelocity(handle, out);
  }

  /** Sets linear velocity in physics meters per second. */
  setLinearVelocity(body: Physics2DBodyRef, x: number, y: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    this.vectorScratch.x = x;
    this.vectorScratch.y = y;
    const updated = this.physicsWorld.setBodyLinearVelocity(handle, this.vectorScratch);
    if (updated && wake) this.physicsWorld.setBodyAwake(handle, true);
    return updated;
  }

  getAngularVelocity(body: Physics2DBodyRef): number | null {
    const handle = this.resolveHandle(body);
    return handle === null ? null : this.physicsWorld.getBodyAngularVelocity(handle);
  }

  setAngularVelocity(body: Physics2DBodyRef, velocity: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    const updated = this.physicsWorld.setBodyAngularVelocity(handle, velocity);
    if (updated && wake) this.physicsWorld.setBodyAwake(handle, true);
    return updated;
  }

  setBodyAwake(body: Physics2DBodyRef, awake: boolean): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.setBodyAwake(handle, awake);
  }

  /** Applies a force in backend physics units. */
  applyForce(body: Physics2DBodyRef, x: number, y: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    this.vectorScratch.x = x;
    this.vectorScratch.y = y;
    return this.physicsWorld.applyBodyForce(handle, this.vectorScratch, wake);
  }

  applyTorque(body: Physics2DBodyRef, torque: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.applyBodyTorque(handle, torque, wake);
  }

  /** Applies an impulse in backend physics units. */
  applyLinearImpulse(body: Physics2DBodyRef, x: number, y: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    this.vectorScratch.x = x;
    this.vectorScratch.y = y;
    return this.physicsWorld.applyBodyLinearImpulse(handle, this.vectorScratch, wake);
  }

  applyAngularImpulse(body: Physics2DBodyRef, impulse: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    return handle !== null && this.physicsWorld.applyBodyAngularImpulse(handle, impulse, wake);
  }

  /** Teleports a body using engine/render coordinates rather than physics meters. */
  teleportBody(body: Physics2DBodyRef, x: number, y: number, angle?: number, wake = true): boolean {
    const handle = this.resolveHandle(body);
    if (handle === null) return false;
    let resolvedAngle = angle;
    if (resolvedAngle === undefined) {
      if (!this.physicsWorld.getBodyTransform(handle, this.transformScratch)) return false;
      resolvedAngle = this.transformScratch.angle;
    }
    const updated = this.physicsWorld.setBodyTransform(
      handle,
      x / this.pixelsPerMeter,
      y / this.pixelsPerMeter,
      resolvedAngle,
    );
    if (updated && wake) this.physicsWorld.setBodyAwake(handle, true);
    return updated;
  }

  hitTest(world: World, x: number, y: number, filter?: (entity: Entity, body: Physics2DBody) => boolean): Entity | null {
    let result: Entity | null = null;
    this.physicsWorld.queryPoint(x / this.pixelsPerMeter, y / this.pixelsPerMeter, handle => {
      const entity = this.bodyHandleEntities.get(handle);
      const physicsBody = entity?.getComponent(Physics2DBody);
      if (!entity || !physicsBody || (filter && !filter(entity, physicsBody))) return true;
      result = entity;
      return false;
    });
    if (result) return result;

    for (const entity of world.entities.values()) {
      const physicsBody = entity.getComponent(Physics2DBody);
      const transform = entity.getComponent(Transform2D);
      if (!physicsBody || !transform || entity.disabled) continue;
      if (filter && !filter(entity, physicsBody)) continue;
      if (containsPhysicsBodyPoint(physicsBody, transform, x, y)) return entity;
    }
    return result;
  }

  castRay(
    origin: readonly [number, number],
    direction: readonly [number, number],
    maxDistance = 100_000,
    filter: Readonly<{ categoryBits?: number; maskBits?: number }> = {},
  ): Physics2DRaycastResult | null {
    if (!this.capabilities.rayCast) return null;
    const hit = this.physicsWorld.castRay({
      origin: { x: origin[0] / this.pixelsPerMeter, y: origin[1] / this.pixelsPerMeter },
      direction: { x: direction[0], y: direction[1] },
      maxDistance: maxDistance / this.pixelsPerMeter,
      ...(filter.categoryBits === undefined ? {} : { categoryBits: filter.categoryBits }),
      ...(filter.maskBits === undefined ? {} : { maskBits: filter.maskBits }),
    });
    if (!hit) return null;
    const entity = this.bodyHandleEntities.get(hit.body);
    const body = entity?.getComponent(Physics2DBody);
    if (!entity || !body) return null;
    return Object.freeze({
      entity,
      body,
      distance: hit.distance * this.pixelsPerMeter,
      point: Object.freeze([hit.point.x * this.pixelsPerMeter, hit.point.y * this.pixelsPerMeter] as [number, number]),
      normal: Object.freeze([hit.normal.x, hit.normal.y] as [number, number]),
    });
  }

  queryAabb(
    minimum: readonly [number, number],
    maximum: readonly [number, number],
    options: Readonly<{ categoryBits?: number; maskBits?: number; limit?: number }> = {},
  ): readonly Entity[] {
    if (!this.capabilities.shapeQuery) return Object.freeze([]);
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 256)));
    const entities = new Map<number, Entity>();
    this.physicsWorld.queryAabb({
      minimum: { x: minimum[0] / this.pixelsPerMeter, y: minimum[1] / this.pixelsPerMeter },
      maximum: { x: maximum[0] / this.pixelsPerMeter, y: maximum[1] / this.pixelsPerMeter },
      ...(options.categoryBits === undefined ? {} : { categoryBits: options.categoryBits }),
      ...(options.maskBits === undefined ? {} : { maskBits: options.maskBits }),
    }, handle => {
      const entity = this.bodyHandleEntities.get(handle);
      if (entity) entities.set(entity.id, entity);
      return entities.size < limit;
    });
    return Object.freeze([...entities.values()].sort((left, right) => left.id - right.id));
  }

  events(): readonly Physics2DContactEvent[] { return this.contactEvents; }

  resourceSnapshot(): Physics2DResourceSnapshot {
    return Object.freeze({ backendId: this.backendId, bodies: this.bodyHandles.size, colliders: this.fixtureSignatures.size, joints: this.jointHandles.size, activeContacts: this.contactPairs.size });
  }

  createMouseJoint(
    body: Physics2DBodyRef,
    target: [number, number],
    options: Physics2DMouseJointOptions = {},
  ): Physics2DJointHandle | null {
    const handle = this.resolveHandle(body);
    if (handle === null) return null;
    const mass = this.physicsWorld.getBodyMass(handle) ?? 1;
    return this.physicsWorld.createMouseJoint({
      body: handle,
      targetX: target[0] / this.pixelsPerMeter,
      targetY: target[1] / this.pixelsPerMeter,
      maxForce: options.maxForce ?? Math.max(1000, 1000 * mass),
      frequencyHz: options.frequencyHz ?? 8,
      dampingRatio: options.dampingRatio ?? 0.85,
    });
  }

  updateMouseJoint(joint: Physics2DJointHandle | null, target: [number, number]): boolean {
    return joint !== null && this.physicsWorld.updateMouseJoint(
      joint,
      target[0] / this.pixelsPerMeter,
      target[1] / this.pixelsPerMeter,
    );
  }

  destroyMouseJoint(joint: Physics2DJointHandle | null): void {
    if (joint !== null) this.physicsWorld.destroyJoint(joint);
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
      this.physicsWorld.step(this.fixedTimeStep, this.velocityIterations, this.positionIterations);
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
    this.fixtureSignatures.clear();
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
      const physicsBody = entity.getComponent(Physics2DBody);
      if (!physicsBody || entity.disabled) continue;
      active.add(physicsBody);
      const handle = this.bodyHandles.get(physicsBody) ?? null;
      if (handle === null || !this.physicsWorld.hasBody(handle)) {
        this.createBody(entity, physicsBody);
      } else {
        this.syncBodyProperties(entity, physicsBody, handle);
      }
      this.syncFixture(physicsBody);
    }

    for (const body of this.bodyEntities.keys()) {
      if (!active.has(body)) stale.push(body);
    }
    for (let i = 0, len = stale.length; i < len; i++) {
      this.destroyBody(requiredItemAt(stale, i, 'stale Physics2D bodies'));
    }
  }

  private createBody(entity: Entity, physicsBody: Physics2DBody): void {
    const staleHandle = this.bodyHandles.get(physicsBody) ?? null;
    if (staleHandle !== null) {
      this.bodyHandleEntities.delete(staleHandle);
      this.bodyHandles.delete(physicsBody);
      setPhysics2DBodyHandle(physicsBody, this, null);
    }
    const transform = entity.getComponent(Transform2D);
    const desc = this.fillBodyDesc(physicsBody, transform);
    const handle = this.physicsWorld.createBody(desc);
    this.bodyHandles.set(physicsBody, handle);
    setPhysics2DBodyHandle(physicsBody, this, handle);
    this.bodyEntities.set(physicsBody, entity);
    this.bodyHandleEntities.set(handle, entity);
    this.fixtureSignatures.delete(physicsBody);
  }

  private syncBodyProperties(entity: Entity, physicsBody: Physics2DBody, handle: Physics2DBodyHandle): void {
    const transform = entity.getComponent(Transform2D);
    this.physicsWorld.updateBody(handle, this.fillBodyDesc(physicsBody, transform));
    if (this.syncStaticBodiesFromTransform && physicsBody.type !== 'dynamic' && transform) {
      this.physicsWorld.setBodyTransform(
        handle,
        transform.x / this.pixelsPerMeter,
        transform.y / this.pixelsPerMeter,
        transform.rotation,
      );
    }
  }

  private fillBodyDesc(physicsBody: Physics2DBody, transform: Transform2D | null): Physics2DBackendBodyDesc {
    const desc = this.bodyDescScratch;
    desc.type = physicsBody.type;
    desc.positionX = (transform?.x ?? 0) / this.pixelsPerMeter;
    desc.positionY = (transform?.y ?? 0) / this.pixelsPerMeter;
    desc.angle = transform?.rotation ?? 0;
    desc.fixedRotation = physicsBody.fixedRotation;
    desc.linearDamping = physicsBody.linearDamping;
    desc.angularDamping = physicsBody.angularDamping;
    desc.bullet = physicsBody.bullet;
    desc.allowSleep = physicsBody.allowSleep;
    return desc;
  }

  private syncFixture(physicsBody: Physics2DBody): void {
    const handle = this.bodyHandles.get(physicsBody) ?? null;
    if (handle === null) return;
    const signature = fixtureSignature(physicsBody);
    if (this.fixtureSignatures.get(physicsBody) === signature) return;
    const desc: Physics2DBackendColliderDesc = {
      shape: physicsBody.shape,
      width: physicsBody.width / this.pixelsPerMeter,
      height: physicsBody.height / this.pixelsPerMeter,
      radius: physicsBody.radius / this.pixelsPerMeter,
      density: physicsBody.density,
      friction: physicsBody.friction,
      restitution: physicsBody.restitution,
      isSensor: physicsBody.isSensor,
      categoryBits: physicsBody.categoryBits,
      maskBits: physicsBody.maskBits,
      groupIndex: physicsBody.groupIndex,
    };
    if (this.physicsWorld.setBodyCollider(handle, desc)) this.fixtureSignatures.set(physicsBody, signature);
  }

  private syncJoints(world: World): void {
    const active = this.activeJoints;
    const stale = this.staleJoints;
    const entities = this.entitySet.get(world);
    active.clear();
    stale.length = 0;
    if (entities) for (const entity of entities) {
      const joint = entity.getComponent(Physics2DJoint);
      if (!joint || entity.disabled) continue;
      active.add(joint);
      const bodyA = this.resolveBody(world, joint.bodyA);
      const bodyB = this.resolveBody(world, joint.bodyB);
      const bodyAHandle = bodyA ? this.bodyHandles.get(bodyA) ?? null : null;
      const bodyBHandle = bodyB ? this.bodyHandles.get(bodyB) ?? null : null;
      let handle = this.jointHandles.get(joint) ?? null;
      if (handle !== null && !this.physicsWorld.hasJoint(handle)) {
        this.jointHandles.delete(joint);
        setPhysics2DJointHandle(joint, this, null);
        this.jointEntities.delete(joint);
        this.jointSignatures.delete(joint);
        handle = null;
      }
      if (bodyAHandle === null || bodyBHandle === null) {
        if (handle !== null) this.destroyJoint(joint);
        continue;
      }
      const signature = jointSignature(joint, bodyAHandle, bodyBHandle);
      if (handle !== null && this.jointSignatures.get(joint) !== signature) {
        this.destroyJoint(joint);
        handle = null;
      }
      if (handle === null) {
        const created = joint.type === 'distance'
          ? this.physicsWorld.createJoint(this.createDistanceJointDesc(joint, bodyAHandle, bodyBHandle))
          : this.physicsWorld.createJoint(this.createRevoluteJointDesc(joint, bodyAHandle, bodyBHandle));
        if (created !== null) {
          this.jointHandles.set(joint, created);
          setPhysics2DJointHandle(joint, this, created);
          this.jointEntities.set(joint, entity);
          this.jointSignatures.set(joint, signature);
        }
      }
    }

    for (const joint of this.jointEntities.keys()) {
      if (!active.has(joint)) stale.push(joint);
    }
    for (let i = 0, len = stale.length; i < len; i++) {
      this.destroyJoint(requiredItemAt(stale, i, 'stale Physics2D joints'));
    }
  }

  private createRevoluteJointDesc(
    joint: Physics2DJoint,
    bodyA: Physics2DBodyHandle,
    bodyB: Physics2DBodyHandle,
  ): Physics2DBackendRevoluteJointDesc {
    const desc: Physics2DBackendRevoluteJointDesc = {
      type: 'revolute',
      bodyA,
      bodyB,
      collideConnected: joint.collideConnected,
      enableLimit: joint.enableLimit,
      lowerAngle: joint.lowerAngle,
      upperAngle: joint.upperAngle,
      enableMotor: joint.enableMotor,
      motorSpeed: joint.motorSpeed,
      maxMotorTorque: joint.maxMotorTorque,
    };
    if (joint.anchor) {
      desc.anchorX = joint.anchor[0] / this.pixelsPerMeter;
      desc.anchorY = joint.anchor[1] / this.pixelsPerMeter;
    }
    return desc;
  }

  private createDistanceJointDesc(
    joint: Physics2DJoint,
    bodyA: Physics2DBodyHandle,
    bodyB: Physics2DBodyHandle,
  ): Physics2DBackendDistanceJointDesc {
    const desc: Physics2DBackendDistanceJointDesc = {
      type: 'distance',
      bodyA,
      bodyB,
      collideConnected: joint.collideConnected,
      frequencyHz: joint.frequencyHz,
      dampingRatio: joint.dampingRatio,
    };
    if (joint.anchorA) {
      desc.anchorAX = joint.anchorA[0] / this.pixelsPerMeter;
      desc.anchorAY = joint.anchorA[1] / this.pixelsPerMeter;
    }
    if (joint.anchorB) {
      desc.anchorBX = joint.anchorB[0] / this.pixelsPerMeter;
      desc.anchorBY = joint.anchorB[1] / this.pixelsPerMeter;
    }
    if (joint.length !== null) desc.length = joint.length / this.pixelsPerMeter;
    return desc;
  }

  private resolveBody(world: World, target: Entity | string | number): Physics2DBody | null {
    const entity = target instanceof Entity ? target : world.getEntity(target);
    return entity?.getComponent(Physics2DBody) ?? null;
  }

  private writeBackTransforms(): void {
    for (const [physicsBody, entity] of this.bodyEntities) {
      if (!physicsBody.syncTransform || physicsBody.type === 'static') continue;
      const handle = this.bodyHandles.get(physicsBody) ?? null;
      const transform = entity.getComponent(Transform2D);
      if (handle === null || !transform || !this.physicsWorld.getBodyTransform(handle, this.transformScratch)) continue;
      transform.x = this.transformScratch.x * this.pixelsPerMeter;
      transform.y = this.transformScratch.y * this.pixelsPerMeter;
      transform.rotation = this.transformScratch.angle;
    }
  }

  private destroyBody(physicsBody: Physics2DBody): void {
    const handle = this.bodyHandles.get(physicsBody) ?? null;
    if (handle === null) return;
    this.physicsWorld.destroyBody(handle);
    this.bodyHandleEntities.delete(handle);
    this.bodyEntities.delete(physicsBody);
    this.bodyHandles.delete(physicsBody);
    this.fixtureSignatures.delete(physicsBody);
    setPhysics2DBodyHandle(physicsBody, this, null);
  }

  private destroyJoint(joint: Physics2DJoint): void {
    const handle = this.jointHandles.get(joint) ?? null;
    if (handle !== null) this.physicsWorld.destroyJoint(handle);
    this.jointEntities.delete(joint);
    this.jointHandles.delete(joint);
    this.jointSignatures.delete(joint);
    setPhysics2DJointHandle(joint, this, null);
  }

  private resolveHandle(body: Physics2DBodyRef): Physics2DBodyHandle | null {
    return typeof body === 'number' ? body : this.bodyHandles.get(body) ?? null;
  }

  private captureContactStep(): void {
    this.physicsTick += 1;
    if (!this.capabilities.contactEvents) { this.contactEvents = Object.freeze([]); return; }
    const entered = new Set<string>();
    const output: Physics2DContactEvent[] = [...this.contactEvents];
    this.physicsWorld.drainContactEvents((event: Physics2DBackendContactEvent) => {
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

function contactKey(bodyA: Physics2DBodyHandle, bodyB: Physics2DBodyHandle): string { return `${bodyA}:${bodyB}`; }
function contactEvent(tick: number, phase: Physics2DContactEvent['phase'], entityA: Entity, entityB: Entity, sensor: boolean): Physics2DContactEvent {
  return Object.freeze({ tick, phase, kind: sensor ? 'trigger' : 'collision', entityA, entityB });
}
function compareContactEvents(left: Physics2DContactEvent, right: Physics2DContactEvent): number {
  return left.tick - right.tick || left.entityA.id - right.entityA.id || left.entityB.id - right.entityB.id || phaseOrder(left.phase) - phaseOrder(right.phase);
}
function phaseOrder(value: Physics2DContactEvent['phase']): number { return value === 'enter' ? 0 : value === 'stay' ? 1 : 2; }

function fixtureSignature(body: Physics2DBody): string {
  return [
    body.shape,
    body.width,
    body.height,
    body.radius,
    body.density,
    body.friction,
    body.restitution,
    body.isSensor,
    body.categoryBits,
    body.maskBits,
    body.groupIndex,
  ].join('|');
}

function jointSignature(
  joint: Physics2DJoint,
  bodyA: Physics2DBodyHandle,
  bodyB: Physics2DBodyHandle,
): string {
  return [
    joint.type,
    bodyA,
    bodyB,
    joint.anchor?.join(',') ?? '',
    joint.anchorA?.join(',') ?? '',
    joint.anchorB?.join(',') ?? '',
    joint.collideConnected,
    joint.enableLimit,
    joint.lowerAngle,
    joint.upperAngle,
    joint.enableMotor,
    joint.motorSpeed,
    joint.maxMotorTorque,
    joint.length ?? '',
    joint.frequencyHz,
    joint.dampingRatio,
  ].join('|');
}

function containsPhysicsBodyPoint(body: Physics2DBody, transform: Transform2D, x: number, y: number): boolean {
  const dx = x - transform.x;
  const dy = y - transform.y;
  const cos = Math.cos(-transform.rotation);
  const sin = Math.sin(-transform.rotation);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const scaleX = Math.max(0.0001, Math.abs(transform.scaleX));
  const scaleY = Math.max(0.0001, Math.abs(transform.scaleY));

  if (body.shape === 'circle') {
    const radius = body.radius * Math.max(scaleX, scaleY);
    return localX * localX + localY * localY <= radius * radius;
  }

  return Math.abs(localX) <= body.width * scaleX * 0.5
    && Math.abs(localY) <= body.height * scaleY * 0.5;
}
