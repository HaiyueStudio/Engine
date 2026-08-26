import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DeterministicRandom,
  FixedStepClock,
  hashSimulationState,
  InputActionMap,
  ReplayInputController,
} from '../dist/experimental/simulation.js';

test('fixed-step replay produces the same trace and state hash at 30/60/120/variable display cadence', () => {
  const replay = {
    schemaVersion: 1,
    tickRateHz: 60,
    seed: 'g06-cadence',
    events: [
      action(1, 0, 'MoveX', 'down', 1),
      action(15, 1, 'Jump', 'down'),
      action(16, 2, 'Jump', 'up'),
      pointer(30, 3, 'down', 0.2, 0.3, 0),
      pointer(31, 4, 'move', 0.7, 0.6),
      pointer(32, 5, 'up', 0.7, 0.6, 0),
      action(90, 6, 'MoveX', 'up'),
    ],
  };
  const schedules = [
    Array(60).fill(1_000 / 30),
    Array(120).fill(1_000 / 60),
    Array(240).fill(1_000 / 120),
    variableSchedule(2_000),
  ];
  const results = schedules.map(schedule => runReplay(schedule, replay));
  assert.deepEqual(results.map(result => result.tick), [120, 120, 120, 120]);
  for (const result of results.slice(1)) {
    assert.deepEqual(result.trace, results[0].trace);
    assert.equal(result.hash, results[0].hash);
  }
});

test('fixed clock pause, exact step and retained backlog never use wall-clock time', () => {
  const clock = new FixedStepClock({ tickRateHz: 60, maxSubSteps: 2 });
  const ticks = [];
  clock.pause().advance(1_000, step => ticks.push(step.tick));
  assert.deepEqual(ticks, []);
  clock.step(2, step => ticks.push(step.tick));
  assert.deepEqual(ticks, [1, 2]);
  clock.resume();
  const first = clock.advance(100, step => ticks.push(step.tick));
  assert.equal(first.ticks, 2);
  assert.ok(first.backlogTicks >= 3);
  clock.advance(0, step => ticks.push(step.tick));
  assert.deepEqual(ticks, [1, 2, 3, 4]);
});

test('blur, disconnect, stop and restart clear held action and pointer input idempotently', () => {
  const input = new ReplayInputController();
  input.inject(action(1, 0, 'Move', 'down'));
  input.inject(pointer(1, 1, 'down', 0.25, 0.5, 0));
  input.inject({ kind: 'reset', tick: 2, order: 2, source: 'system', reason: 'blur' });
  input.beginTick(1);
  assert.equal(input.isPressed('Move'), true);
  assert.equal(input.pointer(1).dragging, true);
  input.beginTick(2);
  assert.equal(input.isPressed('Move'), false);
  assert.equal(input.wasReleased('Move'), true);
  assert.equal(input.pointer(1).dragging, false);
  input.reset().reset();
  assert.equal(input.tick, 0);
  assert.equal(input.snapshot().actions.length, 0);

  for (const reason of ['disconnect', 'stop', 'restart']) {
    input.inject(action(1, 0, 'Fire', 'down'));
    input.inject({ kind: 'reset', tick: 2, order: 1, source: 'system', reason });
    input.beginTick(1);
    input.beginTick(2);
    assert.equal(input.isPressed('Fire'), false, reason);
    input.reset();
  }
});

