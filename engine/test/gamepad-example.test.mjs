import assert from 'node:assert/strict';
import test from 'node:test';
import {BrowserMultiplayerInput} from '../dist/experimental/simulation.js';
import {BUTTONS, AXES, bindings, OperationLog, LOG_LIMIT} from '../../examples/gamepad-input/model.ts';

function fixture() {
  let pad = {connected: true, axes: [0, 0, 0, 0], buttons: BUTTONS.map(() => ({value: 0, pressed: false}))};
  const log = new OperationLog();
  const sampler = new BrowserMultiplayerInput({eventTarget: new EventTarget(), visibilityTarget: new EventTarget(), players: [{id: 'test', gamepadIndex: 0, bindings}], getGamepads: () => [pad]});
  return {log, sampler, get pad() {return pad;}, disconnect() {pad = null;}, sample(time) {const frame = sampler.sample(sampler.tick + 1).players[0]; log.sample(frame, time); return frame;}};
}

test('standard layout exposes every button, both sticks, and continuous trigger pressure', t => {
  const f = fixture(); t.after(() => f.sampler.dispose());
  for (let i = 0; i < BUTTONS.length; i++) f.pad.buttons[i] = {value: i === 6 ? 0.35 : 1, pressed: i !== 6};
  f.pad.axes = [-1, 0.5, 0.01, 1];
  const values = Object.fromEntries(f.sample(0).actions.map(a => [a.action, a.value]));
  for (const name of BUTTONS) assert.equal(values[name], name === 'LT' ? 0.35 : 1);
  assert.deepEqual(AXES.map(name => values[name]), [-1, 0.5, 0.01, 1]);
});

test('holding buttons does not flood records; disconnect releases held buttons and analog input', t => {
  const f = fixture(); t.after(() => f.sampler.dispose());
  f.pad.buttons[0] = {value: 1, pressed: true}; f.pad.axes[0] = 0.8; f.pad.buttons[7] = {value: 0.4, pressed: false};
  f.sample(0); for (let i = 1; i < 300; i++) f.sample(i * 16);
  assert.equal(f.log.entries.length, 3);
  f.disconnect(); f.sample(5000);
  assert.equal(f.log.entries.length, 6);
  assert.ok(f.log.entries.some(e => e.control === 'A' && e.detail === '松开'));
  assert.ok(f.log.entries.some(e => e.control === '右摇杆') === false);
  assert.ok(f.log.entries.some(e => e.control === '左摇杆' && e.detail === '回中'));
  assert.ok(f.log.entries.some(e => e.control === 'RT' && e.detail === '松开'));
});

test('stick noise is visible in sampled input but excluded from the operation log', t => {
  const f = fixture(); t.after(() => f.sampler.dispose());
  f.pad.axes[0] = 0.07; f.sample(0); f.pad.axes[0] = -0.1; f.sample(1000);
  assert.equal(f.log.entries.length, 0);
  f.pad.axes[0] = 0.5; f.sample(1010); f.pad.axes[0] = 0.9; f.sample(1100);
  assert.equal(f.log.entries.length, 1);
  f.sample(1200); assert.equal(f.log.entries.length, 2);
  f.pad.axes[0] = 0; f.sample(1210); assert.equal(f.log.entries[0].detail, '回中');
});

test('analog trigger logs light pressure, changes and release without threshold duplication', t => {
  const f = fixture(); t.after(() => f.sampler.dispose());
  for (const [time, value] of [[0, 0.1], [200, 0.8], [210, 0]]) {
    f.pad.buttons[6] = {value, pressed: value > 0.5}; f.sample(time);
  }
  assert.deepEqual(f.log.entries.map(e => [e.control, e.detail]), [['LT', '松开'], ['LT', '压力 80%'], ['LT', '压力 10%']]);
});

test('log bounds, clear and device reset preserve ordered independent events', () => {
  const log = new OperationLog();
  for (let i = 0; i < 150; i++) log.add(i, 'A', '按下');
  assert.equal(log.entries.length, LOG_LIMIT); assert.equal(log.entries[0].time, 149); assert.equal(log.entries.at(-1).time, 50);
  log.clear(); assert.equal(log.entries.length, 0); log.reset(); log.add(200, 'B', '按下');
  assert.equal(log.entries[0].id, 151);
});
