import assert from 'node:assert/strict';
import test from 'node:test';
import { CartesianTransform3D, Transform3D } from '../dist/components.js';
import { Entity, World } from '../dist/ecs.js';
import {
  Physics3DBody,
  Physics3DBuoyancy,
  Physics3DBuoyancySystem,
  Physics3DJoint,
  Physics3DSystem,
} from '../dist/physics.js';
import { createRapierPhysics3DBackend } from '../dist/physics/backend.js';

const capabilities = Object.freeze({
  bodyTypes: Object.freeze(['static', 'dynamic', 'kinematic']),
  shapeTypes: Object.freeze(['box', 'sphere', 'capsule', 'cylinder']),
  jointTypes: Object.freeze(['fixed', 'spherical', 'revolute', 'prismatic', 'spring', 'rope']),
  continuousCollision: true,
  rayCast: true,
  forceAtPoint: true,
  dragConstraint: true,
});

function createRecordingBackend(log) {
  const bodies = new Map();
  const joints = new Set();
  const drags = new Set();
  let nextBody = 10;
  let nextJoint = 20;
  let nextDrag = 30;
  const driver = {
    backendId: 'recording-3d',
    capabilities,
    setGravity(x, y, z) { log.push(['gravity', x, y, z]); },
    createBody(desc) {
      const handle = nextBody++;
      bodies.set(handle, {
        transform: {
          position: { ...desc.position },
          rotation: { ...desc.rotation },
        },
        linearVelocity: { x: 0, y: 0, z: 0 },
        angularVelocity: { x: 0, y: 0, z: 0 },
        mass: desc.type === 'dynamic' ? 2 : 0,
      });
      log.push(['createBody', handle, structuredClone(desc)]);
      return handle;
    },
    hasBody(handle) { return bodies.has(handle); },
    updateBody(handle, desc) { log.push(['updateBody', handle, structuredClone(desc)]); return bodies.has(handle); },
    destroyBody(handle) { log.push(['destroyBody', handle]); bodies.delete(handle); },
    setBodyCollider(handle, desc) { log.push(['collider', handle, { ...desc }]); return bodies.has(handle); },
    setBodyTransform(handle, position, rotation) {
      const state = bodies.get(handle);
      if (!state) return false;
      state.transform = { position: { ...position }, rotation: { ...rotation } };
      return true;
    },
    getBodyTransform(handle, out) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(out.position, state.transform.position);
      Object.assign(out.rotation, state.transform.rotation);
      return true;
    },
    getBodyLinearVelocity(handle, out) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(out, state.linearVelocity);
      return true;
    },
    setBodyLinearVelocity(handle, velocity) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(state.linearVelocity, velocity);
      return true;
    },
    getBodyAngularVelocity(handle, out) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(out, state.angularVelocity);
      return true;
    },
    setBodyAngularVelocity(handle, velocity) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(state.angularVelocity, velocity);
      return true;
    },
    getBodyMass(handle) { return bodies.get(handle)?.mass ?? null; },
    setBodyAwake(handle, awake) { log.push(['awake', handle, awake]); return bodies.has(handle); },
    applyBodyForce(handle, force, wake) { log.push(['force', handle, { ...force }, wake]); return bodies.has(handle); },
    applyBodyForceAtPoint(handle, force, point, wake) {
      log.push(['forceAtPoint', handle, { ...force }, { ...point }, wake]);
      return bodies.has(handle);
    },
    applyBodyTorque(handle, torque, wake) { log.push(['torque', handle, { ...torque }, wake]); return bodies.has(handle); },
    applyBodyLinearImpulse(handle, impulse, wake) { log.push(['impulse', handle, { ...impulse }, wake]); return bodies.has(handle); },
    applyBodyAngularImpulse(handle, impulse, wake) { log.push(['angularImpulse', handle, { ...impulse }, wake]); return bodies.has(handle); },
    castRay(desc) {
      const body = bodies.keys().next().value;
      if (body === undefined) return null;
      return {
        body,
        distance: 2,
        point: {
          x: desc.origin.x + desc.direction.x * 2,
          y: desc.origin.y + desc.direction.y * 2,
          z: desc.origin.z + desc.direction.z * 2,
        },
        normal: { x: 0, y: 1, z: 0 },
      };
    },
    createJoint(desc) {
      const handle = nextJoint++;
      joints.add(handle);
      log.push(['createJoint', handle, structuredClone(desc)]);
      return handle;
    },
    hasJoint(handle) { return joints.has(handle); },
    destroyJoint(handle) { log.push(['destroyJoint', handle]); joints.delete(handle); },
    createDragConstraint(desc) {
      const handle = nextDrag++;
      drags.add(handle);
      log.push(['createDrag', handle, structuredClone(desc)]);
      return handle;
    },
    updateDragConstraint(handle, target) {
      log.push(['updateDrag', handle, { ...target }]);
      return drags.has(handle);
    },
    destroyDragConstraint(handle) { log.push(['destroyDrag', handle]); drags.delete(handle); },
    step(timeStep) { log.push(['step', timeStep]); },
    destroy() { log.push(['destroyWorld']); bodies.clear(); joints.clear(); drags.clear(); },
  };
  return {
    backend: {
      id: 'recording-3d',
      capabilities,
      createWorld(options) {
        log.push(['createWorld', structuredClone(options)]);
        return driver;
      },
    },
    bodies,
  };
}

