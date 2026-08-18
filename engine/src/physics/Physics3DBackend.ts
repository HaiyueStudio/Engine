import type { Physics3DBodyType, Physics3DShapeType } from './Physics3DBody';
import type { Physics3DJointType } from './Physics3DJoint';

declare const physics3DBodyHandleBrand: unique symbol;
declare const physics3DJointHandleBrand: unique symbol;
declare const physics3DDragHandleBrand: unique symbol;

/** Backend-neutral identifier. It is valid only for the world that created it. */
export type Physics3DBodyHandle = number & { readonly [physics3DBodyHandleBrand]: true };

/** Backend-neutral identifier. It is valid only for the world that created it. */
export type Physics3DJointHandle = number & { readonly [physics3DJointHandleBrand]: true };

/** Backend-neutral identifier for a temporary pointer-drag constraint. */
export type Physics3DDragHandle = number & { readonly [physics3DDragHandleBrand]: true };

export interface Physics3DVectorLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MutablePhysics3DVector {
  x: number;
  y: number;
  z: number;
}

export interface Physics3DQuaternionLike extends Physics3DVectorLike {
  readonly w: number;
}

export interface MutablePhysics3DQuaternion extends MutablePhysics3DVector {
  w: number;
}

export interface MutablePhysics3DBodyTransform {
  position: MutablePhysics3DVector;
  rotation: MutablePhysics3DQuaternion;
}

export interface Physics3DCapabilities {
  readonly bodyTypes: readonly Physics3DBodyType[];
  readonly shapeTypes: readonly Physics3DShapeType[];
  readonly jointTypes: readonly Physics3DJointType[];
  readonly continuousCollision: boolean;
  readonly rayCast: boolean;
  readonly forceAtPoint: boolean;
  readonly dragConstraint: boolean;
}

export interface Physics3DBackendBodyDesc {
  type: Physics3DBodyType;
  position: Physics3DVectorLike;
  rotation: Physics3DQuaternionLike;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  ccd: boolean;
  allowSleep: boolean;
  lockTranslations: readonly [boolean, boolean, boolean];
  lockRotations: readonly [boolean, boolean, boolean];
}

export interface Physics3DBackendColliderDesc {
  shape: Physics3DShapeType;
  width: number;
  height: number;
  depth: number;
  radius: number;
  halfHeight: number;
  density: number;
  friction: number;
  restitution: number;
  isSensor: boolean;
  categoryBits: number;
  maskBits: number;
}

interface Physics3DBackendJointDescBase {
  bodyA: Physics3DBodyHandle;
  bodyB: Physics3DBodyHandle;
  anchorA: Physics3DVectorLike;
  anchorB: Physics3DVectorLike;
  collideConnected: boolean;
}

export interface Physics3DBackendFixedJointDesc extends Physics3DBackendJointDescBase {
  type: 'fixed';
  frameA: Physics3DQuaternionLike;
  frameB: Physics3DQuaternionLike;
}

export interface Physics3DBackendSphericalJointDesc extends Physics3DBackendJointDescBase {
  type: 'spherical';
}

export interface Physics3DBackendRevoluteJointDesc extends Physics3DBackendJointDescBase {
  type: 'revolute';
  axis: Physics3DVectorLike;
  limits: readonly [number, number] | null;
}

export interface Physics3DBackendPrismaticJointDesc extends Physics3DBackendJointDescBase {
  type: 'prismatic';
  axis: Physics3DVectorLike;
  limits: readonly [number, number] | null;
}

export interface Physics3DBackendSpringJointDesc extends Physics3DBackendJointDescBase {
  type: 'spring';
  restLength: number;
  stiffness: number;
  damping: number;
}

export interface Physics3DBackendRopeJointDesc extends Physics3DBackendJointDescBase {
  type: 'rope';
  maxLength: number;
}

export type Physics3DBackendJointDesc =
  | Physics3DBackendFixedJointDesc
  | Physics3DBackendSphericalJointDesc
  | Physics3DBackendRevoluteJointDesc
  | Physics3DBackendPrismaticJointDesc
  | Physics3DBackendSpringJointDesc
  | Physics3DBackendRopeJointDesc;

export interface Physics3DBackendDragDesc {
  body: Physics3DBodyHandle;
  localAnchor: Physics3DVectorLike;
  target: Physics3DVectorLike;
  stiffness: number;
  damping: number;
  maxForce: number;
}

