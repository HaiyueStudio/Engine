import type { Physics2DBodyType, Physics2DShapeType } from './Physics2DBody';
import type { Physics2DJointType } from './Physics2DJoint';

declare const physics2DBodyHandleBrand: unique symbol;
declare const physics2DJointHandleBrand: unique symbol;

/** Backend-neutral identifier. It is valid only for the world that created it. */
export type Physics2DBodyHandle = number & { readonly [physics2DBodyHandleBrand]: true };

/** Backend-neutral identifier. It is valid only for the world that created it. */
export type Physics2DJointHandle = number & { readonly [physics2DJointHandleBrand]: true };

export interface Physics2DVectorLike {
  readonly x: number;
  readonly y: number;
}

export interface MutablePhysics2DVector {
  x: number;
  y: number;
}

export interface MutablePhysics2DBodyTransform extends MutablePhysics2DVector {
  angle: number;
}

export interface Physics2DCapabilities {
  readonly bodyTypes: readonly Physics2DBodyType[];
  readonly shapeTypes: readonly Physics2DShapeType[];
  readonly jointTypes: readonly Physics2DJointType[];
  readonly continuousCollision: boolean;
  readonly pointQuery: boolean;
  readonly contactEvents: boolean;
}

/** All lengths in backend descriptors are expressed in physics-world units (meters). */
export interface Physics2DBackendBodyDesc {
  type: Physics2DBodyType;
  positionX: number;
  positionY: number;
  angle: number;
  fixedRotation: boolean;
  linearDamping: number;
  angularDamping: number;
  bullet: boolean;
  allowSleep: boolean;
}

export interface Physics2DBackendColliderDesc {
  shape: Physics2DShapeType;
  width: number;
  height: number;
  radius: number;
  density: number;
  friction: number;
  restitution: number;
  isSensor: boolean;
  categoryBits: number;
  maskBits: number;
  groupIndex: number;
}

interface Physics2DBackendJointDescBase {
  bodyA: Physics2DBodyHandle;
  bodyB: Physics2DBodyHandle;
  collideConnected: boolean;
}

export interface Physics2DBackendRevoluteJointDesc extends Physics2DBackendJointDescBase {
  type: 'revolute';
  anchorX?: number;
  anchorY?: number;
  enableLimit: boolean;
  lowerAngle: number;
  upperAngle: number;
  enableMotor: boolean;
  motorSpeed: number;
  maxMotorTorque: number;
}

export interface Physics2DBackendDistanceJointDesc extends Physics2DBackendJointDescBase {
  type: 'distance';
  anchorAX?: number;
  anchorAY?: number;
  anchorBX?: number;
  anchorBY?: number;
  length?: number;
  frequencyHz: number;
  dampingRatio: number;
}

export type Physics2DBackendJointDesc =
  | Physics2DBackendRevoluteJointDesc
  | Physics2DBackendDistanceJointDesc;

export interface Physics2DBackendMouseJointDesc {
  body: Physics2DBodyHandle;
  targetX: number;
  targetY: number;
  maxForce: number;
  frequencyHz: number;
  dampingRatio: number;
}

export interface Physics2DBackendWorldOptions {
  gravityX: number;
  gravityY: number;
}

/**
 * Low-level contract implemented by a physics adapter. It deliberately uses
 * handles and out parameters so ECS components never retain backend objects.
 */
export interface Physics2DWorldDriver {
  readonly backendId: string;
  readonly capabilities: Physics2DCapabilities;

  setGravity(x: number, y: number): void;
  createBody(desc: Physics2DBackendBodyDesc): Physics2DBodyHandle;
  hasBody(handle: Physics2DBodyHandle): boolean;
  updateBody(handle: Physics2DBodyHandle, desc: Physics2DBackendBodyDesc): boolean;
  destroyBody(handle: Physics2DBodyHandle): void;
  setBodyCollider(handle: Physics2DBodyHandle, desc: Physics2DBackendColliderDesc): boolean;
  setBodyTransform(handle: Physics2DBodyHandle, x: number, y: number, angle: number): boolean;
  getBodyTransform(handle: Physics2DBodyHandle, out: MutablePhysics2DBodyTransform): boolean;
  getBodyLinearVelocity(handle: Physics2DBodyHandle, out: MutablePhysics2DVector): boolean;
  setBodyLinearVelocity(handle: Physics2DBodyHandle, velocity: Physics2DVectorLike): boolean;
  getBodyAngularVelocity(handle: Physics2DBodyHandle): number | null;
  setBodyAngularVelocity(handle: Physics2DBodyHandle, velocity: number): boolean;
  getBodyMass(handle: Physics2DBodyHandle): number | null;
  setBodyAwake(handle: Physics2DBodyHandle, awake: boolean): boolean;
  applyBodyForce(handle: Physics2DBodyHandle, force: Physics2DVectorLike, wake: boolean): boolean;
  applyBodyTorque(handle: Physics2DBodyHandle, torque: number, wake: boolean): boolean;
  applyBodyLinearImpulse(handle: Physics2DBodyHandle, impulse: Physics2DVectorLike, wake: boolean): boolean;
  applyBodyAngularImpulse(handle: Physics2DBodyHandle, impulse: number, wake: boolean): boolean;

  queryPoint(x: number, y: number, visitor: (body: Physics2DBodyHandle) => boolean): void;

  createJoint(desc: Physics2DBackendJointDesc): Physics2DJointHandle | null;
  createMouseJoint(desc: Physics2DBackendMouseJointDesc): Physics2DJointHandle | null;
  hasJoint(handle: Physics2DJointHandle): boolean;
  updateMouseJoint(handle: Physics2DJointHandle, targetX: number, targetY: number): boolean;
  destroyJoint(handle: Physics2DJointHandle): void;

  step(timeStep: number, velocityIterations: number, positionIterations: number): void;
  destroy(): void;
}

/** Factory contract for replaceable 2D physics implementations. */
export interface Physics2DBackend {
  readonly id: string;
  readonly capabilities: Physics2DCapabilities;
  createWorld(options: Physics2DBackendWorldOptions): Physics2DWorldDriver;
}