function transformAt(x, y, z) {
  const matrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
  const transform = new Transform3D();
  transform.setMatrix(matrix);
  return transform;
}

test('Physics3DSystem drives an injected backend through opaque handles', () => {
  const log = [];
  const recording = createRecordingBackend(log);
  const physics = new Physics3DSystem({
    backend: recording.backend,
    gravity: [0, -9.81, 0],
    fixedTimeStep: 1 / 60,
  });
  const world = new World('physics3d-adapter');
  const entity = new Entity('body');
  const transform = transformAt(1, 2, 3);
  const body = new Physics3DBody({
    type: 'dynamic',
    shape: 'capsule',
    radius: 0.4,
    halfHeight: 0.8,
  });
  entity.addComponent(transform);
  entity.addComponent(body);
  world.addSystem(physics);
  world.addEntity(entity);

  assert.equal(body.handle, null);
  assert.equal('body' in body, false);
  world.update(0, 0);

  assert.equal(physics.backendId, 'recording-3d');
  assert.equal(typeof body.handle, 'number');
  assert.deepEqual(log[0], ['createWorld', {
    gravity: { x: 0, y: -9.81, z: 0 },
    solverIterations: 6,
  }]);
  assert.equal(log.find(entry => entry[0] === 'createBody')[2].position.y, 2);
  assert.equal(log.find(entry => entry[0] === 'collider')[2].shape, 'capsule');

  assert.equal(physics.applyForceAtPoint(body, [1, 2, 3], [4, 5, 6]), true);
  assert.ok(log.some(entry => entry[0] === 'forceAtPoint' && entry[2].z === 3));
  const hit = physics.castRay([0, 5, 0], [0, -1, 0], 20);
  assert.equal(hit?.entity, entity);
  assert.deepEqual(hit?.point, [0, 3, 0]);

  const drag = physics.createDragConstraint(body, [1, 2, 3], [2, 3, 4]);
  assert.equal(typeof drag, 'number');
  assert.equal(physics.updateDragConstraint(drag, [3, 4, 5]), true);
  physics.destroyDragConstraint(drag);

  recording.bodies.get(body.handle).transform.position = { x: 4, y: 5, z: 6 };
  world.update(20, 20);
  assert.equal(transform.localMatrix[12], 4);
  assert.equal(transform.localMatrix[13], 5);
  assert.equal(transform.localMatrix[14], 6);
  assert.ok(log.some(entry => entry[0] === 'step'));

  world.removeEntity(entity);
  world.update(40, 0);
  assert.equal(body.handle, null);
  assert.ok(log.some(entry => entry[0] === 'destroyBody'));
});

