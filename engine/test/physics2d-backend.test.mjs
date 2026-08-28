import assert from 'node:assert/strict';
import test from 'node:test';
import { Transform2D } from '../dist/components.js';
import { Entity, World } from '../dist/ecs.js';
import { Physics2DBody, Physics2DJoint, Physics2DSystem } from '../dist/physics.js';
import { createBox2DPhysics2DBackend } from '../dist/physics/backend.js';

const capabilities = Object.freeze({
  bodyTypes: Object.freeze(['static', 'dynamic', 'kinematic']),
  shapeTypes: Object.freeze(['box', 'circle']),
  jointTypes: Object.freeze(['revolute', 'distance']),
  continuousCollision: true,
  pointQuery: true,
  contactEvents: false,
});

function createRecordingBackend(log, firstBodyHandle = 1) {
  const bodies = new Map();
  const joints = new Set();
  let nextBody = firstBodyHandle;
  let nextJoint = 1;
  const driver = {
    backendId: 'recording-2d',
    capabilities,
    setGravity(x, y) { log.push(['gravity', x, y]); },
    createBody(desc) {
      const handle = nextBody++;
      bodies.set(handle, {
        transform: { x: desc.positionX, y: desc.positionY, angle: desc.angle },
        velocity: { x: 0, y: 0 },
        angularVelocity: 0,
        mass: desc.type === 'dynamic' ? 2 : 0,
      });
      log.push(['createBody', handle, { ...desc }]);
      return handle;
    },
    hasBody(handle) { return bodies.has(handle); },
    updateBody(handle, desc) { log.push(['updateBody', handle, { ...desc }]); return bodies.has(handle); },
    destroyBody(handle) { log.push(['destroyBody', handle]); bodies.delete(handle); },
    setBodyCollider(handle, desc) { log.push(['collider', handle, { ...desc }]); return bodies.has(handle); },
    setBodyTransform(handle, x, y, angle) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(state.transform, { x, y, angle });
      return true;
    },
    getBodyTransform(handle, out) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(out, state.transform);
      return true;
    },
    getBodyLinearVelocity(handle, out) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(out, state.velocity);
      return true;
    },
    setBodyLinearVelocity(handle, velocity) {
      const state = bodies.get(handle);
      if (!state) return false;
      Object.assign(state.velocity, velocity);
      log.push(['linearVelocity', handle, velocity.x, velocity.y]);
      return true;
    },
    getBodyAngularVelocity(handle) { return bodies.get(handle)?.angularVelocity ?? null; },
    setBodyAngularVelocity(handle, velocity) {
      const state = bodies.get(handle);
      if (!state) return false;
      state.angularVelocity = velocity;
      return true;
    },
    getBodyMass(handle) { return bodies.get(handle)?.mass ?? null; },
    setBodyAwake(handle, awake) { log.push(['awake', handle, awake]); return bodies.has(handle); },
    applyBodyForce(handle, force, wake) { log.push(['force', handle, force.x, force.y, wake]); return bodies.has(handle); },
    applyBodyTorque(handle, torque, wake) { log.push(['torque', handle, torque, wake]); return bodies.has(handle); },
    applyBodyLinearImpulse(handle, impulse, wake) { log.push(['impulse', handle, impulse.x, impulse.y, wake]); return bodies.has(handle); },
    applyBodyAngularImpulse(handle, impulse, wake) { log.push(['angularImpulse', handle, impulse, wake]); return bodies.has(handle); },
    queryPoint(_x, _y, visitor) { for (const handle of bodies.keys()) if (!visitor(handle)) break; },
    createJoint(desc) { const handle = nextJoint++; joints.add(handle); log.push(['createJoint', handle, { ...desc }]); return handle; },
    createMouseJoint() { const handle = nextJoint++; joints.add(handle); return handle; },
    hasJoint(handle) { return joints.has(handle); },
    updateMouseJoint(handle) { return joints.has(handle); },
    destroyJoint(handle) { joints.delete(handle); },
    step(timeStep) { log.push(['step', timeStep]); },
    destroy() { log.push(['destroyWorld']); bodies.clear(); joints.clear(); },
  };
  return {
    backend: {
      id: 'recording-2d',
      capabilities,
      createWorld(options) { log.push(['createWorld', { ...options }]); return driver; },
    },
    bodies,
  };
}

