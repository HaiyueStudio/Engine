import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity, World, CartesianTransform3D, Transform2D } from '@haiyue/engine';
import { GuiRoot } from '@haiyue/engine/gui';
import { VirtualJoystickControls } from '@haiyue/extensions/controls';
import * as extensionsRoot from '@haiyue/extensions';
import { readFileSync } from 'node:fs';

class Surface extends EventTarget {
  rect = { left: 30, top: 50, width: 400, height: 600 };
  captures = new Set();
  listeners = new Set();
  ownerDocument = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  getBoundingClientRect() { return this.rect; }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  addEventListener(type, fn, options) { this.listeners.add(fn); super.addEventListener(type, fn, options); }
  removeEventListener(type, fn) { super.removeEventListener(type, fn); this.listeners.delete(fn); }
  pointer(type, x, y, id = 1, extra = {}) {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      clientX: this.rect.left + x, clientY: this.rect.top + y, pointerId: id,
      button: 0, pointerType: 'touch', isPrimary: id === 1, ...extra,
    });
    this.dispatchEvent(event);
    return event;
  }
}
const close = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
function setup(options = {}) {
  const surface = new Surface();
  const controls = new VirtualJoystickControls(surface, {
    mode: 'fixed', center: { x: 100, y: 450 }, maxDistance: 50, deadZone: 0,
    ...options,
  });
  return { surface, controls };
}

test('focused export leaves root lightweight', () => {
  assert.equal(typeof VirtualJoystickControls, 'function');
  assert.deepEqual(Object.keys(extensionsRoot), ['RenderSystem2DBase']);
});

test('public controls entry, reviewed API and capability budget agree', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.exports['./controls'], { types: './dist/controls.d.ts', import: './dist/controls.js' });
  const baseline = JSON.parse(readFileSync(new URL('../../review/baselines/api-surface.json', import.meta.url), 'utf8'));
  const api = baseline.packages['@haiyue/extensions'].entrypoints['./controls'].exports;
  assert.deepEqual(api.filter(e => e.kind === 'value').map(e => e.name), ['VirtualJoystickControls']);
  assert.equal(api.length, 9);
  const policy = JSON.parse(readFileSync(new URL('../../config/public-api-capability-budgets.json', import.meta.url), 'utf8'));
  const group = policy.packages['@haiyue/extensions'].groups.find(g => g.id === 'virtual-joystick-controls');
  assert.equal(group.entrypoints['./controls'], api.length);
  const declaration = readFileSync(new URL('../dist/controls.d.ts', import.meta.url), 'utf8');
  assert.match(declaration, /VirtualJoystickControls/);
  assert.doesNotMatch(declaration, /\b(?:experimental|JoystickView|editor|native)\b/);
});

test('fixed center clamps diagonal displacement and reports raw distance separately', () => {
  const { surface, controls } = setup();
  surface.pointer('pointerdown', 100, 450);
  surface.pointer('pointermove', 160, 530);
  const state = controls.state;
  assert.deepEqual(state.center, { x: 100, y: 450 });
  assert.deepEqual(state.offset, { x: 30, y: 40 });
  assert.equal(state.distance, 50);
  assert.equal(state.rawDistance, 100);
  assert.equal(state.strength, 1);
  close(state.direction.x, 0.6); close(state.direction.y, 0.8);
  assert.throws(() => { state.direction.x = 99; }, TypeError);
  surface.pointer('pointerup', 160, 530);
  assert.equal(controls.state.distance, 0);
  assert.equal(state.distance, 50, 'retained event snapshots do not mutate');
  controls.destroy();
});

test('GUI scroll prevention does not swallow joystick input; explicit arbitration still works', () => {
  const surface = new Surface();
  surface.addEventListener('pointerdown', event => event.preventDefault());
  const controls = new VirtualJoystickControls(surface, { mode: 'fixed', center: { x: 100, y: 450 } });
  surface.pointer('pointerdown', 100, 450);
  assert.equal(controls.state.active, true);
  surface.pointer('pointermove', 180, 450);
  assert.equal(controls.state.strength, 1);
  controls.configure({ shouldActivate: () => false });
  surface.pointer('pointerdown', 100, 450);
  assert.equal(controls.state.active, false);
  controls.destroy();
});

