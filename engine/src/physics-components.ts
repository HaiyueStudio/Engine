/**
 * Backend-free physics component surface for editors, serializers, and tools.
 *
 * Importing this path must not evaluate Box2D/Rapier or a physics System.
 */
export { Physics2DBody } from './physics/Physics2DBody';
export type {
  Physics2DBodyOptions,
  Physics2DBodyType,
  Physics2DShapeType,
} from './physics/Physics2DBody';
export { Physics2DJoint } from './physics/Physics2DJoint';
export type {
  Physics2DJointOptions,
  Physics2DJointTarget,
  Physics2DJointType,
} from './physics/Physics2DJoint';
export { Physics2DTo3DTransformSync } from './components/Physics2DTo3DTransformSync';
export type {
  Physics2DTo3DPlane,
  Physics2DTo3DRotationAxis,
  Physics2DTo3DSource,
  Physics2DTo3DTransformSyncOptions,
} from './components/Physics2DTo3DTransformSync';
