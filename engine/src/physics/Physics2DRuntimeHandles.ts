import type { Physics2DBody } from './Physics2DBody';
import type { Physics2DJoint } from './Physics2DJoint';
import type { Physics2DBodyHandle, Physics2DJointHandle } from './Physics2DBackend';

interface RuntimeBinding<THandle> {
  owner: object;
  handle: THandle;
}

const bodyHandles = new WeakMap<Physics2DBody, RuntimeBinding<Physics2DBodyHandle>>();
const jointHandles = new WeakMap<Physics2DJoint, RuntimeBinding<Physics2DJointHandle>>();

export function getPhysics2DBodyHandle(body: Physics2DBody): Physics2DBodyHandle | null {
  return bodyHandles.get(body)?.handle ?? null;
}

export function setPhysics2DBodyHandle(
  body: Physics2DBody,
  owner: object,
  handle: Physics2DBodyHandle | null,
): void {
  if (handle !== null) {
    bodyHandles.set(body, { owner, handle });
  } else if (bodyHandles.get(body)?.owner === owner) {
    bodyHandles.delete(body);
  }
}

export function getPhysics2DJointHandle(joint: Physics2DJoint): Physics2DJointHandle | null {
  return jointHandles.get(joint)?.handle ?? null;
}

export function setPhysics2DJointHandle(
  joint: Physics2DJoint,
  owner: object,
  handle: Physics2DJointHandle | null,
): void {
  if (handle !== null) {
    jointHandles.set(joint, { owner, handle });
  } else if (jointHandles.get(joint)?.owner === owner) {
    jointHandles.delete(joint);
  }
}
