import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation3DStateMachineController,
  Animation3DStateMachineValidationError,
  compileAnimation3DStateMachine,
  evaluateAnimation3DBlend1DWeights,
  evaluateAnimation3DBlend2DWeights,
  validateAnimation3DStateMachineDefinition,
} from '../dist-test/animation3d/runtime/state-machine/index.js';

class FakeMixerPort {
  constructor(durations = {}) {
    this.durations = durations;
    this.actions = [];
    this.events = [];
    this.nextId = 0;
  }

  createAction(clipId, options) {
    const action = {
      id: this.nextId++,
      clipId,
      options,
      duration: this.durations[clipId] ?? 1,
      playing: false,
      destroyed: false,
      weight: 0,
      time: 0,
      timeScale: 1,
    };
    this.actions.push(action);
    this.events.push(['create', action.id, clipId]);
    return action;
  }

  play(action) {
    action.playing = true;
    this.events.push(['play', action.id]);
  }

  stop(action) {
    action.playing = false;
    this.events.push(['stop', action.id]);
  }

  fade(action, targetWeight, duration) {
    this.events.push(['fade', action.id, targetWeight, duration]);
  }

  setWeight(action, weight) {
    action.weight = weight;
  }

  setTime(action, time) {
    action.time = time;
  }

  setTimeScale(action, timeScale) {
    action.timeScale = timeScale;
  }

  destroyAction(action) {
    action.destroyed = true;
    this.events.push(['destroy', action.id]);
  }

  liveActions() {
    return this.actions.filter(action => !action.destroyed);
  }

  liveByClip(clipId) {
    return this.liveActions().filter(action => action.clipId === clipId);
  }
}

function machine({
  parameters = [],
  states,
  transitions = [],
  layers,
} = {}) {
  return {
    format: 'haiyue-animation3d-state-machine@1',
    id: 'machine',
    name: 'Machine',
    parameters,
    layers: layers ?? [{
      id: 'base',
      name: 'Base',
      initialStateId: states[0].id,
      states,
      transitions,
    }],
  };
}

function clipState(id, extra = {}) {
  return {
    id,
    name: id,
    motion: { kind: 'clip', clipId: id },
    ...extra,
  };
}

function transition(id, from, to, conditions = [], extra = {}) {
  return {
    id,
    from,
    to,
    conditions,
    duration: 0,
    ...extra,
  };
}

test('compiler resolves hot-path references and declaration order beats any-state', () => {
  const definition = machine({
    parameters: [
      { name: 'speed', type: 'float', defaultValue: 0 },
      { name: 'alert', type: 'boolean', defaultValue: false },
    ],
    states: [clipState('idle'), clipState('walk'), clipState('alert')],
    transitions: [
      transition('explicit-first', 'idle', 'walk', [{
        parameter: 'speed', operator: 'greater', value: 0,
      }], { duration: 1 }),
      transition('any-second', '*', 'alert', [{
        parameter: 'alert', operator: 'is-true',
      }], { duration: 1 }),
    ],
  });
  const compiled = compileAnimation3DStateMachine(definition);
  assert.equal(compiled.layers[0].transitions[0].fromStateIndex, 0);
  assert.equal(compiled.layers[0].transitions[0].toStateIndex, 1);
  assert.equal(compiled.layers[0].transitions[0].conditions[0].parameterIndex, 0);

  const port = new FakeMixerPort();
  const controller = new Animation3DStateMachineController(compiled, port);
  controller.setFloat('speed', 2).setBoolean('alert', true).update(0);
  assert.equal(controller.getLayerSnapshot('base').transitionId, 'explicit-first');
  controller.destroy();

  const anyPort = new FakeMixerPort();
  const anyController = new Animation3DStateMachineController(compiled, anyPort);
  anyController.setBoolean('alert', true).update(0);
  assert.equal(anyController.getLayerSnapshot('base').transitionId, 'any-second');
  anyController.destroy();
});

test('trigger is consumed only by the selected successful transition', () => {
  const compiled = compileAnimation3DStateMachine(machine({
    parameters: [{ name: 'jump', type: 'trigger' }],
    states: [clipState('idle'), clipState('jump')],
    transitions: [transition('jump', 'idle', 'jump', [{
      parameter: 'jump', operator: 'triggered',
    }])],
  }));
  const controller = new Animation3DStateMachineController(compiled, new FakeMixerPort());
  controller.setTrigger('jump');
  assert.equal(controller.getParameter('jump'), true);
  controller.update(0);
  assert.equal(controller.getLayerSnapshot('base').currentStateId, 'jump');
  assert.equal(controller.getParameter('jump'), false);
  controller.destroy();
});

