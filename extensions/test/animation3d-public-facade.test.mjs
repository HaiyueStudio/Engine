import assert from 'node:assert/strict';
import test from 'node:test';

import * as animation3d from '../dist/animation3d.js';

const {
  Animation3DError,
  Animation3DMixer,
  Animation3DPoseApplier,
  Animation3DPoseBuffer,
  Animation3DStateMachineController,
  Animation3DStateMachineValidationError,
  compileAnimation3DStateMachineDefinition,
  validateAnimation3DStateMachineDefinition,
} = animation3d;

const TARGET = Object.freeze({ kind: 'node-id', nodeId: 'node' });

class TestResolver {
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
      read(out) { out.set(values); },
      write(source) {
        for (let index = 0; index < values.length; index++) {
          values[index] = source[index] ?? 0;
        }
      },
    };
  }
}

function scalarBinding(id = 'value') {
  return {
    id,
    target: TARGET,
    path: 'property',
    component: 'test',
    property: id,
    valueType: 'scalar',
    valueSize: 1,
  };
}

function track(binding, times = [0, 1], values = [0, 1]) {
  return {
    id: `${binding.id}.track`,
    binding,
    interpolation: 'linear',
    times: new Float32Array(times),
    values: new Float32Array(values),
  };
}

function clip(id, tracks = []) {
  return {
    format: 'haiyue-animation3d-clip@1',
    id,
    name: id,
    duration: 1,
    tracks,
    events: [],
  };
}

function machine(clipId = 'idle') {
  return {
    format: 'haiyue-animation3d-state-machine@1',
    id: 'machine',
    name: 'Machine',
    parameters: [],
    layers: [{
      id: 'base',
      name: 'Base',
      initialStateId: 'idle',
      states: [{
        id: 'idle',
        name: 'Idle',
        motion: { kind: 'clip', clipId },
      }],
      transitions: [],
    }],
  };
}

function assertAnimationError(operation, code) {
  let caught = null;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Animation3DError);
  assert.equal(caught.code, code);
  return caught;
}

test('stable facade exports only the approved runtime values', () => {
  assert.deepEqual(Object.keys(animation3d).sort(), [
    'Animation3DError',
    'Animation3DMixer',
    'Animation3DPoseApplier',
    'Animation3DPoseBuffer',
    'Animation3DStateMachineController',
    'Animation3DStateMachineValidationError',
    'HyaAnimation3DRuntime',
    'compileAnimation3DStateMachineDefinition',
    'createHyaAnimation3DRuntime',
    'validateAnimation3DStateMachineDefinition',
  ]);
});

test('facade uses stable domain codes for mixer, clip, track, action id and resolver failures', () => {
  const resolver = new TestResolver();
  const binding = scalarBinding();
  resolver.set(binding, [0]);
  const mixer = new Animation3DMixer(resolver);

  const invalidClip = {
    ...clip('invalid-format'),
    format: 'unknown',
  };
  assertAnimationError(
    () => mixer.createAction(null),
    'invalid-clip',
  );
  assertAnimationError(
    () => mixer.createAction(invalidClip),
    'invalid-clip',
  );

  const invalidTrack = track(binding, [0.5, 0.25], [0, 1]);
  assertAnimationError(
    () => mixer.createAction(clip('invalid-track', [invalidTrack])),
    'invalid-track',
  );

  const runtimeClip = clip('valid', [track(binding)]);
  const action = mixer.createAction(runtimeClip, { id: 'shared-id' });
  assertAnimationError(
    () => mixer.createAction(runtimeClip, { id: 'shared-id' }),
    'duplicate-action-id',
  );

  const missingMixer = new Animation3DMixer(new TestResolver());
  missingMixer.createAction(runtimeClip).play();
  const bindingMiss = assertAnimationError(
    () => missingMixer.evaluate(new Animation3DPoseBuffer()),
    'resolver-miss',
  );
  assert.equal(bindingMiss.details.resolver, 'binding');
  assert.equal(bindingMiss.details.bindingId, binding.id);

  const poseBuffer = new Animation3DPoseBuffer();
  poseBuffer.reset(0);
  poseBuffer.write(binding, [1]);
  const applierMiss = assertAnimationError(
    () => new Animation3DPoseApplier(new TestResolver()).apply(poseBuffer.seal()),
    'resolver-miss',
  );
  assert.equal(applierMiss.details.resolver, 'binding');

  const compiled = compileAnimation3DStateMachineDefinition(machine('missing'));
  const clipMiss = assertAnimationError(
    () => new Animation3DStateMachineController(
      compiled,
      new Animation3DMixer(new TestResolver()),
      { resolve: () => null },
    ),
    'resolver-miss',
  );
  assert.equal(clipMiss.details.resolver, 'clip');
  assert.equal(clipMiss.details.clipId, 'missing');

  mixer.destroy();
  mixer.destroy();
  assertAnimationError(
    () => mixer.update(0, new Animation3DPoseBuffer()),
    'mixer-destroyed',
  );
  assertAnimationError(() => action.play(), 'mixer-destroyed');
});

test('PoseBuffer and mixer preserve pose, channel and value scratch identity in steady state', () => {
  const resolver = new TestResolver();
  const binding = scalarBinding('stable');
  resolver.set(binding, [0]);
  const mixer = new Animation3DMixer(resolver);
  mixer.createAction(clip('stable', [track(binding)])).play();
  const out = new Animation3DPoseBuffer();
  const first = mixer.update(0.1, out);
  const channels = first.channels;
  const events = first.events;
  const channel = channels[0];
  const value = channel.value;

  for (let frame = 0; frame < 100; frame++) {
    const next = mixer.update(1 / 600, out);
    assert.equal(next, first);
    assert.equal(next.channels, channels);
    assert.equal(next.events, events);
    assert.equal(next.channels[0], channel);
    assert.equal(next.channels[0].value, value);
  }
});

test('public validation/compiler/controller surface is opaque and lifecycle-safe', () => {
  const invalid = {
    ...machine(),
    layers: [{
      ...machine().layers[0],
      initialStateId: 'missing',
    }],
  };
  const issues = validateAnimation3DStateMachineDefinition(invalid);
  assert.equal(issues.some(issue => issue.path === 'layers[0].initialStateId'), true);
  assert.throws(
    () => compileAnimation3DStateMachineDefinition(invalid),
    error => error instanceof Animation3DStateMachineValidationError
      && error.issues.some(issue => issue.path === 'layers[0].initialStateId'),
  );

  const idle = clip('idle');
  const compiled = compileAnimation3DStateMachineDefinition(machine());
  assert.deepEqual(
    { format: compiled.format, id: compiled.id, name: compiled.name },
    {
      format: 'haiyue-animation-state-machine-compiled@1',
      id: 'machine',
      name: 'Machine',
    },
  );
  const controller = new Animation3DStateMachineController(
    compiled,
    new Animation3DMixer(new TestResolver()),
    { resolve: clipId => clipId === idle.id ? idle : null },
  );
  const out = new Animation3DPoseBuffer();
  assert.equal(controller.update(0.25, out).mixerTime, 0.25);
  assert.equal(controller.getLayerSnapshot('base').currentStateId, 'idle');
  controller.reset(out);
  controller.destroy();
  controller.destroy();
  assert.equal(controller.status, 'destroyed');
});