test('Physics3DJoint remains backend-neutral and recreates changed constraints', () => {
  const log = [];
  const recording = createRecordingBackend(log);
  const physics = new Physics3DSystem({ backend: recording.backend, gravity: [0, 0, 0] });
  const world = new World('physics3d-joints');
  world.addSystem(physics);

  const entityA = new Entity('a');
  entityA.addComponent(transformAt(0, 0, 0));
  entityA.addComponent(new Physics3DBody({ type: 'static' }));
  world.addEntity(entityA);

  const entityB = new Entity('b');
  entityB.addComponent(transformAt(0, -2, 0));
  entityB.addComponent(new Physics3DBody());
  world.addEntity(entityB);

  const jointEntity = new Entity('spring');
  const joint = new Physics3DJoint({
    type: 'spring',
    bodyA: entityA,
    bodyB: entityB,
    restLength: 2,
    stiffness: 30,
    damping: 3,
  });
  jointEntity.addComponent(joint);
  world.addEntity(jointEntity);
  world.update(0, 0);

  const firstHandle = joint.handle;
  assert.equal(typeof firstHandle, 'number');
  assert.equal('joint' in joint, false);
  assert.equal(log.filter(entry => entry[0] === 'createJoint').length, 1);
  assert.equal(log.find(entry => entry[0] === 'createJoint')[2].restLength, 2);

  joint.restLength = 3;
  world.update(1, 0);
  assert.notEqual(joint.handle, firstHandle);
  assert.equal(log.filter(entry => entry[0] === 'createJoint').length, 2);
  assert.equal(log.filter(entry => entry[0] === 'createJoint')[1][2].restLength, 3);
});

test('Rapier adapter initializes without the upstream deprecated WASM parameter warning', async () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let backend;
  try {
    backend = await createRapierPhysics3DBackend();
  } finally {
    console.warn = warn;
  }

  assert.equal(backend.id, 'rapier3d');
  assert.equal(warnings.some(args => args.includes(
    'using deprecated parameters for the initialization function; pass a single object instead',
  )), false);
});

test('Rapier adapter simulates a falling sphere and resolves ground contact', async () => {
  const backend = await createRapierPhysics3DBackend();
  assert.equal(backend.id, 'rapier3d');
  assert.equal(backend.capabilities.jointTypes.includes('spring'), true);

  const physics = new Physics3DSystem({
    backend,
    gravity: [0, -9.81, 0],
    fixedTimeStep: 1 / 60,
    maxSubSteps: 2,
  });
  const world = new World('rapier3d-integration');
  world.addSystem(physics);

  const ground = new Entity('ground');
  ground.addComponent(transformAt(0, -0.25, 0));
  ground.addComponent(new Physics3DBody({
    type: 'static',
    shape: 'box',
    width: 10,
    height: 0.5,
    depth: 10,
  }));
  world.addEntity(ground);

  const ball = new Entity('ball');
  const ballTransform = new CartesianTransform3D({ position: [0, 3, 0] });
  const ballBody = new Physics3DBody({
    type: 'dynamic',
    shape: 'sphere',
    radius: 0.5,
    restitution: 0,
  });
  ball.addComponent(ballTransform);
  ball.addComponent(ballBody);
  world.addEntity(ball);

  world.update(0, 0);
  for (let frame = 1; frame <= 180; frame++) world.update(frame * (1000 / 60), 1000 / 60);

  assert.equal(physics.hasBody(ballBody), true);
  assert.ok(ballTransform.localMatrix[13] > 0.45);
  assert.ok(ballTransform.localMatrix[13] < 0.56);
  assert.ok(ballTransform.position[1] > 0.45);
  assert.ok(ballTransform.position[1] < 0.56);
  const hit = physics.castRay([0, 5, 0], [0, -1, 0], 10);
  assert.equal(hit?.entity, ball);
  physics.destroy();
});

