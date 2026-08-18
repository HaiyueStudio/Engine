import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation3DStateMachineMixerIntegration,
} from '../dist-test/animation3d/runtime/integration/index.js';
import {
  Animation3DMixerRuntime,
  Animation3DPoseBuffer,
} from '../dist-test/animation3d/runtime/mixer/index.js';
import {
  compileAnimation3DStateMachine,
} from '../dist-test/animation3d/runtime/state-machine/index.js';

const NODE = Object.freeze({ kind: 'node-id', nodeId: 'node' });

class TestBindingResolver {
  revision = 0;
  values = new Map();

  set(binding, values) {
    this.values.set(binding.id, new Float32Array(values));
  }

  resolve(binding) {
    const values = this.values.get(binding.id);
    if (!values) return null;
    return {
      binding,
      read(out) {
        out.set(values);
      },
      write(source) {
        for (let index = 0; index < values.length; index++) {
          values[index] = source[index] ?? 0;
        }
      },
    };
  }
}

class TestClipResolver {
  constructor(clips) {
    this.clips = new Map(clips.map(value => [value.id, value]));
    this.resolveCalls = 0;
  }

  resolve(clipId) {
    this.resolveCalls++;
    return this.clips.get(clipId) ?? null;
  }
}

function translationBinding(id) {
  return {
    id,
    target: NODE,
    path: 'transform.translation',
    valueType: 'vec3',
    valueSize: 3,
  };
}

function rotationBinding(id) {
  return {
    id,
    target: NODE,
    path: 'transform.rotation',
    valueType: 'quaternion',
    valueSize: 4,
  };
}

function weightsBinding(id, size) {
  return {
    id,
    target: NODE,
    path: 'morph.weights',
    valueType: 'weights',
    valueSize: size,
  };
}

function scalarBinding(id) {
  return {
    id,
    target: NODE,
    path: 'property',
    component: 'test',
    property: id,
    valueType: 'scalar',
    valueSize: 1,
  };
}

function track(binding, times, values, interpolation = 'linear') {
  return {
    id: `${binding.id}-track`,
    binding,
    interpolation,
    times: new Float32Array(times),
    values: new Float32Array(values),
  };
}

function clip(id, tracks = [], options = {}) {
  return {
    format: 'haiyue-animation3d-clip@1',
    id,
    name: id,
    duration: options.duration ?? 1,
    tracks,
    events: options.events ?? [],
  };
}

function clipState(id, options = {}) {
  return {
    id,
    name: id,
    motion: { kind: 'clip', clipId: options.clipId ?? id },
    ...options,
  };
}

function transition(id, from, to, conditions = [], options = {}) {
  return {
    id,
    from,
    to,
    conditions,
    duration: 0,
    ...options,
  };
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

function createRuntime(definition, clips, bindings = []) {
  const bindingResolver = new TestBindingResolver();
  for (const [binding, values] of bindings) bindingResolver.set(binding, values);
  const mixer = new Animation3DMixerRuntime(bindingResolver);
  const clipResolver = new TestClipResolver(clips);
  const integration = new Animation3DStateMachineMixerIntegration(
    compileAnimation3DStateMachine(definition),
    mixer,
    clipResolver,
  );
  return { bindingResolver, mixer, clipResolver, integration };
}

function channel(pose, bindingId) {
  const result = pose.channels.find(entry => entry.binding.id === bindingId);
  assert.ok(result, `Missing pose channel "${bindingId}".`);
  return result;
}

function assertClose(actual, expected, epsilon = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    assert.ok(
      delta <= epsilon,
      `${index}: ${actual[index]} differs from ${expected[index]} by ${delta}`,
    );
  }
}