test('fixed hit disk, activation region, non-left buttons and HUD predicate reject without consuming', () => {
  const { surface, controls } = setup({ activationRadius: 55, shouldActivate: (p) => p.x >= 70 });
  for (const [x, y, extra] of [[100, 100, {}], [190, 450, {}], [60, 450, {}], [100, 450, { button: 2 }]]) {
    assert.equal(surface.pointer('pointerdown', x, y, 1, extra).defaultPrevented, false);
    assert.equal(controls.state.active, false);
  }
  assert.equal(surface.pointer('pointerdown', 120, 450).defaultPrevented, true);
  assert.equal(controls.state.distance, 20);
  controls.destroy();
});

test('floating center uses each press, stays anchored outside region and hides on release', () => {
  const root = new GuiRoot();
  const { surface, controls } = setup({ mode: 'floating', guiRoot: root });
  assert.equal(root.root.children.every(node => !node.visible), true);
  surface.pointer('pointerdown', 70, 420);
  assert.deepEqual(controls.state.center, { x: 70, y: 420 });
  assert.equal(controls.state.strength, 0);
  surface.pointer('pointermove', 350, 120);
  controls.step(16);
  assert.equal(controls.state.distance, 50);
  assert.equal(root.root.children.every(node => node.visible), true);
  surface.pointer('pointerup', 350, 120);
  assert.equal(root.root.children.every(node => !node.visible), true);
  surface.pointer('pointerdown', 130, 550);
  assert.deepEqual(controls.state.center, { x: 130, y: 550 });
  controls.destroy();
  assert.equal(root.root.children.length, 0);
});

test('dead zone suppresses drift and rescales strength continuously', () => {
  const { surface, controls } = setup({ deadZone: 0.2 });
  surface.pointer('pointerdown', 100, 450);
  surface.pointer('pointermove', 110, 450);
  assert.equal(controls.state.strength, 0);
  assert.deepEqual(controls.state.direction, { x: 0, y: 0 });
  assert.deepEqual(controls.state.offset, { x: 10, y: 0 });
  surface.pointer('pointermove', 130, 450);
  close(controls.state.strength, 0.5);
  controls.destroy();
});

test('first eligible finger owns joystick even when not primary; other fingers cannot move/end it', () => {
  const { surface, controls } = setup({ mode: 'floating' });
  surface.pointer('pointerdown', 90, 450, 2);
  surface.pointer('pointerdown', 130, 460, 3);
  surface.pointer('pointermove', 200, 550, 3);
  surface.pointer('pointerup', 200, 550, 3);
  surface.pointer('pointercancel', 200, 550, 3);
  assert.equal(controls.state.pointerId, 2);
  assert.equal(controls.state.distance, 0);
  surface.pointer('pointermove', 140, 450, 2);
  assert.equal(controls.state.strength, 1);
  assert.deepEqual([...surface.captures], [2]);
  surface.pointer('pointerup', 140, 450, 2);
  assert.equal(surface.captures.size, 0);
  controls.destroy();
});

test('every enabled frame emits exact dt for idle, zero dt and stationary held input', () => {
  const { surface, controls } = setup();
  const frames = [];
  controls.events.on('frame', e => frames.push(e.detail));
  controls.step(0); controls.step(20);
  surface.pointer('pointerdown', 150, 450);
  for (let i = 0; i < 3; i++) controls.step(16);
  assert.equal(frames.length, 5);
  assert.equal(frames[1].active, false);
  assert.equal(frames[2].deltaMilliseconds, 16);
  assert.equal(frames[2].deltaSeconds, 0.016);
  assert.deepEqual(frames.slice(2).map(f => f.strength), [1, 1, 1]);
  controls.step(2000);
  assert.equal(frames.at(-1).deltaSeconds, 2);
  assert.equal(frames.at(-1).movementDeltaSeconds, 0.1);
  controls.disabled = true; controls.step(16);
  assert.equal(frames.length, 6);
  assert.equal(controls.state.active, false);
  controls.destroy();
});

