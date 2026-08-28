import { box2d, type B2Body, type B2Contact, type B2Fixture, type B2Joint } from './Box2D';
import type {
  MutablePhysics2DBodyTransform,
  MutablePhysics2DVector,
  Physics2DAabbQueryDesc,
  Physics2DBackend,
  Physics2DBackendBodyDesc,
  Physics2DBackendColliderDesc,
  Physics2DBackendJointDesc,
  Physics2DBackendMouseJointDesc,
  Physics2DBackendWorldOptions,
  Physics2DBodyHandle,
  Physics2DCapabilities,
  Physics2DContactEvent,
  Physics2DJointHandle,
  Physics2DRayCastDesc,
  Physics2DRayHit,
  Physics2DVectorLike,
  Physics2DWorldDriver,
} from './Physics2DBackend';
import type { Physics2DBodyType } from './Physics2DBody';

const BOX2D_CAPABILITIES: Physics2DCapabilities = Object.freeze({
  bodyTypes: Object.freeze(['static', 'dynamic', 'kinematic'] as const),
  shapeTypes: Object.freeze(['box', 'circle'] as const),
  jointTypes: Object.freeze(['revolute', 'distance'] as const),
  continuousCollision: true,
  pointQuery: true,
  rayCast: true,
  shapeQuery: true,
  contactEvents: true,
});

interface JointRecord {
  joint: B2Joint;
  bodyA: Physics2DBodyHandle | null;
  bodyB: Physics2DBodyHandle;
}

export class Box2DPhysics2DBackend implements Physics2DBackend {
  readonly id = 'box2d';
  readonly capabilities = BOX2D_CAPABILITIES;

  createWorld(options: Physics2DBackendWorldOptions): Physics2DWorldDriver {
    return new Box2DPhysics2DWorld(options);
  }
}

export function createBox2DPhysics2DBackend(): Physics2DBackend {
  return new Box2DPhysics2DBackend();
}

class Box2DPhysics2DWorld implements Physics2DWorldDriver {
  readonly backendId = 'box2d';
  readonly capabilities = BOX2D_CAPABILITIES;

  private readonly world: InstanceType<typeof box2d.b2World>;
  private readonly mouseGroundBody: B2Body;
  private readonly bodies = new Map<Physics2DBodyHandle, B2Body>();
  private readonly bodyHandles = new Map<B2Body, Physics2DBodyHandle>();
  private readonly bodySensors = new Map<Physics2DBodyHandle, boolean>();
  private readonly joints = new Map<Physics2DJointHandle, JointRecord>();
  private readonly contactEvents: Physics2DContactEvent[] = [];
  private readonly queryPointScratch = new box2d.b2Vec2();
  private readonly rayStartScratch = new box2d.b2Vec2();
  private readonly rayEndScratch = new box2d.b2Vec2();
  private readonly queryAabbScratch = new box2d.b2AABB();
  private readonly mouseTargetScratch = new box2d.b2Vec2();
  private nextBodyHandle = 1;
  private nextJointHandle = 1;
  private destroyed = false;

  constructor(options: Physics2DBackendWorldOptions) {
    this.world = new box2d.b2World(new box2d.b2Vec2(options.gravityX, options.gravityY));
    this.mouseGroundBody = this.world.CreateBody(new box2d.b2BodyDef());
    const owner = this;
    this.world.SetContactListener(new class extends box2d.b2ContactListener {
      override BeginContact(contact: B2Contact): void { owner.captureContact(contact, true); }
      override EndContact(contact: B2Contact): void { owner.captureContact(contact, false); }
    }());
  }

  setGravity(x: number, y: number): void {
    this.world.SetGravity(new box2d.b2Vec2(x, y));
  }

  createBody(desc: Physics2DBackendBodyDesc): Physics2DBodyHandle {
    this.assertAlive();
    const definition = new box2d.b2BodyDef();
    definition.type = toBox2DBodyType(desc.type);
    definition.position.Set(desc.positionX, desc.positionY);
    definition.angle = desc.angle;
    definition.fixedRotation = desc.fixedRotation;
    definition.linearDamping = desc.linearDamping;
    definition.angularDamping = desc.angularDamping;
    definition.bullet = desc.bullet;
    definition.allowSleep = desc.allowSleep;
    const body = this.world.CreateBody(definition);
    const handle = this.nextBodyHandle++ as Physics2DBodyHandle;
    this.bodies.set(handle, body);
    this.bodyHandles.set(body, handle);
    this.bodySensors.set(handle, false);
    return handle;
  }

