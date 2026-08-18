import assert from 'node:assert/strict';
import test from 'node:test';
import { CartesianTransform3D, World } from '../dist/index.js';
import { FirstPersonControls } from '../dist/controls.js';

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? new Set();
      values.add(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function createInputHarness() {
  const keyboard = createEventTarget();
  const documentTarget = createEventTarget();
  const canvasTarget = createEventTarget();
  const document = {
    ...documentTarget,
    defaultView: keyboard,
    pointerLockElement: null,
    exitPointerLock() {
      this.pointerLockElement = null;
      this.dispatch('pointerlockchange');
    },
  };
  const canvas = {
    ...canvasTarget,
    ownerDocument: document,
    setPointerCapture() {},
    requestPointerLock() {
      document.pointerLockElement = canvas;
      document.dispatch('pointerlockchange');
      return Promise.resolve();
    },
  };
  return { canvas, document, keyboard };
}

function key(code, repeat = false) {
  return { code, repeat, preventDefault() {} };
}

test('FirstPersonControls applies pointer-lock look and normalized WASD movement as a Scene system', t => {
  const { canvas, document, keyboard } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [0, 0.5, 0] });
  const controls = new FirstPersonControls(canvas, transform, {
    moveSpeed: 4,
    groundOffset: 0.5,
    groundProbe: () => 0,
  });
  const world = new World('FirstPersonControls');
  world.addSystem(controls);
  t.after(() => world.destroy());

  canvas.dispatch('click');
  document.dispatch('mousemove', { movementX: 20, movementY: -10 });
  assert.ok(transform.rotation[1] < 0);
  assert.ok(transform.rotation[0] > 0);

  keyboard.dispatch('keydown', key('KeyW'));
  world.update(100, 100);
  assert.ok(transform.position[2] < -0.39);
  assert.ok(Math.abs(Math.hypot(controls.velocity[0], controls.velocity[2]) - 4) < 1e-5);
  assert.equal(controls.grounded, true);
});

test('FirstPersonControls jumps, lands, blocks tall steps, and can jump onto them', t => {
  const { canvas, keyboard } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [0, 0.5, 0] });
  const controls = new FirstPersonControls(canvas, transform, {
    moveSpeed: 4,
    jumpSpeed: 5.5,
    gravity: 16,
    groundOffset: 0.5,
    maxStepHeight: 0.1,
    pointerLock: false,
    groundProbe: position => position[0] >= 0.25 ? 0.35 : 0,
  });
  t.after(() => controls.destroy());

  keyboard.dispatch('keydown', key('KeyD'));
  controls.step(100);
  assert.ok(Math.abs(transform.position[0]) < 1e-6, 'the 0.35-high step is not walked automatically');

  keyboard.dispatch('keydown', key('Space'));
  controls.step(100);
  assert.ok(transform.position[0] >= 0.39, 'jump height clears the step riser');
  assert.ok(transform.position[1] > 0.85);
  keyboard.dispatch('keyup', key('KeyD'));
  for (let index = 0; index < 80 && !controls.grounded; index++) controls.step(16);
  assert.equal(controls.grounded, true);
  assert.ok(Math.abs(transform.position[1] - 0.85) < 1e-4);
});

test('FirstPersonControls treats a null surface probe as a fall-through hole and disposes listeners', () => {
  const { canvas, keyboard } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [0, 0.5, 0] });
  const controls = new FirstPersonControls(canvas, transform, {
    moveSpeed: 4,
    gravity: 10,
    groundOffset: 0.5,
    pointerLock: false,
    groundProbe: position => position[0] >= 0.25 ? null : 0,
  });

  keyboard.dispatch('keydown', key('KeyD'));
  controls.step(100);
  assert.ok(transform.position[0] >= 0.39);
  assert.equal(controls.grounded, false);
  controls.step(100);
  assert.ok(transform.position[1] < 0.5);

  controls.dispose();
  const x = transform.position[0];
  keyboard.dispatch('keydown', key('KeyD'));
  controls.step(100);
  assert.equal(transform.position[0], x);
  assert.equal([...keyboard.listeners.values()].every(values => values.size === 0), true);
});

test('FirstPersonControls rejects invalid configuration and non-finite ground probes', () => {
  const { canvas } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [0, 0, 0] });
  assert.throws(() => new FirstPersonControls(canvas, transform, { gravity: -1 }), /gravity/);
  const controls = new FirstPersonControls(canvas, transform, { pointerLock: false, groundProbe: () => Number.NaN });
  assert.throws(() => controls.step(16), /finite height or null/);
  controls.dispose();
});

test('FirstPersonControls clamps a negative browser frame delta without moving backwards', () => {
  const { canvas } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [1, 0, 2] });
  const controls = new FirstPersonControls(canvas, transform, { pointerLock: false });
  controls.step(-0.25);
  assert.deepEqual(Array.from(transform.position), [1, 0, 2]);
  assert.throws(() => controls.step(Number.NaN), /deltaMilliseconds must be finite/);
  controls.dispose();
});

test('FirstPersonControls keeps drag-look usable when pointer lock is supported but not granted', () => {
  const { canvas, keyboard } = createInputHarness();
  const transform = new CartesianTransform3D({ position: [0, 0, 0] });
  const controls = new FirstPersonControls(canvas, transform);

  canvas.dispatch('pointerdown', { pointerId: 4, clientX: 10, clientY: 20 });
  canvas.dispatch('pointermove', { pointerId: 4, clientX: 35, clientY: 8 });
  assert.ok(transform.rotation[1] < 0);
  assert.ok(transform.rotation[0] > 0);
  keyboard.dispatch('keydown', key('KeyW'));
  controls.step(100);
  assert.ok(Math.hypot(transform.position[0], transform.position[2]) > 0.39);
  controls.dispose();
});
