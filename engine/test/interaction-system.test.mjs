import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Interactive,
  createInteractionRaycastResult,
  InteractionSystem,
  Mesh3D,
  World,
} from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

function createCanvasMock() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    },
    dispatchPointer(type, clientX = 50, clientY = 50) {
      const listener = listeners.get(type);
      if (listener) listener({ clientX, clientY });
    },
    listenerCount() { return listeners.size; },
  };
}

function createTriangleGeometry() {
  return new Geometry3D({
    positions: new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.0,  0.5, 0,
    ]),
  });
}

function createWorldWithCamera() {
  const world = new World('InteractionWorld');
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D({ far: 100 }));
  camera.addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);
  return { world, camera };
}

test('InteractionSystem can expose raycast without binding native canvas input', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { camera } = createWorldWithCamera();
  const system = new InteractionSystem(engine, camera, { bindCanvas: false });
  assert.equal(system.bindsCanvasInput, false);
  assert.equal(canvas.listenerCount(), 0);
  system.destroy();
  assert.equal(canvas.listenerCount(), 0);
});

test('InteractionSystem only updates hover when pointer state changes by default', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { world, camera } = createWorldWithCamera();
  const system = new InteractionSystem(engine, camera, { spatialIndex: false });
  world.addSystem(system);
  world.update(0, 0);

  let casts = 0;
  system._castRay = () => {
    casts += 1;
    return null;
  };

  world.update(1, 16);
  world.update(2, 16);
  assert.equal(casts, 0);

  canvas.dispatchPointer('pointermove');
  world.update(3, 16);
  assert.equal(casts, 2);

  world.update(4, 16);
  assert.equal(casts, 2);
});

test('InteractionSystem spatial index filters exact mesh ray tests by world AABB', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { world, camera } = createWorldWithCamera();
  const system = new InteractionSystem(engine, camera, { spatialLeafSize: 1 });
  world.addSystem(system);

  const material = new BasicMaterial();
  const geometry = createTriangleGeometry();
  const near = new Entity('Near');
  near.addComponent(new CartesianTransform3D({ position: [0, 0, -5] }));
  near.addComponent(new Mesh3D(geometry, material));
  world.addEntity(near);

  for (let i = 0; i < 20; i++) {
    const entity = new Entity(`Far ${i}`);
    entity.addComponent(new CartesianTransform3D({ position: [100 + i * 4, 0, -5] }));
    entity.addComponent(new Mesh3D(geometry, material));
    world.addEntity(entity);
  }

  world.update(0, 0);
  system._ray.origin.set([0, 0, 0]);
  system._ray.direction.set([0, 0, -1]);
  let exactTests = 0;
  system._ray.intersectMesh = () => {
    exactTests += 1;
    return null;
  };

  system._castRay(world);

  assert.equal(exactTests, 1);
});

test('InteractionSystem raycast updates a reusable caller-owned result', () => {
  const engine = { ...createMockEngine(), canvas: null };
  const { world, camera } = createWorldWithCamera();
  const target = new Entity('Raycast target');
  target.addComponent(new CartesianTransform3D());
  target.addComponent(new Mesh3D(createTriangleGeometry(), new BasicMaterial()));
  world.addEntity(target);
  const system = new InteractionSystem(engine, camera, { spatialIndex: false });
  world.addSystem(system);
  world.update(0, 0);

  const result = createInteractionRaycastResult();
  const point = result.point;
  const normal = result.normal;
  assert.equal(system.raycast(world, 0, 0, result), true);
  assert.equal(result.entity, target);
  assert.equal(result.point, point);
  assert.equal(result.normal, normal);
});

test('InteractionSystem spatial and linear paths agree on penetrable and closest-hit rules', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { world, camera } = createWorldWithCamera();
  const system = new InteractionSystem(engine, camera, { spatialLeafSize: 1 });
  world.addSystem(system);
  const material = new BasicMaterial();
  const geometry = createTriangleGeometry();

  const addMesh = (name, z, interactive = null) => {
    const entity = new Entity(name);
    entity.addComponent(new CartesianTransform3D({ position: [0, 0, z] }));
    entity.addComponent(new Mesh3D(geometry, material));
    if (interactive) entity.addComponent(interactive);
    world.addEntity(entity);
    return entity;
  };
  addMesh('Penetrable', -1, new Interactive({ penetrable: true }));
  const blocker = addMesh('Blocker', -2);
  addMesh('Interactive Behind', -4, new Interactive());

  world.update(0, 0);
  system._ray.origin.set([0, 0, 0]);
  system._ray.direction.set([0, 0, -1]);

  system.spatialIndex = false;
  const linear = system._castRay(world);
  system.spatialIndex = true;
  system._rebuildSpatialIndex(world);
  const spatial = system._castRay(world);
  assert.equal(linear?.entity, blocker);
  assert.equal(spatial?.entity, blocker);
  assert.ok(Math.abs(spatial.distance - linear.distance) < 1e-6);
});

test('InteractionSystem hover transitions tolerate component removal without assertions', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { world, camera } = createWorldWithCamera();
  const system = new InteractionSystem(engine, camera, { spatialIndex: false });
  world.addSystem(system);
  const target = new Entity('Target');
  const events = [];
  target.addComponent(new Interactive({
    onPointerMove: () => events.push('move'),
    onPointerEnter: () => events.push('enter'),
    onPointerLeave: () => events.push('leave'),
  }));
  let hitTarget = true;
  system._castRay = () => hitTarget
    ? { entity: target, distance: 1, point: new Float32Array(3), normal: new Float32Array(3) }
    : null;

  canvas.dispatchPointer('pointermove');
  world.update(0, 0);
  assert.deepEqual(events, ['move', 'enter']);

  target.removeComponent(Interactive);
  hitTarget = false;
  canvas.dispatchPointer('pointermove');
  assert.doesNotThrow(() => world.update(1, 16));
  assert.deepEqual(events, ['move', 'enter']);
  assert.equal(system._hoveredEntity, null);
});

test('InteractionSystem reuses one ephemeral event object across pointer dispatches', () => {
  const canvas = createCanvasMock();
  const engine = { ...createMockEngine(), canvas };
  const { world, camera } = createWorldWithCamera();
  const received = [];
  const target = new Entity('Target').addComponent(new Interactive({
    onClick: event => received.push(event),
  }));
  const system = new InteractionSystem(engine, camera, { spatialIndex: false });
  world.addSystem(system);
  system._castRay = () => ({
    entity: target,
    distance: 1,
    point: new Float32Array([1, 2, 3]),
    normal: new Float32Array([0, 0, 1]),
  });

  canvas.dispatchPointer('click');
  canvas.dispatchPointer('click');
  world.update(0, 0);

  assert.equal(received.length, 2);
  assert.equal(received[0], received[1]);
  assert.deepEqual(Array.from(received[0].point), [1, 2, 3]);
});
