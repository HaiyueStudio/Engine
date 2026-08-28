declare module 'box2d.ts/dist/box2d.umd.js' {
  export class b2Vec2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    Set(x: number, y: number): void;
  }

  export class b2Shape {}

  export class b2CircleShape extends b2Shape {
    constructor(radius?: number);
  }

  export class b2PolygonShape extends b2Shape {
    SetAsBox(halfWidth: number, halfHeight: number): void;
  }

  export interface b2Fixture {
    TestPoint(point: b2Vec2): boolean;
    GetBody(): b2Body;
    GetNext(): b2Fixture | null;
    IsSensor(): boolean;
    GetFilterData(): { categoryBits: number; maskBits: number; groupIndex: number };
  }

  export class b2Contact {
    GetFixtureA(): b2Fixture;
    GetFixtureB(): b2Fixture;
  }

  export class b2ContactListener {
    BeginContact(contact: b2Contact): void;
    EndContact(contact: b2Contact): void;
  }

  export class b2Body {
    SetType(type: number): void;
    SetFixedRotation(fixed: boolean): void;
    SetLinearDamping(damping: number): void;
    SetAngularDamping(damping: number): void;
    SetBullet(bullet: boolean): void;
    SetSleepingAllowed(allowed: boolean): void;
    SetTransformXY(x: number, y: number, angle: number): void;
    SetAwake(awake: boolean): void;
    GetFixtureList(): b2Fixture | null;
    DestroyFixture(fixture: b2Fixture): void;
    CreateFixture(definition: b2FixtureDef): b2Fixture;
    GetMass(): number;
    GetPosition(): b2Vec2;
    GetAngle(): number;
    GetLinearVelocity(): b2Vec2;
    GetAngularVelocity(): number;
    GetWorldCenter(): b2Vec2;
    ApplyForceToCenter(force: { x: number; y: number }, wake: boolean): void;
    ApplyTorque(torque: number, wake: boolean): void;
    ApplyLinearImpulseToCenter(impulse: { x: number; y: number }, wake: boolean): void;
    ApplyAngularImpulse(impulse: number, wake: boolean): void;
    SetLinearVelocity(velocity: { x: number; y: number }): void;
    SetAngularVelocity(velocity: number): void;
  }

  export class b2Joint {
    SetTarget?(target: b2Vec2): void;
  }

  export class b2BodyDef {
    type: number;
    position: b2Vec2;
    angle: number;
    fixedRotation: boolean;
    linearDamping: number;
    angularDamping: number;
    bullet: boolean;
    allowSleep: boolean;
  }

  export class b2FixtureDef {
    shape: b2Shape | null;
    density: number;
    friction: number;
    restitution: number;
    isSensor: boolean;
    filter: { categoryBits: number; maskBits: number; groupIndex: number };
  }

  export class b2MouseJointDef {
    bodyA: b2Body | null;
    bodyB: b2Body | null;
    target: b2Vec2;
    maxForce: number;
    frequencyHz: number;
    dampingRatio: number;
  }

  export class b2RevoluteJointDef {
    collideConnected: boolean;
    enableLimit: boolean;
    lowerAngle: number;
    upperAngle: number;
    enableMotor: boolean;
    motorSpeed: number;
    maxMotorTorque: number;
    Initialize(bodyA: b2Body, bodyB: b2Body, anchor: b2Vec2): void;
  }

  export class b2DistanceJointDef {
    length: number;
    frequencyHz: number;
    dampingRatio: number;
    collideConnected: boolean;
    Initialize(bodyA: b2Body, bodyB: b2Body, anchorA: b2Vec2, anchorB: b2Vec2): void;
  }

  export class b2World {
    constructor(gravity: b2Vec2);
    CreateBody(definition: b2BodyDef): b2Body;
    DestroyBody(body: b2Body): void;
    CreateJoint(definition: b2MouseJointDef | b2RevoluteJointDef | b2DistanceJointDef): b2Joint;
    DestroyJoint(joint: b2Joint): void;
    SetGravity(gravity: b2Vec2): void;
    QueryPointAABB(aabb: null, point: b2Vec2, callback: (fixture: b2Fixture) => boolean): void;
    QueryAABB(callback: null, aabb: b2AABB, fn: (fixture: b2Fixture) => boolean): void;
    RayCast(callback: null, point1: b2Vec2, point2: b2Vec2, fn: (fixture: b2Fixture, point: b2Vec2, normal: b2Vec2, fraction: number) => number): void;
    SetContactListener(listener: b2ContactListener): void;
    Step(timeStep: number, velocityIterations: number, positionIterations: number): void;
  }

  export class b2AABB {
    lowerBound: b2Vec2;
    upperBound: b2Vec2;
  }

  export const b2BodyType: {
    readonly b2_staticBody: number;
    readonly b2_kinematicBody: number;
    readonly b2_dynamicBody: number;
  };
}