test('3D movement uses seconds, preserves height/pitch/roll and aligns -Z model forward', () => {
  const tr = new CartesianTransform3D({ position: [2, 3, 4], rotation: [0.1, 0, 0.2] });
  const entity = new Entity().addComponent(tr);
  const { surface, controls } = setup({ target: entity, moveSpeed: 10 });
  surface.pointer('pointerdown', 150, 450);
  for (let i = 0; i < 10; i++) controls.step(100);
  close(tr.position[0], 12); close(tr.position[1], 3); close(tr.position[2], 4);
  close(tr.rotation[1], -Math.PI / 2); close(tr.rotation[0], 0.1); close(tr.rotation[2], 0.2);
  surface.pointer('pointerup', 150, 450);
  controls.step(100);
  close(tr.position[0], 12);
  controls.destroy();
});

test('speed is frame-rate independent and diagonal input is normalized', () => {
  const run = (count) => {
    const tr = new CartesianTransform3D();
    const { surface, controls } = setup({ target: new Entity().addComponent(tr), moveSpeed: 5 });
    surface.pointer('pointerdown', 100, 450);
    surface.pointer('pointermove', 200, 350);
    for (let i = 0; i < count; i++) controls.step(1000 / count);
    const result = [...tr.position]; controls.destroy(); return result;
  };
  const a = run(20), b = run(100);
  // Positions use Float32 transforms; repeated integration accumulates a few ulps.
  close(Math.hypot(a[0], a[2]), 5, 1e-5); close(a[0], b[0], 1e-5); close(a[2], b[2], 1e-5);
});

test('2D binding, analog toggle, heading offset and finite turn rate', () => {
  const tr = new Transform2D();
  const { surface, controls } = setup({ target: new Entity().addComponent(tr), plane: 'xy', analog: false, moveSpeed: 10, turnSpeed: 1 });
  surface.pointer('pointerdown', 100, 425);
  controls.step(100);
  close(tr.x, 0); close(tr.y, 1); close(tr.rotation, 0.1);
  controls.configure({ turnSpeed: Infinity, analog: true, rotationOffset: Math.PI / 2 });
  surface.pointer('pointerdown', 125, 450);
  controls.step(100);
  close(tr.x, 0.5); close(tr.rotation, Math.PI / 2);
  controls.destroy();
});

test('movement basis rotates independently of model facing and can disable facing', () => {
  const tr = new CartesianTransform3D({ rotation: [0, 0.7, 0] });
  const { surface, controls } = setup({ target: new Entity().addComponent(tr), movementRotation: Math.PI / 2, rotateToDirection: false });
  surface.pointer('pointerdown', 100, 400);
  controls.step(100);
  close(tr.position[0], -0.4); close(tr.position[2], 0); close(tr.rotation[1], 0.7);
  controls.destroy();
});

test('zero turn speed preserves heading and finite turn chooses shortest path across PI', () => {
  const tr = new Transform2D({ rotation: Math.PI - 0.05 });
  const { surface, controls } = setup({ target: new Entity().addComponent(tr), plane: 'xy', turnSpeed: 1 });
  surface.pointer('pointerdown', 50, 453);
  controls.step(100);
  assert.ok(tr.rotation > Math.PI);
  controls.configure({ turnSpeed: 0 });
  surface.pointer('pointerdown', 150, 450);
  const before = tr.rotation; controls.step(100); assert.equal(tr.rotation, before);
  controls.destroy();
});

test('cancel paths release capture and emit only once; disabled stops new presses', () => {
  const { surface, controls } = setup();
  let cancelled = 0;
  controls.events.on('cancel', ({ detail }) => { cancelled++; assert.equal(detail.strength, 0); });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    surface.pointer('pointerdown', 100, 450);
    surface.pointer(type, 100, 450); controls.cancel();
  }
  surface.pointer('pointerdown', 100, 450);
  surface.ownerDocument.defaultView.dispatchEvent(new Event('blur'));
  surface.pointer('pointerdown', 100, 450);
  surface.ownerDocument.hidden = true;
  surface.ownerDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(cancelled, 4); assert.equal(surface.captures.size, 0);
  controls.disabled = true; surface.pointer('pointerdown', 100, 450);
  assert.equal(controls.state.active, false);
  controls.destroy();
});