test('exitTime uses normalized clip time and destinationOffset is normalized', () => {
  const compiled = compileAnimation3DStateMachine(machine({
    states: [clipState('idle', { loop: 'once' }), clipState('done')],
    transitions: [transition('finish', 'idle', 'done', [], {
      hasExitTime: true,
      exitTime: 0.5,
      destinationOffset: 0.5,
    })],
  }));
  const port = new FakeMixerPort({ idle: 2, done: 4 });
  const controller = new Animation3DStateMachineController(compiled, port);
  controller.update(0.99);
  assert.equal(controller.getLayerSnapshot('base').currentStateId, 'idle');
  controller.update(0.01);
  const snapshot = controller.getLayerSnapshot('base');
  assert.equal(snapshot.currentStateId, 'done');
  assert.ok(Math.abs(snapshot.currentTime - 2) < 1e-9);
  assert.ok(Math.abs(port.liveByClip('done')[0].time - 2) < 1e-9);
  controller.destroy();
});

for (const [strategy, expected] of [
  ['none', 'a-to-b'],
  ['source', 'a-to-c'],
  ['destination', 'b-to-d'],
  ['source-then-destination', 'a-to-c'],
  ['destination-then-source', 'b-to-d'],
]) {
  test(`transition interruption strategy ${strategy} is deterministic`, () => {
    const compiled = compileAnimation3DStateMachine(machine({
      parameters: [
        { name: 'start', type: 'boolean', defaultValue: false },
        { name: 'source', type: 'boolean', defaultValue: false },
        { name: 'destination', type: 'boolean', defaultValue: false },
      ],
      states: [
        clipState('a'),
        clipState('b'),
        clipState('c'),
        clipState('d'),
      ],
      transitions: [
        transition('a-to-b', 'a', 'b', [{
          parameter: 'start', operator: 'is-true',
        }], { duration: 2, interruption: strategy }),
        transition('a-to-c', 'a', 'c', [{
          parameter: 'source', operator: 'is-true',
        }], { duration: 1 }),
        transition('b-to-d', 'b', 'd', [{
          parameter: 'destination', operator: 'is-true',
        }], { duration: 1 }),
      ],
    }));
    const controller = new Animation3DStateMachineController(compiled, new FakeMixerPort());
    controller.setBoolean('start', true).update(0);
    controller
      .setBoolean('source', true)
      .setBoolean('destination', true)
      .update(0);
    assert.equal(controller.getLayerSnapshot('base').transitionId, expected);
    controller.destroy();
  });
}