test('controller is the unique clock owner and destinationOffset seeks the real action', () => {
  const root = translationBinding('root.translation');
  const idle = clip('idle', [track(root, [0], [0, 0, 0], 'step')], {
    duration: 2,
  });
  const run = clip('run', [track(root, [0, 2], [0, 0, 0, 2, 0, 0])], {
    duration: 2,
  });
  const definition = machine({
    parameters: [{ name: 'go', type: 'trigger' }],
    states: [clipState('idle'), clipState('run')],
    transitions: [transition('go', 'idle', 'run', [{
      parameter: 'go',
      operator: 'triggered',
    }], { destinationOffset: 0.5 })],
  });
  const { mixer, integration } = createRuntime(
    definition,
    [idle, run],
    [[root, [0, 0, 0]]],
  );
  const out = new Animation3DPoseBuffer();
  let mixerUpdateCalls = 0;
  const originalMixerUpdate = mixer.update.bind(mixer);
  mixer.update = (...args) => {
    mixerUpdateCalls++;
    return originalMixerUpdate(...args);
  };

  integration.controller.setTrigger('go');
  const offsetPose = integration.update(0, out);
  assert.equal(mixerUpdateCalls, 0);
  assert.equal(integration.time, 0);
  assert.equal(mixer.time, 0);
  assert.equal(mixer.actions.length, 1);
  assert.equal(mixer.actions[0].clip.id, 'run');
  assert.equal(mixer.actions[0].time, 1);
  assertClose(channel(offsetPose, root.id).value, [1, 0, 0]);

  const advancedPose = integration.update(0.25, out);
  assert.equal(mixerUpdateCalls, 0);
  assert.equal(integration.time, 0.25);
  assert.equal(mixer.time, 0.25);
  assert.equal(integration.controller.getLayerSnapshot('base').currentTime, 1.25);
  assert.equal(mixer.actions[0].time, 1.25);
  assertClose(channel(advancedPose, root.id).value, [1.25, 0, 0]);

  const evaluatedPose = integration.evaluate(out);
  assert.equal(mixerUpdateCalls, 0);
  assert.equal(mixer.actions[0].time, 1.25);
  assert.deepEqual(evaluatedPose.events, []);
  assertClose(channel(evaluatedPose, root.id).value, [1.25, 0, 0]);
});