test('surface resize/offset change cancels drag; callbacks resolve new logical viewport', () => {
  const { surface, controls } = setup({ center: ({ width, height }) => ({ x: width / 4, y: height * 0.75 }) });
  surface.pointer('pointerdown', 100, 450);
  surface.rect = { left: 80, top: 90, width: 800, height: 400 };
  controls.step(16);
  assert.equal(controls.state.active, false);
  assert.deepEqual(controls.state.center, { x: 200, y: 300 });
  surface.pointer('pointerdown', 200, 300);
  surface.pointer('pointermove', 250, 300);
  assert.equal(controls.state.distance, 50, 'surface offset is removed once; no DPR scaling');
  surface.rect.top = 120;
  surface.pointer('pointermove', 250, 300);
  assert.equal(controls.state.active, false);
  controls.destroy();
});

test('invalid configuration and dt reject; valid configuration cancels gesture atomically', () => {
  const { surface, controls } = setup();
  surface.pointer('pointerdown', 150, 450);
  for (const options of [{ maxDistance: 0 }, { deadZone: 1 }, { moveSpeed: -1 }, { turnSpeed: NaN }, { maxDeltaMilliseconds: Infinity }, { center: { x: NaN, y: 0 } }, { center: () => ({ x: NaN, y: 0 }) }, { region: () => ({ x: 0, y: 0, width: -1, height: 2 }) }, { plane: 'yz' }, { target: new Entity() }]) {
    assert.throws(() => controls.configure(options));
    assert.equal(controls.state.active, true);
  }
  for (const delta of [-1, NaN, Infinity]) assert.throws(() => controls.step(delta), RangeError);
  controls.configure({ maxDistance: 25 });
  assert.equal(controls.state.active, false);
  surface.pointer('pointerdown', 100, 450); surface.pointer('pointermove', 200, 450);
  assert.equal(controls.state.distance, 25);
  controls.destroy();
});

test('target destruction/component replacement and disabled targets never write stale transforms', () => {
  const first = new CartesianTransform3D(), entity = new Entity().addComponent(first);
  const { surface, controls } = setup({ target: entity });
  surface.pointer('pointerdown', 150, 450);
  entity.disabled = true; controls.step(100); close(first.position[0], 0);
  entity.disabled = false;
  const second = new CartesianTransform3D(); entity.addComponent(second);
  controls.step(100); close(first.position[0], 0); close(second.position[0], 0.4);
  entity.destroy(); controls.step(100); close(second.position[0], 0.4);
  controls.destroy();
});

test('World drives frames and destroy removes GUI, input and callbacks idempotently', () => {
  const root = new GuiRoot(), world = new World();
  const { surface, controls } = setup({ guiRoot: root });
  let frames = 0;
  controls.events.on('frame', () => frames++);
  world.addSystem(controls);
  world.update(20, 20); world.update(40, 20);
  assert.equal(frames, 2);
  surface.pointer('pointerdown', 100, 450);
  assert.equal(root.root.children.length, 2);
  controls.configure({ maxDistance: 70 });
  assert.equal(root.root.children.length, 2, 'configuration does not accumulate GUI nodes');
  world.destroy(); controls.destroy();
  assert.equal(root.root.children.length, 0); assert.equal(surface.captures.size, 0);
  assert.equal(surface.listeners.size, 0);
  surface.pointer('pointerdown', 100, 450); controls.step(20);
  assert.equal(frames, 2); assert.equal(controls.state.active, false);
});

test('World first-frame clock adjustment yields zero dt and does not abort movement updates', () => {
  const tr = new CartesianTransform3D();
  const { surface, controls } = setup({ target: new Entity().addComponent(tr) });
  const frames = [];
  controls.events.on('frame', ({ detail }) => frames.push(detail));
  const world = new World(); world.addSystem(controls);
  surface.pointer('pointerdown', 150, 450);
  world.update(100, -8);
  close(tr.position[0], 0); assert.equal(frames[0].deltaMilliseconds, 0);
  world.update(116, 16);
  close(tr.position[0], 0.064); assert.equal(frames[1].deltaMilliseconds, 16);
  world.destroy();
});