test('Rapier exposes deterministic trigger phases, shape queries and teardown counts', async () => {
  const backend = await createRapierPhysics3DBackend();
  const physics = new Physics3DSystem({ backend, gravity: [0, 0, 0], fixedTimeStep: 1 / 60, maxSubSteps: 1 });
  const world = new World('rapier-g07-events');
  world.addSystem(physics);
  const target = new Entity('target');
  target.addComponent(transformAt(0, 0, 0));
  target.addComponent(new Physics3DBody({ type: 'static', shape: 'box', width: 2, height: 2, depth: 2, isSensor: true }));
  world.addEntity(target);
  const projectile = new Entity('projectile');
  const projectileBody = new Physics3DBody({ type: 'dynamic', shape: 'sphere', radius: 0.25, allowSleep: false });
  projectile.addComponent(transformAt(0, 0, 0));
  projectile.addComponent(projectileBody);
  world.addEntity(projectile);

  world.update(0, 0);
  world.update(1000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => [event.phase, event.kind, event.entityA.name, event.entityB.name]), [['enter', 'trigger', 'target', 'projectile']]);
  world.update(2000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => event.phase), ['stay']);
  assert.deepEqual(physics.queryShape({ type: 'sphere', position: [0, 0, 0], radius: 1 }).map(entity => entity.name), ['target', 'projectile']);
  assert.deepEqual(physics.resourceSnapshot(), { backendId: 'rapier3d', bodies: 2, colliders: 2, joints: 0, activeContacts: 1 });

  physics.teleportBody(projectileBody, [5, 0, 0]);
  world.update(3000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => event.phase), ['exit']);
  physics.destroy();
  assert.deepEqual(physics.resourceSnapshot(), { backendId: 'rapier3d', bodies: 0, colliders: 0, joints: 0, activeContacts: 0 });
});

test('Rapier adapter creates every advertised joint and applies drag forces', async () => {
  const backend = await createRapierPhysics3DBackend();
  const driver = backend.createWorld({
    gravity: { x: 0, y: 0, z: 0 },
    solverIterations: 6,
  });
  const bodyDesc = (type, x) => ({
    type,
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccd: false,
    allowSleep: false,
    lockTranslations: [false, false, false],
    lockRotations: [false, false, false],
  });
  const anchor = driver.createBody(bodyDesc('static', 0));
  const body = driver.createBody(bodyDesc('dynamic', 1));
  driver.setBodyCollider(body, {
    shape: 'sphere',
    width: 1,
    height: 1,
    depth: 1,
    radius: 0.5,
    halfHeight: 0,
    density: 1,
    friction: 0.5,
    restitution: 0,
    isSensor: false,
    categoryBits: 1,
    maskBits: 0xffff,
  });
  const base = {
    bodyA: anchor,
    bodyB: body,
    anchorA: { x: 0, y: 0, z: 0 },
    anchorB: { x: -1, y: 0, z: 0 },
    collideConnected: false,
  };
  const descriptions = [
    {
      ...base,
      type: 'fixed',
      frameA: { x: 0, y: 0, z: 0, w: 1 },
      frameB: { x: 0, y: 0, z: 0, w: 1 },
    },
    { ...base, type: 'spherical' },
    { ...base, type: 'revolute', axis: { x: 0, y: 0, z: 1 }, limits: [-0.5, 0.5] },
    { ...base, type: 'prismatic', axis: { x: 1, y: 0, z: 0 }, limits: [-1, 1] },
    { ...base, type: 'spring', restLength: 1, stiffness: 20, damping: 2 },
    { ...base, type: 'rope', maxLength: 1.5 },
  ];
  const handles = descriptions.map(description => driver.createJoint(description));
  assert.equal(handles.every(handle => handle !== null && driver.hasJoint(handle)), true);
  for (const handle of handles) driver.destroyJoint(handle);

  const drag = driver.createDragConstraint({
    body,
    localAnchor: { x: 0, y: 0, z: 0 },
    target: { x: 3, y: 0, z: 0 },
    stiffness: 30,
    damping: 2,
    maxForce: 100,
  });
  assert.notEqual(drag, null);
  for (let step = 0; step < 12; step++) driver.step(1 / 60);
  const transform = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
  assert.equal(driver.getBodyTransform(body, transform), true);
  assert.ok(transform.position.x > 1);
  for (let step = 12; step < 240; step++) driver.step(1 / 60);
  const velocity = { x: 0, y: 0, z: 0 };
  driver.getBodyTransform(body, transform);
  driver.getBodyLinearVelocity(body, velocity);
  assert.ok(Math.abs(transform.position.x - 3) < 0.05);
  assert.ok(Math.abs(velocity.x) < 0.05);
  driver.destroy();
});

