/** Advanced service-provider interface for implementing or selecting a Physics2D backend. */
export { createBox2DPhysics2DBackend } from '../physics/Box2DPhysics2DBackend';
export type {
  MutablePhysics2DBodyTransform,
  MutablePhysics2DVector,
  Physics2DBackend,
  Physics2DBackendBodyDesc,
  Physics2DBackendColliderDesc,
  Physics2DBackendDistanceJointDesc,
  Physics2DBackendJointDesc,
  Physics2DBackendMouseJointDesc,
  Physics2DBackendRevoluteJointDesc,
  Physics2DBackendWorldOptions,
  Physics2DBodyHandle,
  Physics2DCapabilities,
  Physics2DJointHandle,
  Physics2DVectorLike,
  Physics2DWorldDriver,
} from '../physics/Physics2DBackend';
export type { Physics2DBodyRef, Physics2DMouseJointOptions } from '../physics/Physics2DSystem';
export type { Physics2DJointTarget } from '../physics/Physics2DJoint';
/**
 * Loads the Rapier adapter and its WASM dependency only when a 3D physics
 * world is explicitly requested. Importing the backend selection surface is
 * intentionally cheap.
 */
export async function createRapierPhysics3DBackend(): Promise<import('../physics/Physics3DBackend').Physics3DBackend> {
  const backend = await import('../physics/RapierPhysics3DBackend');
  return backend.createRapierPhysics3DBackend();
}
export type {
  MutablePhysics3DBodyTransform,
  MutablePhysics3DQuaternion,
  MutablePhysics3DVector,
  Physics3DBackend,
  Physics3DBackendBodyDesc,
  Physics3DBackendColliderDesc,
  Physics3DBackendDragDesc,
  Physics3DBackendFixedJointDesc,
  Physics3DBackendJointDesc,
  Physics3DBackendPrismaticJointDesc,
  Physics3DBackendRevoluteJointDesc,
  Physics3DBackendRopeJointDesc,
  Physics3DBackendSphericalJointDesc,
  Physics3DBackendSpringJointDesc,
  Physics3DBackendWorldOptions,
  Physics3DBodyHandle,
  Physics3DCapabilities,
  Physics3DDragHandle,
  Physics3DJointHandle,
  Physics3DQuaternionLike,
  Physics3DRayCastDesc,
  Physics3DRayHit,
  Physics3DVectorLike,
  Physics3DWorldDriver,
} from '../physics/Physics3DBackend';