test('puzzle, platform, racing and shooter event fixtures use one bounded replay API', () => {
  const fixtures = {
    puzzle: [pointer(1, 0, 'down', 0.1, 0.2, 0), pointer(2, 1, 'move', 0.8, 0.7), pointer(3, 2, 'up', 0.8, 0.7, 0)],
    platform: [action(1, 0, 'MoveRight', 'down'), action(10, 1, 'Jump', 'down'), action(11, 2, 'Jump', 'up'), action(30, 3, 'MoveRight', 'up')],
    racing: [action(1, 0, 'Throttle', 'value', 1), action(1, 1, 'Steer', 'value', -0.5), action(60, 2, 'Steer', 'value', 0.75)],
    shooter: [pointer(1, 0, 'move', 0.65, 0.35), action(2, 1, 'Fire', 'down'), action(3, 2, 'Fire', 'up')],
  };
  for (const [name, events] of Object.entries(fixtures)) {
    const input = new ReplayInputController({ maxQueuedEvents: 32, maxEventsPerTick: 8 });
    for (const event of events) input.inject(event);
    const lastTick = Math.max(...events.map(event => event.tick));
    const observed = [];
    for (let tick = 1; tick <= lastTick; tick += 1) observed.push(input.beginTick(tick));
    assert.ok(observed.some(snapshot => snapshot.events.length > 0), name);
  }
  const puzzle = replaySnapshots(fixtures.puzzle, 3);
  assert.equal(puzzle[0].pointers[0].dragging, true);
  assert.equal(puzzle[2].pointers[0].dragging, false);
  assert.equal(puzzle[2].pointers[0].x, 0.8);
  const platform = replaySnapshots(fixtures.platform, 30);
  assert.equal(platform[9].actions.find(item => item.action === 'Jump').down, true);
  const racing = replaySnapshots(fixtures.racing, 60);
  assert.equal(racing[0].actions.find(item => item.action === 'Throttle').value, 1);
  assert.equal(racing[59].actions.find(item => item.action === 'Steer').value, 0.75);
  const shooter = replaySnapshots(fixtures.shooter, 3);
  assert.equal(shooter[1].actions.find(item => item.action === 'Fire').down, true);
});

test('standard action map normalizes keyboard, pointer and gamepad bindings', () => {
  const map = new InputActionMap({
    Jump: { keys: ['Space'], gamepadButtons: [0] },
    Fire: { pointerButtons: [0], gamepadButtons: [7] },
    Steer: { gamepadAxes: [{ axis: 0, direction: 'both', deadZone: 0.2 }] },
  });
  assert.deepEqual(map.actionsForKey('Space'), ['Jump']);
  assert.deepEqual(map.actionsForPointerButton(0), ['Fire']);
  const sampled = map.sampleGamepad({ connected: true, buttons: [{ pressed: true, value: 1 }], axes: [-0.6] });
  assert.equal(sampled.find(item => item.action === 'Jump').value, 1);
  assert.ok(sampled.find(item => item.action === 'Steer').value < -0.4);
  assert.deepEqual(new InputActionMap(map.toJSON()).toJSON(), map.toJSON());
});

test('seed and canonical state hashing are reproducible and key-order independent', () => {
  const left = new DeterministicRandom('same-seed');
  const right = new DeterministicRandom('same-seed');
  assert.deepEqual(Array.from({ length: 20 }, () => left.nextUint32()), Array.from({ length: 20 }, () => right.nextUint32()));
  assert.equal(hashSimulationState({ b: [2, 3], a: 1 }), hashSimulationState({ a: 1, b: [2, 3] }));
  assert.throws(() => hashSimulationState({ value: Number.NaN }));
});

function runReplay(schedule, replay) {
  const clock = new FixedStepClock({ tickRateHz: replay.tickRateHz });
  const input = new ReplayInputController().load(replay);
  const random = new DeterministicRandom(replay.seed);
  const state = { x: 0, jumps: 0, pointer: [0, 0], sample: random.nextUint32() };
  const trace = [];
  for (const delta of schedule) {
    clock.advance(delta, step => {
      input.beginTick(step.tick);
      state.x += input.value('MoveX');
      if (input.wasPressed('Jump')) state.jumps += 1;
      const pointerState = input.pointer(1);
      state.pointer = [pointerState.x, pointerState.y];
      trace.push(hashSimulationState({ tick: step.tick, state, input: input.snapshot().hash }));
    });
  }
  return { tick: clock.tick, trace, hash: hashSimulationState(state) };
}

function replaySnapshots(events, lastTick) {
  const input = new ReplayInputController();
  for (const event of events) input.inject(event);
  return Array.from({ length: lastTick }, (_, index) => input.beginTick(index + 1));
}

function action(tick, order, actionName, phase, value) {
  return { kind: 'action', tick, order, source: 'synthetic', action: actionName, phase, ...(value === undefined ? {} : { value }) };
}

function pointer(tick, order, phase, x, y, button) {
  return { kind: 'pointer', tick, order, source: 'synthetic', phase, pointerId: 1, x, y, ...(button === undefined ? {} : { button }) };
}

function variableSchedule(totalMs) {
  const pattern = [5, 11, 27, 8, 19, 33, 7, 15];
  const result = [];
  let total = 0;
  let index = 0;
  while (total < totalMs) {
    const next = Math.min(pattern[index++ % pattern.length], totalMs - total);
    result.push(next);
    total += next;
  }
  return result;
}