  hasBody(handle: Physics2DBodyHandle): boolean {
    return this.bodies.has(handle);
  }

  updateBody(handle: Physics2DBodyHandle, desc: Physics2DBackendBodyDesc): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.SetType(toBox2DBodyType(desc.type));
    body.SetFixedRotation(desc.fixedRotation);
    body.SetLinearDamping(desc.linearDamping);
    body.SetAngularDamping(desc.angularDamping);
    body.SetBullet(desc.bullet);
    body.SetSleepingAllowed(desc.allowSleep);
    return true;
  }

  destroyBody(handle: Physics2DBodyHandle): void {
    const body = this.bodies.get(handle);
    if (!body) return;
    for (const [jointHandle, record] of this.joints) {
      if (record.bodyA === handle || record.bodyB === handle) this.destroyJoint(jointHandle);
    }
    this.world.DestroyBody(body);
    this.bodyHandles.delete(body);
    this.bodySensors.delete(handle);
    this.bodies.delete(handle);
  }

  setBodyCollider(handle: Physics2DBodyHandle, desc: Physics2DBackendColliderDesc): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    for (let fixture = body.GetFixtureList(); fixture;) {
      const next = fixture.GetNext();
      body.DestroyFixture(fixture);
      fixture = next;
    }
    const definition = new box2d.b2FixtureDef();
    if (desc.shape === 'circle') {
      definition.shape = new box2d.b2CircleShape(desc.radius);
    } else {
      const shape = new box2d.b2PolygonShape();
      shape.SetAsBox(Math.max(0.0001, desc.width * 0.5), Math.max(0.0001, desc.height * 0.5));
      definition.shape = shape;
    }
    definition.density = desc.density;
    definition.friction = desc.friction;
    definition.restitution = desc.restitution;
    definition.isSensor = desc.isSensor;
    definition.filter.categoryBits = desc.categoryBits;
    definition.filter.maskBits = desc.maskBits;
    definition.filter.groupIndex = desc.groupIndex;
    body.CreateFixture(definition);
    this.bodySensors.set(handle, desc.isSensor);
    return true;
  }

  setBodyTransform(handle: Physics2DBodyHandle, x: number, y: number, angle: number): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.SetTransformXY(x, y, angle);
    return true;
  }

  getBodyTransform(handle: Physics2DBodyHandle, out: MutablePhysics2DBodyTransform): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    const position = body.GetPosition();
    out.x = position.x;
    out.y = position.y;
    out.angle = body.GetAngle();
    return true;
  }

  getBodyLinearVelocity(handle: Physics2DBodyHandle, out: MutablePhysics2DVector): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    const velocity = body.GetLinearVelocity();
    out.x = velocity.x;
    out.y = velocity.y;
    return true;
  }

  setBodyLinearVelocity(handle: Physics2DBodyHandle, velocity: Physics2DVectorLike): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.SetLinearVelocity(velocity);
    return true;
  }

  getBodyAngularVelocity(handle: Physics2DBodyHandle): number | null {
    return this.bodies.get(handle)?.GetAngularVelocity() ?? null;
  }

  setBodyAngularVelocity(handle: Physics2DBodyHandle, velocity: number): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.SetAngularVelocity(velocity);
    return true;
  }

  getBodyMass(handle: Physics2DBodyHandle): number | null {
    return this.bodies.get(handle)?.GetMass() ?? null;
  }

  setBodyAwake(handle: Physics2DBodyHandle, awake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.SetAwake(awake);
    return true;
  }

  applyBodyForce(handle: Physics2DBodyHandle, force: Physics2DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.ApplyForceToCenter(force, wake);
    return true;
  }

  applyBodyTorque(handle: Physics2DBodyHandle, torque: number, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.ApplyTorque(torque, wake);
    return true;
  }

  applyBodyLinearImpulse(handle: Physics2DBodyHandle, impulse: Physics2DVectorLike, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.ApplyLinearImpulseToCenter(impulse, wake);
    return true;
  }

  applyBodyAngularImpulse(handle: Physics2DBodyHandle, impulse: number, wake: boolean): boolean {
    const body = this.bodies.get(handle);
    if (!body) return false;
    body.ApplyAngularImpulse(impulse, wake);
    return true;
  }

  queryPoint(x: number, y: number, visitor: (body: Physics2DBodyHandle) => boolean): void {
    this.queryPointScratch.Set(x, y);
    this.world.QueryPointAABB(null, this.queryPointScratch, (fixture: B2Fixture) => {
      if (!fixture.TestPoint(this.queryPointScratch)) return true;
      const handle = this.bodyHandles.get(fixture.GetBody());
      return handle === undefined ? true : visitor(handle);
    });
  }

  castRay(desc: Physics2DRayCastDesc): Physics2DRayHit | null {
    const length = Math.hypot(desc.direction.x, desc.direction.y);
    if (!(length > 0) || !(desc.maxDistance > 0)) return null;
    const dx = desc.direction.x / length;
    const dy = desc.direction.y / length;
    this.rayStartScratch.Set(desc.origin.x, desc.origin.y);
    this.rayEndScratch.Set(desc.origin.x + dx * desc.maxDistance, desc.origin.y + dy * desc.maxDistance);
    let result: Physics2DRayHit | null = null;
    this.world.RayCast(null, this.rayStartScratch, this.rayEndScratch, (fixture: B2Fixture, point, normal, fraction) => {
      if (!matchesFilter(fixture, desc.categoryBits, desc.maskBits)) return -1;
      const body = this.bodyHandles.get(fixture.GetBody());
      if (body === undefined) return -1;
      result = {
        body,
        distance: desc.maxDistance * fraction,
        point: { x: point.x, y: point.y },
        normal: { x: normal.x, y: normal.y },
      };
      return fraction;
    });
    return result;
  }

  queryAabb(desc: Physics2DAabbQueryDesc, visitor: (body: Physics2DBodyHandle) => boolean): void {
    if (desc.maximum.x < desc.minimum.x || desc.maximum.y < desc.minimum.y) return;
    this.queryAabbScratch.lowerBound.Set(desc.minimum.x, desc.minimum.y);
    this.queryAabbScratch.upperBound.Set(desc.maximum.x, desc.maximum.y);
    const visited = new Set<Physics2DBodyHandle>();
    this.world.QueryAABB(null, this.queryAabbScratch, (fixture: B2Fixture) => {
      if (!matchesFilter(fixture, desc.categoryBits, desc.maskBits)) return true;
      const body = this.bodyHandles.get(fixture.GetBody());
      if (body === undefined || visited.has(body)) return true;
      visited.add(body);
      return visitor(body);
    });
  }

  drainContactEvents(visitor: (event: Physics2DContactEvent) => void): void {
    for (const event of this.contactEvents.splice(0)) visitor(event);
  }

  createJoint(desc: Physics2DBackendJointDesc): Physics2DJointHandle | null {
    const bodyA = this.bodies.get(desc.bodyA);
    const bodyB = this.bodies.get(desc.bodyB);
    if (!bodyA || !bodyB) return null;
    let joint: B2Joint;
    if (desc.type === 'distance') {
      const definition = new box2d.b2DistanceJointDef();
      const positionA = bodyA.GetPosition();
      const positionB = bodyB.GetPosition();
      definition.Initialize(
        bodyA,
        bodyB,
        new box2d.b2Vec2(desc.anchorAX ?? positionA.x, desc.anchorAY ?? positionA.y),
        new box2d.b2Vec2(desc.anchorBX ?? positionB.x, desc.anchorBY ?? positionB.y),
      );
      if (desc.length !== undefined) definition.length = desc.length;
      definition.frequencyHz = desc.frequencyHz;
      definition.dampingRatio = desc.dampingRatio;
      definition.collideConnected = desc.collideConnected;
      joint = this.world.CreateJoint(definition);
    } else {
      const definition = new box2d.b2RevoluteJointDef();
      const positionA = bodyA.GetPosition();
      const positionB = bodyB.GetPosition();
      definition.Initialize(
        bodyA,
        bodyB,
        new box2d.b2Vec2(
          desc.anchorX ?? (positionA.x + positionB.x) * 0.5,
          desc.anchorY ?? (positionA.y + positionB.y) * 0.5,
        ),
      );
      definition.collideConnected = desc.collideConnected;
      definition.enableLimit = desc.enableLimit;
      definition.lowerAngle = desc.lowerAngle;
      definition.upperAngle = desc.upperAngle;
      definition.enableMotor = desc.enableMotor;
      definition.motorSpeed = desc.motorSpeed;
      definition.maxMotorTorque = desc.maxMotorTorque;
      joint = this.world.CreateJoint(definition);
    }
    return this.storeJoint(joint, desc.bodyA, desc.bodyB);
  }

  createMouseJoint(desc: Physics2DBackendMouseJointDesc): Physics2DJointHandle | null {
    const body = this.bodies.get(desc.body);
    if (!body) return null;
    const definition = new box2d.b2MouseJointDef();
    definition.bodyA = this.mouseGroundBody;
    definition.bodyB = body;
    definition.target.Set(desc.targetX, desc.targetY);
    definition.maxForce = desc.maxForce;
    definition.frequencyHz = desc.frequencyHz;
    definition.dampingRatio = desc.dampingRatio;
    body.SetAwake(true);
    return this.storeJoint(this.world.CreateJoint(definition), null, desc.body);
  }

  hasJoint(handle: Physics2DJointHandle): boolean {
    return this.joints.has(handle);
  }

  updateMouseJoint(handle: Physics2DJointHandle, targetX: number, targetY: number): boolean {
    const joint = this.joints.get(handle)?.joint;
    if (!joint?.SetTarget) return false;
    this.mouseTargetScratch.Set(targetX, targetY);
    joint.SetTarget(this.mouseTargetScratch);
    return true;
  }

  destroyJoint(handle: Physics2DJointHandle): void {
    const record = this.joints.get(handle);
    if (!record) return;
    this.world.DestroyJoint(record.joint);
    this.joints.delete(handle);
  }

  step(timeStep: number, velocityIterations: number, positionIterations: number): void {
    this.world.Step(timeStep, velocityIterations, positionIterations);
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const handle of [...this.joints.keys()]) this.destroyJoint(handle);
    for (const handle of [...this.bodies.keys()]) this.destroyBody(handle);
    this.world.DestroyBody(this.mouseGroundBody);
    this.contactEvents.length = 0;
    this.bodySensors.clear();
    this.destroyed = true;
  }

  private captureContact(contact: B2Contact, started: boolean): void {
    const fixtureA = contact.GetFixtureA();
    const fixtureB = contact.GetFixtureB();
    const bodyA = this.bodyHandles.get(fixtureA.GetBody());
    const bodyB = this.bodyHandles.get(fixtureB.GetBody());
    if (bodyA === undefined || bodyB === undefined || bodyA === bodyB) return;
    this.contactEvents.push(Object.freeze({
      bodyA: bodyA < bodyB ? bodyA : bodyB,
      bodyB: bodyA < bodyB ? bodyB : bodyA,
      started,
      sensor: fixtureA.IsSensor() || fixtureB.IsSensor(),
    }));
  }

  private storeJoint(
    joint: B2Joint,
    bodyA: Physics2DBodyHandle | null,
    bodyB: Physics2DBodyHandle,
  ): Physics2DJointHandle {
    const handle = this.nextJointHandle++ as Physics2DJointHandle;
    this.joints.set(handle, { joint, bodyA, bodyB });
    return handle;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('Cannot use a destroyed Box2D physics world.');
  }
}

function matchesFilter(fixture: B2Fixture, categoryBits = 0xffff, maskBits = 0xffff): boolean {
  const filter = fixture.GetFilterData();
  return (filter.categoryBits & maskBits) !== 0 && (categoryBits & filter.maskBits) !== 0;
}

function toBox2DBodyType(type: Physics2DBodyType): number {
  if (type === 'dynamic') return box2d.b2BodyType.b2_dynamicBody;
  if (type === 'kinematic') return box2d.b2BodyType.b2_kinematicBody;
  return box2d.b2BodyType.b2_staticBody;
}