test('Rapier adapter clears forces and torques after each simulation step', async () => {
  const backend = await createRapierPhysics3DBackend();
  const driver = backend.createWorld({
    gravity: { x: 0, y: 0, z: 0 },
    solverIterations: 6,
  });
  const body = driver.createBody({
    type: 'dynamic',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linearDamping: 0,
    angularDamping: 0,
    gravityScale: 1,
    ccd: false,
    allowSleep: false,
    lockTranslations: [false, false, false],
    lockRotations: [false, false, false],
  });
  driver.setBodyCollider(body, {
    shape: 'sphere',
    width: 1,
    height: 1,
    depth: 1,
    radius: 0.5,
    halfHeight: 0,
    density: 1,
    friction: 0.5,
    restitution: 0,
    isSensor: false,
    categoryBits: 1,
    maskBits: 0xffff,
  });

  driver.applyBodyForce(body, { x: 1, y: 0, z: 0 }, true);
  driver.applyBodyTorque(body, { x: 0, y: 1, z: 0 }, true);
  driver.step(1 / 60);
  const linearAfterForce = { x: 0, y: 0, z: 0 };
  const angularAfterTorque = { x: 0, y: 0, z: 0 };
  driver.getBodyLinearVelocity(body, linearAfterForce);
  driver.getBodyAngularVelocity(body, angularAfterTorque);

  for (let step = 0; step < 59; step++) driver.step(1 / 60);
  const linearAfterCoast = { x: 0, y: 0, z: 0 };
  const angularAfterCoast = { x: 0, y: 0, z: 0 };
  driver.getBodyLinearVelocity(body, linearAfterCoast);
  driver.getBodyAngularVelocity(body, angularAfterCoast);

  assert.ok(linearAfterForce.x > 0);
  assert.ok(angularAfterTorque.y > 0);
  assert.ok(Math.abs(linearAfterCoast.x - linearAfterForce.x) < 1e-5);
  assert.ok(Math.abs(angularAfterCoast.y - angularAfterTorque.y) < 1e-5);
  driver.destroy();
});

test('Rapier buoyancy settles a low-density body near the fluid surface', async () => {
  const backend = await createRapierPhysics3DBackend();
  const physics = new Physics3DSystem({
    backend,
    gravity: [0, -9.81, 0],
    fixedTimeStep: 1 / 60,
    maxSubSteps: 2,
  });
  const world = new World('rapier3d-buoyancy');
  world.addSystem(new Physics3DBuoyancySystem(physics));
  world.addSystem(physics);

  const entity = new Entity('floating ball');
  const transform = transformAt(0, 2, 0);
  const body = new Physics3DBody({
    type: 'dynamic',
    shape: 'sphere',
    radius: 0.5,
    density: 0.5,
    linearDamping: 0.08,
  });
  entity.addComponent(transform);
  entity.addComponent(body);
  entity.addComponent(new Physics3DBuoyancy({
    fluidLevel: 0,
    linearDrag: 3,
    angularDrag: 1,
  }));
  world.addEntity(entity);

  world.update(0, 0);
  for (let frame = 1; frame <= 600; frame++) {
    world.update(frame * (1000 / 60), 1000 / 60);
  }

  assert.ok(transform.localMatrix[13] > -0.4);
  assert.ok(transform.localMatrix[13] < 0.4);
  const velocity = { x: 0, y: 0, z: 0 };
  assert.equal(physics.getLinearVelocity(body, velocity), true);
  assert.ok(Math.abs(velocity.y) < 0.2);
  physics.destroy();
});