test('Physics2DSystem drives an injected backend without exposing backend objects', () => {
  const log = [];
  const recording = createRecordingBackend(log);
  const physics = new Physics2DSystem({
    backend: recording.backend,
    gravity: [0, -1000],
    pixelsPerMeter: 100,
  });
  const world = new World('physics-adapter');
  const entity = new Entity('body');
  const transform = new Transform2D({ x: 120, y: 250, rotation: 0.25 });
  const body = new Physics2DBody({ type: 'dynamic', width: 80, height: 40 });
  entity.addComponent(transform);
  entity.addComponent(body);
  world.addSystem(physics);
  world.addEntity(entity);

  assert.equal(body.handle, null);
  assert.equal('body' in body, false);
  world.update(0, 0);

  assert.equal(physics.backendId, 'recording-2d');
  assert.equal(typeof body.handle, 'number');
  assert.deepEqual(log[0], ['createWorld', { gravityX: 0, gravityY: -10 }]);
  assert.deepEqual(log.find(entry => entry[0] === 'createBody')[2].positionX, 1.2);
  assert.deepEqual(log.find(entry => entry[0] === 'collider')[2].width, 0.8);

  assert.equal(physics.applyLinearImpulse(body, 3, -4), true);
  assert.ok(log.some(entry => entry[0] === 'impulse' && entry[2] === 3 && entry[3] === -4));

  recording.bodies.get(body.handle).transform = { x: 2, y: 3, angle: 0.5 };
  world.update(20, 20);
  assert.equal(transform.x, 200);
  assert.equal(transform.y, 300);
  assert.equal(transform.rotation, 0.5);

  world.removeEntity(entity);
  world.update(40, 0);
  assert.equal(body.handle, null);
  assert.ok(log.some(entry => entry[0] === 'destroyBody'));
});

test('default Box2D adapter is controlled through the unified system API', () => {
  assert.equal(createBox2DPhysics2DBackend().id, 'box2d');
  const physics = new Physics2DSystem({ gravity: [0, 0], pixelsPerMeter: 100 });
  const world = new World('box2d-adapter');
  const entity = new Entity('ball');
  const body = new Physics2DBody({ type: 'dynamic', shape: 'circle', radius: 20, density: 1 });
  entity.addComponent(new Transform2D({ x: 10, y: 20 }));
  entity.addComponent(body);
  world.addSystem(physics);
  world.addEntity(entity);
  world.update(0, 0);

  assert.equal(physics.backendId, 'box2d');
  assert.equal(physics.hasBody(body), true);
  assert.equal(physics.setLinearVelocity(body, 1.5, -2), true);
  const velocity = { x: 0, y: 0 };
  assert.equal(physics.getLinearVelocity(body, velocity), true);
  assert.deepEqual(velocity, { x: 1.5, y: -2 });
  assert.equal(physics.teleportBody(body, 300, 400, 0.75), true);

  world.update(0, 0);
  const transform = entity.getComponent(Transform2D);
  assert.equal(transform.x, 300);
  assert.equal(transform.y, 400);
  assert.equal(transform.rotation, 0.75);
});

