import assert from 'node:assert/strict';
import test from 'node:test';
import { Camera3D, Entity, OrbitControl, SphericalTransform3D, World } from '../dist/index.js';

function createCanvas(bounds) {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setPointerCapture() {},
    getBoundingClientRect() { return bounds; },
    dispatch(type, event) { listeners.get(type)?.(event); },
  };
}

test('OrbitControl pan uses validated camera basis and remains finite', t => {
  const transform = new SphericalTransform3D({
    radius: 10,
    theta: Math.PI / 4,
    phi: Math.PI / 3,
  });
  const control = new OrbitControl(createCanvas({ width: 200, height: 100 }), transform);
  t.after(() => control.dispose());

  control._pan(10, -5);

  assert.equal(Array.from(transform.target).every(Number.isFinite), true);
  assert.notDeepEqual(Array.from(transform.target), [0, 0, 0]);
});

test('OrbitControl ignores rotate and pan input from a zero-sized canvas', t => {
  const transform = new SphericalTransform3D({ radius: 10, theta: 0.5, phi: 1 });
  const control = new OrbitControl(createCanvas({ width: 0, height: 0 }), transform);
  t.after(() => control.dispose());
  const before = {
    theta: transform.theta,
    phi: transform.phi,
    target: Array.from(transform.target),
  };

  control._rotate(20, 10);
  control._pan(20, 10);

  assert.equal(transform.theta, before.theta);
  assert.equal(transform.phi, before.phi);
  assert.deepEqual(Array.from(transform.target), before.target);
});

test('OrbitControl scopes pointer and wheel input to a normalized canvas region', t => {
  const canvas = createCanvas({ left: 10, top: 20, width: 200, height: 100 });
  const transform = new SphericalTransform3D({ radius: 10, theta: 0.5, phi: 1 });
  const control = new OrbitControl(canvas, transform, {
    inputRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  });
  t.after(() => control.dispose());

  canvas.dispatch('pointerdown', {
    pointerId: 1, pointerType: 'mouse', button: 0, clientX: 40, clientY: 40, preventDefault() {},
  });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 60, clientY: 50, buttons: 0 });
  assert.equal(transform.theta, 0.5, 'top-left input must not start an orbit');

  canvas.dispatch('pointerdown', {
    pointerId: 2, pointerType: 'mouse', button: 0, clientX: 160, clientY: 90, preventDefault() {},
  });
  canvas.dispatch('pointermove', { pointerId: 2, clientX: 170, clientY: 95, buttons: 0 });
  assert.notEqual(transform.theta, 0.5, 'bottom-right input must update the orbit');

  let prevented = false;
  const radiusAfterDrag = transform.radius;
  canvas.dispatch('wheel', {
    clientX: 40, clientY: 40, deltaY: 100, deltaMode: 0,
    preventDefault() { prevented = true; },
  });
  assert.equal(transform.radius, radiusAfterDrag);
  assert.equal(prevented, false);
  canvas.dispatch('wheel', {
    clientX: 160, clientY: 90, deltaY: 100, deltaMode: 0,
    preventDefault() { prevented = true; },
  });
  assert.ok(transform.radius > radiusAfterDrag);
  assert.equal(prevented, true);
});

test('OrbitControl rejects invalid normalized input regions', () => {
  const canvas = createCanvas({ left: 0, top: 0, width: 200, height: 100 });
  const transform = new SphericalTransform3D();
  assert.throws(
    () => new OrbitControl(canvas, transform, { inputRegion: { x: 0.75, y: 0, width: 0.5, height: 1 } }),
    /positive normalized rectangle/,
  );
});

test('OrbitControl input changes reach the next FrameData camera snapshot', t => {
  const canvas = createCanvas({ left: 0, top: 0, width: 200, height: 100 });
  const transform = new SphericalTransform3D({ radius: 10, theta: 0.5, phi: 1 });
  const camera = new Camera3D({ type: 'perspective' });
  const entity = new Entity('OrbitCamera');
  entity.addComponent(camera);
  entity.addComponent(transform);
  const world = new World('OrbitFrameData');
  world.addEntity(entity);
  const control = new OrbitControl(canvas, transform, {
    inputRegion: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  });
  t.after(() => {
    control.dispose();
    world.destroy();
  });

  world.update(0, 16);
  const before = Array.from(world.frameData.getCamera3D(entity, camera, 100, 50).viewProjectionMatrix);
  canvas.dispatch('pointerdown', {
    pointerId: 1, pointerType: 'mouse', button: 0, clientX: 150, clientY: 75, preventDefault() {},
  });
  canvas.dispatch('pointermove', { pointerId: 1, clientX: 170, clientY: 80, buttons: 0 });
  world.update(16, 16);
  const after = Array.from(world.frameData.getCamera3D(entity, camera, 100, 50).viewProjectionMatrix);

  assert.notDeepEqual(after, before);
});