test('real crossfade blends root transform, skinning joint, and morph weights', () => {
  const root = translationBinding('root.translation');
  const joint = rotationBinding('skin.joint.rotation');
  const morph = weightsBinding('face.weights', 3);
  const source = clip('source', [
    track(root, [0], [0, 0, 0], 'step'),
    track(joint, [0], [0, 0, 0, 1], 'step'),
    track(morph, [0], [0, 0, 0], 'step'),
  ], { duration: 2 });
  const destination = clip('destination', [
    track(root, [0], [10, 0, 0], 'step'),
    track(joint, [0], [0, 0, 1, 0], 'step'),
    track(morph, [0], [1, 0.5, 0.25], 'step'),
  ], { duration: 2 });
  const definition = machine({
    parameters: [{ name: 'go', type: 'boolean', defaultValue: false }],
    states: [clipState('source'), clipState('destination')],
    transitions: [transition('crossfade', 'source', 'destination', [{
      parameter: 'go',
      operator: 'is-true',
    }], { duration: 2 })],
  });
  const { mixer, integration } = createRuntime(
    definition,
    [source, destination],
    [
      [root, [0, 0, 0]],
      [joint, [0, 0, 0, 1]],
      [morph, [0, 0, 0]],
    ],
  );
  const out = new Animation3DPoseBuffer();

  integration.controller.setBoolean('go', true);
  integration.update(0, out);
  assert.equal(mixer.actions.length, 2);
  const midpoint = integration.update(1, out);
  assertClose(channel(midpoint, root.id).value, [5, 0, 0]);
  assertClose(
    channel(midpoint, joint.id).value,
    [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  );
  assertClose(channel(midpoint, morph.id).value, [0.5, 0.25, 0.125]);

  const endpoint = integration.update(1, out);
  assert.equal(mixer.actions.length, 1);
  assert.equal(mixer.actions[0].clip.id, 'destination');
  assertClose(channel(endpoint, root.id).value, [10, 0, 0]);
  assertClose(channel(endpoint, joint.id).value, [0, 0, 1, 0]);
  assertClose(channel(endpoint, morph.id).value, [1, 0.5, 0.25]);
});

test('layer weight, binding mask, and additive blending reach the real mixer', () => {
  const body = scalarBinding('body.value');
  const face = scalarBinding('face.value');
  const baseClip = clip('base-clip', [
    track(body, [0], [2], 'step'),
    track(face, [0], [4], 'step'),
  ], { duration: 2 });
  const additiveClip = clip('additive-clip', [
    track(body, [0, 2], [0, 10]),
    track(face, [0, 2], [0, 6]),
  ], { duration: 2 });
  const definition = machine({
    layers: [
      {
        id: 'base',
        name: 'Base',
        initialStateId: 'base-state',
        states: [clipState('base-state', { clipId: 'base-clip' })],
        transitions: [],
        blendMode: 'override',
        weight: 1,
      },
      {
        id: 'detail',
        name: 'Detail',
        initialStateId: 'detail-state',
        states: [clipState('detail-state', { clipId: 'additive-clip' })],
        transitions: [],
        blendMode: 'additive',
        weight: 0.5,
        mask: { include: [face.id] },
      },
    ],
  });
  const { integration } = createRuntime(
    definition,
    [baseClip, additiveClip],
    [[body, [0]], [face, [0]]],
  );
  const pose = integration.update(1, new Animation3DPoseBuffer());

  assertClose(channel(pose, body.id).value, [2]);
  assertClose(channel(pose, face.id).value, [5.5]);
});

test('repeat events survive large delta and reverse playback exactly once', () => {
  const eventClip = clip('events', [], {
    duration: 1,
    events: [
      { id: 'a', time: 0.25, name: 'a' },
      { id: 'b', time: 0.75, name: 'b' },
    ],
  });
  const definition = machine({
    parameters: [{ name: 'rate', type: 'float', defaultValue: 1 }],
    states: [clipState('events', {
      loop: 'repeat',
      speedParameter: 'rate',
    })],
  });
  const { integration } = createRuntime(definition, [eventClip]);
  const out = new Animation3DPoseBuffer();

  assert.deepEqual(
    integration.update(2.1, out).events.map(entry => entry.event.name),
    ['a', 'b', 'a', 'b'],
  );
  integration.controller.setFloat('rate', -1);
  assert.deepEqual(
    integration.update(1.5, out).events.map(entry => entry.event.name),
    ['b', 'a', 'b'],
  );
  assert.equal(integration.controller.getLayerSnapshot('base').currentTime, 0.6000000000000001);
});

test('ping-pong sampling uses the controller playhead for large and reverse deltas', () => {
  const value = scalarBinding('ping.value');
  const ping = clip('ping', [track(value, [0, 1], [0, 10])]);
  const definition = machine({
    parameters: [{ name: 'rate', type: 'float', defaultValue: 1 }],
    states: [clipState('ping', {
      loop: 'ping-pong',
      speedParameter: 'rate',
    })],
  });
  const { integration } = createRuntime(
    definition,
    [ping],
    [[value, [0]]],
  );
  const out = new Animation3DPoseBuffer();
  assertClose(channel(integration.update(2.25, out), value.id).value, [2.5]);
  integration.controller.setFloat('rate', -1);
  assertClose(channel(integration.update(0.5, out), value.id).value, [2.5]);
  assert.equal(integration.controller.getLayerSnapshot('base').currentTime, 1.75);
});

test('transition interruption preserves event cursor and releases discarded actions', () => {
  const a = clip('a');
  const b = clip('b', [], {
    duration: 1,
    events: [
      { id: 'b25', time: 0.25, name: 'b25' },
      { id: 'b75', time: 0.75, name: 'b75' },
    ],
  });
  const c = clip('c', [], {
    duration: 1,
    events: [
      { id: 'c25', time: 0.25, name: 'c25' },
      { id: 'c75', time: 0.75, name: 'c75' },
    ],
  });
  const definition = machine({
    parameters: [
      { name: 'start', type: 'boolean', defaultValue: false },
      { name: 'interrupt', type: 'boolean', defaultValue: false },
    ],
    states: [
      clipState('a'),
      clipState('b', { loop: 'once' }),
      clipState('c', { loop: 'once' }),
    ],
    transitions: [
      transition('a-to-b', 'a', 'b', [{
        parameter: 'start',
        operator: 'is-true',
      }], { duration: 2, interruption: 'destination' }),
      transition('b-to-c', 'b', 'c', [{
        parameter: 'interrupt',
        operator: 'is-true',
      }], { duration: 1 }),
    ],
  });
  const { mixer, integration } = createRuntime(definition, [a, b, c]);
  const out = new Animation3DPoseBuffer();
  integration.controller.setBoolean('start', true);
  integration.update(0, out);
  assert.equal(mixer.actions.length, 2);
  assert.deepEqual(
    integration.update(0.5, out).events.map(entry => entry.event.name),
    ['b25'],
  );
  const retainedB = mixer.actions.find(action => action.clip.id === 'b');
  assert.ok(retainedB);

  integration.controller.setBoolean('interrupt', true);
  assert.deepEqual(integration.update(0, out).events, []);
  assert.equal(mixer.actions.length, 2);
  assert.equal(mixer.actions.includes(retainedB), true);
  assert.deepEqual(
    integration.update(1.2, out).events.map(entry => entry.event.name),
    ['b75', 'c25', 'c75'],
  );
  assert.equal(mixer.actions.length, 1);
  assert.equal(mixer.actions[0].clip.id, 'c');
  assert.equal(mixer.actions.includes(retainedB), false);

  integration.destroy();
  integration.destroy();
  assert.equal(integration.state, 'destroyed');
  assert.equal(mixer.actions.length, 0);
  assert.equal(mixer.state, 'active');
  assert.throws(() => integration.controller.update(0), /destroyed/);
  assert.throws(() => retainedB.play(), /no longer valid/);
});

test('clip resolution failure rolls back real actions and retains no clip ownership', () => {
  const valid = clip('valid');
  const definition = machine({
    states: [{
      id: 'blend',
      name: 'blend',
      motion: {
        kind: 'blend-1d',
        parameter: 'blend',
        children: [
          { threshold: 0, motion: { kind: 'clip', clipId: 'valid' } },
          { threshold: 1, motion: { kind: 'clip', clipId: 'missing' } },
        ],
      },
    }],
    parameters: [{ name: 'blend', type: 'float', defaultValue: 0 }],
  });
  const mixer = new Animation3DMixerRuntime(new TestBindingResolver());
  const clipResolver = new TestClipResolver([valid]);

  assert.throws(
    () => new Animation3DStateMachineMixerIntegration(
      compileAnimation3DStateMachine(definition),
      mixer,
      clipResolver,
    ),
    /could not resolve "missing"/,
  );
  assert.equal(mixer.actions.length, 0);
  assert.equal(clipResolver.resolveCalls, 2);
  assert.equal(mixer.state, 'active');
});

test('failed destination resolution cancels the synchronized frame without clock drift', () => {
  const valid = clip('valid');
  const definition = machine({
    parameters: [{ name: 'go', type: 'boolean', defaultValue: false }],
    states: [
      clipState('valid'),
      clipState('missing'),
    ],
    transitions: [transition('invalid-destination', 'valid', 'missing', [{
      parameter: 'go',
      operator: 'is-true',
    }])],
  });
  const { mixer, integration } = createRuntime(definition, [valid]);
  const out = new Animation3DPoseBuffer();
  integration.update(0.5, out);
  integration.controller.setBoolean('go', true);

  assert.throws(() => integration.update(0.25, out), /could not resolve "missing"/);
  assert.equal(integration.time, 0.5);
  assert.equal(mixer.time, 0.5);
  assert.equal(mixer.actions.length, 1);
  assert.equal(mixer.actions[0].clip.id, 'valid');

  integration.controller.setBoolean('go', false);
  assert.equal(integration.evaluate(out).mixerTime, 0.5);
  integration.destroy();
  assert.equal(mixer.actions.length, 0);
});

test('exit-time destination failure rolls controller, action, parameter, and mixer clocks back atomically', () => {
  const valid = clip('valid');
  const definition = machine({
    parameters: [{ name: 'go', type: 'boolean', defaultValue: false }],
    states: [
      clipState('valid'),
      clipState('missing'),
    ],
    transitions: [transition('delayed-invalid-destination', 'valid', 'missing', [{
      parameter: 'go',
      operator: 'is-true',
    }], {
      hasExitTime: true,
      exitTime: 0.75,
    })],
  });
  const { mixer, integration } = createRuntime(definition, [valid]);
  const out = new Animation3DPoseBuffer();
  integration.update(0.5, out);
  integration.controller.setBoolean('go', true);

  assert.throws(() => integration.update(0.4, out), /could not resolve "missing"/);
  assert.equal(integration.time, 0.5);
  assert.equal(mixer.time, 0.5);
  assert.equal(integration.controller.getLayerSnapshot('base').currentTime, 0.5);
  assert.equal(integration.controller.getParameter('go'), true);
  assert.equal(mixer.actions.length, 1);
  assert.equal(mixer.actions[0].time, 0.5);

  integration.controller.setBoolean('go', false);
  assert.equal(integration.evaluate(out).mixerTime, 0.5);
  assert.equal(mixer.actions[0].time, 0.5);
  integration.destroy();
});

test('later-layer failure restores transitions and deferred action destruction from earlier layers', () => {
  const baseSource = clip('base-source');
  const baseDestination = clip('base-destination');
  const overlaySource = clip('overlay-source');
  const definition = machine({
    parameters: [
      { name: 'advanceBase', type: 'boolean', defaultValue: false },
      { name: 'failOverlay', type: 'boolean', defaultValue: false },
    ],
    layers: [
      {
        id: 'base',
        name: 'Base',
        initialStateId: 'base-source',
        states: [clipState('base-source'), clipState('base-destination')],
        transitions: [transition('advance-base', 'base-source', 'base-destination', [{
          parameter: 'advanceBase',
          operator: 'is-true',
        }])],
      },
      {
        id: 'overlay',
        name: 'Overlay',
        initialStateId: 'overlay-source',
        states: [clipState('overlay-source'), clipState('overlay-missing', {
          clipId: 'missing',
        })],
        transitions: [transition('fail-overlay', 'overlay-source', 'overlay-missing', [{
          parameter: 'failOverlay',
          operator: 'is-true',
        }])],
      },
    ],
  });
  const { mixer, integration } = createRuntime(
    definition,
    [baseSource, baseDestination, overlaySource],
  );
  const out = new Animation3DPoseBuffer();
  integration.controller
    .setBoolean('advanceBase', true)
    .setBoolean('failOverlay', true);

  assert.throws(() => integration.update(0, out), /could not resolve "missing"/);
  assert.equal(integration.controller.getLayerSnapshot('base').currentStateId, 'base-source');
  assert.equal(integration.controller.getLayerSnapshot('overlay').currentStateId, 'overlay-source');
  assert.equal(integration.controller.getParameter('advanceBase'), true);
  assert.equal(integration.controller.getParameter('failOverlay'), true);
  assert.deepEqual(
    mixer.actions.map(action => action.clip.id).sort(),
    ['base-source', 'overlay-source'],
  );
  assert.equal(mixer.actions.every(action => action.status === 'running'), true);

  integration.controller
    .setBoolean('advanceBase', false)
    .setBoolean('failOverlay', false);
  integration.evaluate(out);
  integration.destroy();
  assert.equal(mixer.actions.length, 0);
});

test('pose evaluation failure restores action event cursors and retries the crossed event once', () => {
  const value = scalarBinding('animated.value');
  const animated = clip('animated', [track(value, [0, 1], [0, 1])], {
    events: [{ id: 'middle', time: 0.5, name: 'middle' }],
  });
  const { mixer, integration } = createRuntime(
    machine({ states: [clipState('animated')] }),
    [animated],
    [[value, [0]]],
  );
  const out = new Animation3DPoseBuffer();
  integration.update(0.25, out);
  const failingOut = {
    reset: mixerTime => out.reset(mixerTime),
    write: () => { throw new Error('synthetic pose write failure'); },
    emit: event => out.emit(event),
    seal: () => out.seal(),
  };

  assert.throws(
    () => integration.update(0.5, failingOut),
    /synthetic pose write failure/,
  );
  assert.equal(integration.time, 0.25);
  assert.equal(mixer.time, 0.25);
  assert.equal(integration.controller.getLayerSnapshot('base').currentTime, 0.25);
  assert.equal(mixer.actions[0].time, 0.25);

  const retried = integration.update(0.5, out);
  assert.deepEqual(retried.events.map(entry => entry.event.name), ['middle']);
  assert.equal(integration.update(0, out).events.length, 0);
  integration.destroy();
});
