import type { Physics3DBody } from './Physics3DBody';
import type { Physics3DJoint } from './Physics3DJoint';
import type { Physics3DBodyHandle, Physics3DJointHandle } from './Physics3DBackend';

interface RuntimeBinding<THandle> {
  owner: object;
  handle: THandle;
}

const bodyHandles = new WeakMap<Physics3DBody, RuntimeBinding<Physics3DBodyHandle>>();
const jointHandles = new WeakMap<Physics3DJoint, RuntimeBinding<Physics3DJointHandle>>();

export function getPhysics3DBodyHandle(body: Physics3DBody): Physics3DBodyHandle | null {
  return bodyHandles.get(body)?.handle ?? null;
}

export function setPhysics3DBodyHandle(
  body: Physics3DBody,
  owner: object,
  handle: Physics3DBodyHandle | null,
): void {
  if (handle !== null) {
    bodyHandles.set(body, { owner, handle });
  } else if (bodyHandles.get(body)?.owner === owner) {
    bodyHandles.delete(body);
  }
}

export function getPhysics3DJointHandle(joint: Physics3DJoint): Physics3DJointHandle | null {
  return jointHandles.get(joint)?.handle ?? null;
}

export function setPhysics3DJointHandle(
  joint: Physics3DJoint,
  owner: object,
  handle: Physics3DJointHandle | null,
): void {
  if (handle !== null) {
    jointHandles.set(joint, { owner, handle });
  } else if (jointHandles.get(joint)?.owner === owner) {
    jointHandles.delete(joint);
  }
}