test('Box2D exposes deterministic trigger phases, ray/AABB queries and bounded resource counts', () => {
  const physics = new Physics2DSystem({ gravity: [0, 0], pixelsPerMeter: 100, fixedTimeStep: 1 / 60, maxSubSteps: 1 });
  const world = new World('box2d-g07-events');
  world.addSystem(physics);
  const zone = new Entity('finish-zone');
  zone.addComponent(new Transform2D({ x: 0, y: 0 }));
  zone.addComponent(new Physics2DBody({ type: 'static', shape: 'box', width: 100, height: 100, isSensor: true }));
  world.addEntity(zone);
  const racer = new Entity('racer');
  const racerBody = new Physics2DBody({ type: 'dynamic', shape: 'circle', radius: 20, allowSleep: false });
  racer.addComponent(new Transform2D({ x: 0, y: 0 }));
  racer.addComponent(racerBody);
  world.addEntity(racer);

  world.update(0, 0);
  world.update(1000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => [event.phase, event.kind, event.entityA.name, event.entityB.name]), [['enter', 'trigger', 'finish-zone', 'racer']]);
  world.update(2000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => event.phase), ['stay']);
  assert.equal(physics.castRay([-200, 0], [1, 0], 500)?.entity, zone);
  assert.deepEqual(physics.queryAabb([-30, -30], [30, 30]).map(entity => entity.name), ['finish-zone', 'racer']);
  assert.deepEqual(physics.resourceSnapshot(), { backendId: 'box2d', bodies: 2, colliders: 2, joints: 0, activeContacts: 1 });

  physics.teleportBody(racerBody, 500, 0);
  world.update(3000 / 60, 1000 / 60);
  assert.deepEqual(physics.events().map(event => event.phase), ['exit']);
  physics.destroy();
  assert.deepEqual(physics.resourceSnapshot(), { backendId: 'box2d', bodies: 0, colliders: 0, joints: 0, activeContacts: 0 });
});

test('joint components keep only opaque handles and recreate changed descriptions', () => {
  const log = [];
  const recording = createRecordingBackend(log);
  const physics = new Physics2DSystem({ backend: recording.backend, gravity: [0, 0] });
  const world = new World('joint-adapter');
  world.addSystem(physics);

  const entityA = new Entity('a');
  const bodyA = new Physics2DBody({ type: 'dynamic' });
  entityA.addComponent(new Transform2D());
  entityA.addComponent(bodyA);
  world.addEntity(entityA);

  const entityB = new Entity('b');
  const bodyB = new Physics2DBody({ type: 'dynamic' });
  entityB.addComponent(new Transform2D({ x: 100 }));
  entityB.addComponent(bodyB);
  world.addEntity(entityB);

  const jointEntity = new Entity('link');
  const joint = new Physics2DJoint({ type: 'distance', bodyA: entityA, bodyB: entityB, length: 100 });
  jointEntity.addComponent(joint);
  world.addEntity(jointEntity);
  world.update(0, 0);

  const firstHandle = joint.handle;
  assert.equal(typeof firstHandle, 'number');
  assert.equal('joint' in joint, false);
  assert.equal(log.filter(entry => entry[0] === 'createJoint').length, 1);
  assert.equal(log.find(entry => entry[0] === 'createJoint')[2].length, 1);

  joint.length = 200;
  world.update(1, 0);
  assert.notEqual(joint.handle, firstHandle);
  assert.equal(log.filter(entry => entry[0] === 'createJoint').length, 2);
  assert.equal(log.filter(entry => entry[0] === 'createJoint')[1][2].length, 2);

  world.removeEntity(jointEntity);
  world.update(2, 0);
  assert.equal(joint.handle, null);
});

test('backend replacement cannot clear or reuse another system runtime binding', () => {
  const first = createRecordingBackend([], 10);
  const second = createRecordingBackend([], 100);
  const firstSystem = new Physics2DSystem({ backend: first.backend });
  const secondSystem = new Physics2DSystem({ backend: second.backend });
  const world = new World('backend-replacement');
  const entity = new Entity('body');
  const body = new Physics2DBody({ type: 'dynamic' });
  entity.addComponent(new Transform2D());
  entity.addComponent(body);
  world.addSystem(firstSystem);
  world.addEntity(entity);
  world.update(0, 0);
  assert.equal(body.handle, 10);

  world.removeSystem(firstSystem);
  world.addSystem(secondSystem);
  world.update(1, 0);
  assert.equal(body.handle, 100);
  assert.equal(secondSystem.hasBody(body), true);
  assert.equal(firstSystem.hasBody(body), true);

  firstSystem.destroy();
  assert.equal(body.handle, 100);
  assert.equal(secondSystem.hasBody(body), true);
});