test('1D and 2D blend weights interpolate and clamp deterministically', () => {
  const definition = machine({
    parameters: [
      { name: 'x', type: 'float', defaultValue: 0 },
      { name: 'y', type: 'float', defaultValue: 0 },
    ],
    states: [{
      id: 'blend',
      name: 'Blend',
      motion: {
        kind: 'blend-1d',
        parameter: 'x',
        children: [
          { threshold: 0, motion: { kind: 'clip', clipId: 'slow' } },
          { threshold: 10, motion: { kind: 'clip', clipId: 'fast' } },
        ],
      },
    }],
  });
  const compiled = compileAnimation3DStateMachine(definition);
  const blend1D = compiled.layers[0].states[0].motion;
  assert.deepEqual([...evaluateAnimation3DBlend1DWeights(blend1D, 5)], [0.5, 0.5]);
  assert.deepEqual([...evaluateAnimation3DBlend1DWeights(blend1D, 20)], [0, 1]);

  const cartesianDefinition = machine({
    parameters: definition.parameters,
    states: [{
      id: 'cartesian',
      name: 'Cartesian',
      motion: {
        kind: 'blend-2d',
        algorithm: 'cartesian',
        parameterX: 'x',
        parameterY: 'y',
        children: [
          { position: [-1, -1], motion: { kind: 'clip', clipId: 'lb' } },
          { position: [1, -1], motion: { kind: 'clip', clipId: 'rb' } },
          { position: [1, 1], motion: { kind: 'clip', clipId: 'rt' } },
          { position: [-1, 1], motion: { kind: 'clip', clipId: 'lt' } },
        ],
      },
    }],
  });
  const cartesian = compileAnimation3DStateMachine(
    cartesianDefinition,
  ).layers[0].states[0].motion;
  const outsideA = evaluateAnimation3DBlend2DWeights(cartesian, 5, 0);
  const outsideB = evaluateAnimation3DBlend2DWeights(cartesian, 50, 0);
  assert.deepEqual([...outsideA], [...outsideB]);
  assert.ok(Math.abs(outsideA[1] + outsideA[2] - 1) < 1e-9);
  assert.equal(outsideA[0] + outsideA[3], 0);

  const directionalDefinition = machine({
    parameters: definition.parameters,
    states: [{
      id: 'directional',
      name: 'Directional',
      motion: {
        kind: 'blend-2d',
        algorithm: 'directional',
        parameterX: 'x',
        parameterY: 'y',
        children: [
          { position: [0, 0], motion: { kind: 'clip', clipId: 'idle' } },
          { position: [1, 0], motion: { kind: 'clip', clipId: 'right' } },
          { position: [0, 1], motion: { kind: 'clip', clipId: 'up' } },
        ],
      },
    }],
  });
  const directional = compileAnimation3DStateMachine(
    directionalDefinition,
  ).layers[0].states[0].motion;
  const directionalWeights = evaluateAnimation3DBlend2DWeights(
    directional,
    0.5,
    0.5,
  );
  assert.ok(Math.abs(directionalWeights[1] - directionalWeights[2]) < 1e-9);
  assert.ok(Math.abs([...directionalWeights].reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});

test('controller applies blend weights and independent layer weight/mask/mode', () => {
  const blendMotion = {
    kind: 'blend-1d',
    parameter: 'speed',
    children: [
      { threshold: 0, motion: { kind: 'clip', clipId: 'walk' } },
      { threshold: 10, motion: { kind: 'clip', clipId: 'run' } },
    ],
  };
  const compiled = compileAnimation3DStateMachine(machine({
    parameters: [{ name: 'speed', type: 'float', defaultValue: 5 }],
    layers: [
      {
        id: 'base',
        name: 'Base',
        initialStateId: 'move',
        states: [{ id: 'move', name: 'Move', motion: blendMotion }],
        transitions: [],
        weight: 0.8,
        mask: { exclude: ['face'] },
        blendMode: 'override',
      },
      {
        id: 'face',
        name: 'Face',
        initialStateId: 'expression',
        states: [clipState('expression')],
        transitions: [],
        weight: 0.25,
        mask: { include: ['face'] },
        blendMode: 'additive',
      },
    ],
  }));
  const port = new FakeMixerPort();
  const controller = new Animation3DStateMachineController(compiled, port);
  assert.ok(Math.abs(port.liveByClip('walk')[0].weight - 0.4) < 1e-9);
  assert.ok(Math.abs(port.liveByClip('run')[0].weight - 0.4) < 1e-9);
  assert.equal(port.liveByClip('expression')[0].weight, 0.25);
  assert.deepEqual(port.liveByClip('walk')[0].options.mask, { exclude: ['face'] });
  assert.equal(port.liveByClip('walk')[0].options.blendMode, 'override');
  assert.deepEqual(port.liveByClip('expression')[0].options.mask, { include: ['face'] });
  assert.equal(port.liveByClip('expression')[0].options.blendMode, 'additive');
  controller.destroy();
});

test('validation reports structured paths for invalid references, values and trees', () => {
  const recursiveMotion = {
    kind: 'blend-1d',
    parameter: 'number',
    children: [],
  };
  recursiveMotion.children.push({ threshold: 0, motion: recursiveMotion });
  const invalid = machine({
    parameters: [
      { name: 'number', type: 'integer', defaultValue: 0 },
      { name: 'number', type: 'float', defaultValue: 0 },
      { name: 'flag', type: 'boolean', defaultValue: false },
    ],
    layers: [{
      id: 'bad',
      name: 'Bad',
      initialStateId: 'missing',
      weight: 2,
      states: [
        clipState('same'),
        {
          id: 'same',
          name: 'Duplicate',
          motion: {
            kind: 'blend-1d',
            parameter: 'number',
            children: [
              { threshold: 1, motion: { kind: 'clip', clipId: 'one' } },
              { threshold: 1, motion: { kind: 'clip', clipId: 'two' } },
            ],
          },
        },
        { id: 'cycle', name: 'Cycle', motion: recursiveMotion },
        {
          id: 'empty',
          name: 'Empty',
          motion: {
            kind: 'blend-2d',
            algorithm: 'cartesian',
            parameterX: 'number',
            parameterY: 'number',
            children: [],
          },
        },
      ],
      transitions: [
        transition('duplicate', 'missing', 'nope', [{
          parameter: 'flag', operator: 'greater', value: 1,
        }], { duration: -1, hasExitTime: true, exitTime: -0.1 }),
        transition('duplicate', '*', 'same'),
      ],
    }],
  });
  const issues = validateAnimation3DStateMachineDefinition(invalid);
  const paths = new Set(issues.map(issue => issue.path));
  assert.ok(paths.has('parameters[1].name'));
  assert.ok(paths.has('layers[0].weight'));
  assert.ok(paths.has('layers[0].initialStateId'));
  assert.ok(paths.has('layers[0].states[1].id'));
  assert.ok(paths.has('layers[0].states[1].motion.children[1].threshold'));
  assert.ok(paths.has('layers[0].states[2].motion.children[0].motion'));
  assert.ok(paths.has('layers[0].states[3].motion.children'));
  assert.ok(paths.has('layers[0].transitions[0].from'));
  assert.ok(paths.has('layers[0].transitions[0].to'));
  assert.ok(paths.has('layers[0].transitions[0].duration'));
  assert.ok(paths.has('layers[0].transitions[0].exitTime'));
  assert.ok(paths.has('layers[0].transitions[0].conditions[0].operator'));
  assert.ok(paths.has('layers[0].transitions[1].id'));
  assert.throws(
    () => compileAnimation3DStateMachine(invalid),
    error => error instanceof Animation3DStateMachineValidationError
      && error.issues.some(issue => issue.path === 'layers[0].initialStateId'),
  );
});

test('large delta crosses deterministic exits and zero-duration cycles are bounded', () => {
  const chain = compileAnimation3DStateMachine(machine({
    states: [
      clipState('a', { loop: 'once' }),
      clipState('b', { loop: 'once' }),
      clipState('c'),
    ],
    transitions: [
      transition('a-b', 'a', 'b', [], { hasExitTime: true, exitTime: 0.25 }),
      transition('b-c', 'b', 'c', [], { hasExitTime: true, exitTime: 0.25 }),
    ],
  }));
  const chainController = new Animation3DStateMachineController(chain, new FakeMixerPort());
  chainController.update(10);
  assert.equal(chainController.getLayerSnapshot('base').currentStateId, 'c');
  assert.equal(chainController.transitionLimitReached, false);
  chainController.destroy();

  const cycle = compileAnimation3DStateMachine(machine({
    states: [clipState('a'), clipState('b')],
    transitions: [
      transition('a-b', 'a', 'b'),
      transition('b-a', 'b', 'a'),
    ],
  }));
  const cyclePort = new FakeMixerPort();
  const cycleController = new Animation3DStateMachineController(
    cycle,
    cyclePort,
    { maxTransitionsPerUpdate: 8 },
  );
  cycleController.update(100);
  assert.equal(cycleController.transitionLimitReached, true);
  assert.equal(cycleController.lastUpdateTransitionCount, 8);
  assert.equal(cycleController.getLayerSnapshot('base').currentStateId, 'a');
  assert.equal(cyclePort.liveActions().length, 1);
  cycleController.destroy();
});

test('controller reset and destroy are idempotent', () => {
  const compiled = compileAnimation3DStateMachine(machine({
    states: [clipState('idle')],
  }));
  const port = new FakeMixerPort();
  const controller = new Animation3DStateMachineController(compiled, port);
  controller.reset().reset();
  assert.equal(controller.getLayerSnapshot('base').currentStateId, 'idle');
  assert.equal(port.liveActions().length, 1);
  controller.destroy();
  const eventCount = port.events.length;
  controller.destroy();
  controller.reset();
  assert.equal(controller.status, 'destroyed');
  assert.equal(port.liveActions().length, 0);
  assert.equal(port.events.length, eventCount);
});
