import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity } from '../dist/ecs.js';
import {
  Physics3DBody,
  Physics3DBuoyancy,
  Physics3DGravitySource,
  Physics3DJoint,
} from '../dist/physics.js';
import { deserializeEntityCore, serializeEntityCore } from '../dist/serialization.js';

test('3D physics components round-trip without backend-native state', () => {
  const root = new Entity('root');
  const child = new Entity('child');
  root.addChild(child);

  const body = new Physics3DBody({
    type: 'dynamic',
    shape: 'capsule',
    radius: 0.35,
    halfHeight: 0.9,
    density: 2.5,
    ccd: true,
    lockRotations: [true, false, true],
  });
  root.addComponent(body);
  root.addComponent(new Physics3DBuoyancy({
    fluidLevel: 2,
    fluidDensity: 1.1,
    volume: 3.4,
    centerOfBuoyancy: [0, 0.2, 0],
  }));
  root.addComponent(new Physics3DGravitySource({
    strength: 64,
    softening: 0.25,
  }));
  child.addComponent(new Physics3DBody({ type: 'static', shape: 'box' }));
  child.addComponent(new Physics3DJoint({
    type: 'prismatic',
    bodyA: root,
    bodyB: child,
    axis: [0, 1, 0],
    limits: [-2, 3],
  }));

  const serialized = serializeEntityCore(root);
  const serializedBody = serialized.components.find(component => component.type === 'Physics3DBody');
  assert.equal(serializedBody.shape, 'capsule');
  assert.equal('handle' in serializedBody, false);
  assert.equal(
    serialized.components.find(component => component.type === 'Physics3DGravitySource').maxDistance,
    null,
  );

  const restored = deserializeEntityCore(serialized);
  const restoredBody = restored.getComponent(Physics3DBody);
  assert.equal(restoredBody.shape, 'capsule');
  assert.equal(restoredBody.halfHeight, 0.9);
  assert.deepEqual(restoredBody.lockRotations, [true, false, true]);
  assert.equal(restoredBody.handle, null);
  assert.equal(restored.getComponent(Physics3DBuoyancy).volume, 3.4);
  assert.equal(restored.getComponent(Physics3DGravitySource).maxDistance, Number.POSITIVE_INFINITY);

  const restoredJoint = restored.children[0].getComponent(Physics3DJoint);
  assert.equal(restoredJoint.type, 'prismatic');
  assert.deepEqual(restoredJoint.axis, [0, 1, 0]);
  assert.deepEqual(restoredJoint.limits, [-2, 3]);
  assert.equal(typeof restoredJoint.bodyA, 'number');
  assert.equal(typeof restoredJoint.bodyB, 'number');
});
