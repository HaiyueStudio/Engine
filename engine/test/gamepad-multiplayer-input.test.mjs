import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserMultiplayerInput } from '../dist/experimental/simulation.js';

test('two players share one keyboard and use independent standard gamepads with tick transitions and hot-plug', () => {
  const target = new CountingEventTarget();
  const visibility = new VisibilityTarget();
  const gamepads = [gamepad(), gamepad()];
  const input = new BrowserMultiplayerInput({
    eventTarget: target,
    visibilityTarget: visibility,
    getGamepads: () => gamepads,
    players: [
      { id: 'P1', gamepadIndex: 0, bindings: { left: { keys: ['KeyA'], gamepadAxes: [{ axis: 0, direction: 'negative' }] }, a: { keys: ['KeyJ'], gamepadButtons: [0] } } },
      { id: 'P2', gamepadIndex: 1, bindings: { left: { keys: ['ArrowLeft'], gamepadAxes: [{ axis: 0, direction: 'negative' }] }, a: { keys: ['Numpad1'], gamepadButtons: [0] } } },
    ],
  });

  target.dispatchKey('keydown', 'KeyA');
  target.dispatchKey('keydown', 'Numpad1');
  gamepads[1] = gamepad({ axes: [-0.7] });
  const first = input.sample(1);
  assert.deepEqual(action(first, 'P1', 'left'), { action: 'left', value: 1, held: true, pressed: true, released: false });
  assert.equal(action(first, 'P2', 'a').pressed, true);
  assert.ok(action(first, 'P2', 'left').value > 0.6);

  const second = input.sample(2);
  assert.equal(action(second, 'P1', 'left').pressed, false);
  assert.equal(action(second, 'P1', 'left').held, true);
  target.dispatchKey('keyup', 'KeyA');
  target.dispatchKey('keyup', 'Numpad1');
  gamepads[1] = null;
  const third = input.sample(3);
  assert.equal(action(third, 'P1', 'left').released, true);
  assert.equal(action(third, 'P2', 'left').released, true);
  assert.equal(action(third, 'P2', 'a').released, true);
  assert.notEqual(first.hash, third.hash);

  gamepads[1] = gamepad({ buttons: [{ pressed: true, value: 1 }] });
  const fourth = input.sample(4);
  assert.equal(action(fourth, 'P2', 'a').pressed, true, 'hot-plugged gamepad is sampled without rebuilding the owner');
  gamepads[1] = null;
  target.dispatchGamepad('gamepaddisconnected', 1);
  assert.equal(action(input.sample(5), 'P2', 'a').released, true);

  input.dispose();
});

test('blur, visibility, reset and dispose release input without duplicate or stale listeners', () => {
  const target = new CountingEventTarget();
  const visibility = new VisibilityTarget();
  const input = new BrowserMultiplayerInput({ eventTarget: target, visibilityTarget: visibility, players: [{ id: 'P1', bindings: { a: { keys: ['KeyJ'] } } }] });
  assert.deepEqual(target.counts(), { blur: 1, gamepadconnected: 1, gamepaddisconnected: 1, keydown: 1, keyup: 1 });
  assert.deepEqual(visibility.counts(), { visibilitychange: 1 });

  target.dispatchKey('keydown', 'KeyJ');
  assert.equal(action(input.sample(1), 'P1', 'a').held, true);
  target.dispatchEvent(new Event('blur'));
  assert.equal(action(input.sample(2), 'P1', 'a').released, true);

  target.dispatchKey('keydown', 'KeyJ');
  assert.equal(action(input.sample(3), 'P1', 'a').held, true);
  visibility.hidden = true;
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(input.suspended, true);
  assert.equal(action(input.sample(4), 'P1', 'a').released, true);
  visibility.hidden = false;
  visibility.dispatchEvent(new Event('visibilitychange'));
  input.reset().reset();
  assert.equal(input.tick, 0);
  assert.equal(action(input.sample(1), 'P1', 'a').held, false);
  assert.deepEqual(target.counts(), { blur: 1, gamepadconnected: 1, gamepaddisconnected: 1, keydown: 1, keyup: 1 });

  input.dispose(); input.dispose();
  assert.deepEqual(target.counts(), {});
  assert.deepEqual(visibility.counts(), {});
  assert.throws(() => input.sample(2), /disposed/u);
});

test('multiplayer snapshots are hash-stable for identical physical input', () => {
  const run = () => {
    const target = new CountingEventTarget();
    const input = new BrowserMultiplayerInput({ eventTarget: target, players: [{ id: 'P1', bindings: { a: { keys: ['KeyJ'] } } }, { id: 'P2', bindings: { a: { keys: ['Numpad1'] } } }] });
    target.dispatchKey('keydown', 'KeyJ');
    const hashes = [input.sample(1).hash];
    target.dispatchKey('keydown', 'Numpad1');
    hashes.push(input.sample(2).hash);
    target.dispatchKey('keyup', 'KeyJ');
    hashes.push(input.sample(3).hash);
    input.dispose();
    return hashes;
  };
  assert.deepEqual(run(), run());
});

function action(snapshot, playerId, name) {
  return snapshot.players.find(player => player.id === playerId).actions.find(value => value.action === name);
}

function gamepad(overrides = {}) {
  return { connected: true, buttons: [{ pressed: false, value: 0 }], axes: [0, 0], ...overrides };
}

class CountingEventTarget extends EventTarget {
  #listeners = new Map();
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener); this.#listeners.set(type, listeners);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.#listeners.get(type)?.delete(listener);
    if (this.#listeners.get(type)?.size === 0) this.#listeners.delete(type);
  }
  dispatchKey(type, code) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'code', { value: code });
    this.dispatchEvent(event);
  }
  dispatchGamepad(type, index) {
    const event = new Event(type);
    Object.defineProperty(event, 'gamepad', { value: { index } });
    this.dispatchEvent(event);
  }
  counts() { return Object.fromEntries([...this.#listeners].sort().map(([type, listeners]) => [type, listeners.size])); }
}

class VisibilityTarget extends CountingEventTarget { hidden = false; }