export interface Physics3DRayCastDesc {
  origin: Physics3DVectorLike;
  direction: Physics3DVectorLike;
  maxDistance: number;
  solid: boolean;
  categoryBits?: number;
  maskBits?: number;
}

export interface Physics3DRayHit {
  body: Physics3DBodyHandle;
  distance: number;
  point: MutablePhysics3DVector;
  normal: MutablePhysics3DVector;
}

export interface Physics3DBackendWorldOptions {
  gravity: Physics3DVectorLike;
  solverIterations: number;
}

/**
 * Low-level contract implemented by a 3D physics adapter. ECS components and
 * systems retain only opaque handles and never backend-native objects.
 */
export interface Physics3DWorldDriver {
  readonly backendId: string;
  readonly capabilities: Physics3DCapabilities;

  setGravity(x: number, y: number, z: number): void;
  createBody(desc: Physics3DBackendBodyDesc): Physics3DBodyHandle;
  hasBody(handle: Physics3DBodyHandle): boolean;
  updateBody(handle: Physics3DBodyHandle, desc: Physics3DBackendBodyDesc): boolean;
  destroyBody(handle: Physics3DBodyHandle): void;
  setBodyCollider(handle: Physics3DBodyHandle, desc: Physics3DBackendColliderDesc): boolean;
  setBodyTransform(
    handle: Physics3DBodyHandle,
    position: Physics3DVectorLike,
    rotation: Physics3DQuaternionLike,
    wake: boolean,
    kinematic: boolean,
  ): boolean;
  getBodyTransform(handle: Physics3DBodyHandle, out: MutablePhysics3DBodyTransform): boolean;
  getBodyLinearVelocity(handle: Physics3DBodyHandle, out: MutablePhysics3DVector): boolean;
  setBodyLinearVelocity(handle: Physics3DBodyHandle, velocity: Physics3DVectorLike, wake: boolean): boolean;
  getBodyAngularVelocity(handle: Physics3DBodyHandle, out: MutablePhysics3DVector): boolean;
  setBodyAngularVelocity(handle: Physics3DBodyHandle, velocity: Physics3DVectorLike, wake: boolean): boolean;
  getBodyMass(handle: Physics3DBodyHandle): number | null;
  setBodyAwake(handle: Physics3DBodyHandle, awake: boolean): boolean;
  /** Adds a force for the next simulation step; adapters must not retain it across later steps. */
  applyBodyForce(handle: Physics3DBodyHandle, force: Physics3DVectorLike, wake: boolean): boolean;
  /** Adds a world-space point force for the next simulation step only. */
  applyBodyForceAtPoint(
    handle: Physics3DBodyHandle,
    force: Physics3DVectorLike,
    point: Physics3DVectorLike,
    wake: boolean,
  ): boolean;
  /** Adds a torque for the next simulation step; adapters must not retain it across later steps. */
  applyBodyTorque(handle: Physics3DBodyHandle, torque: Physics3DVectorLike, wake: boolean): boolean;
  applyBodyLinearImpulse(handle: Physics3DBodyHandle, impulse: Physics3DVectorLike, wake: boolean): boolean;
  applyBodyAngularImpulse(handle: Physics3DBodyHandle, impulse: Physics3DVectorLike, wake: boolean): boolean;

  castRay(desc: Physics3DRayCastDesc): Physics3DRayHit | null;

  createJoint(desc: Physics3DBackendJointDesc): Physics3DJointHandle | null;
  hasJoint(handle: Physics3DJointHandle): boolean;
  destroyJoint(handle: Physics3DJointHandle): void;

  createDragConstraint(desc: Physics3DBackendDragDesc): Physics3DDragHandle | null;
  updateDragConstraint(handle: Physics3DDragHandle, target: Physics3DVectorLike): boolean;
  destroyDragConstraint(handle: Physics3DDragHandle): void;

  step(timeStep: number): void;
  destroy(): void;
}

/** Factory contract for replaceable 3D physics implementations. */
export interface Physics3DBackend {
  readonly id: string;
  readonly capabilities: Physics3DCapabilities;
  createWorld(options: Physics3DBackendWorldOptions): Physics3DWorldDriver;
}
