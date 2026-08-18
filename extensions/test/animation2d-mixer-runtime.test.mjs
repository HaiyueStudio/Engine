import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation2DMixerRuntime,
  Animation2DPoseBuffer,
  Animation2DSampler,
} from '../dist-test/animation/runtime/mixer/index.js';
import {
  createAnimation2DStateMachineController,
} from '../dist-test/animation/Animation2DStateMachine.js';

const EPSILON = 1e-5;

function binding(id, path, strategy, valueSize, defaultValue) {
  return {
    id,
    targetId: 'node',
    path,
    strategy,
    ...(valueSize === undefined ? {} : { valueSize }),
    ...(defaultValue === undefined ? {} : { defaultValue }),
  };
}

function numericTrack(target, values, options = {}) {
  return {
    id: options.id ?? `${target.id}-track`,
    binding: target,
    interpolation: options.interpolation ?? 'linear',
    times: new Float32Array(options.times ?? [0, 1]),
    values: new Float32Array(values),
  };
}

function discreteTrack(target, values, options = {}) {
  return {
    id: options.id ?? `${target.id}-track`,
    binding: target,
    interpolation: 'step',
    times: new Float32Array(options.times ?? values.map((_, index) => index)),
    values,
  };
}

function clip(id, tracks, options = {}) {
  return {
    format: 'haiyue-animation2d-clip@1',
    id,
    name: id,
    duration: options.duration ?? 1,
    tracks,
    effects: options.effects ?? [],
  };
}

function channel(pose, id) {
  return pose.channels.find(entry => entry.binding.id === id);
}

function assertClose(actual, expected, epsilon = EPSILON) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= epsilon,
      `${index}: ${actual[index]} differs from ${expected[index]}`,
    );
  }
}

test('Animation2DSampler interpolates numeric/color values, wraps rotation by the shortest arc, and steps discrete values', () => {
  const position = binding('position', 'transform.position', 'continuous', 2, [0, 0]);
  const positionSampler = new Animation2DSampler(numericTrack(position, [0, 10, 10, 20]));
  const output = positionSampler.output;
  assert.equal(positionSampler.sample(0.5), output);
  assertClose(output, [5, 15]);

  const color = binding('color', 'color', 'continuous', 4, [1, 1, 1, 1]);
  const colorSampler = new Animation2DSampler(numericTrack(
    color,
    [1, 0, 0, 1, 0, 0, 1, 1],
  ));
  assertClose(colorSampler.sample(0.5), [0.5, 0, 0.5, 1]);

  const rotation = binding('rotation', 'transform.rotation', 'rotation', 1, [0]);
  const degrees = value => value * Math.PI / 180;
  const rotationSampler = new Animation2DSampler(numericTrack(
    rotation,
    [degrees(350), degrees(10)],
  ));
  assert.ok(Math.abs(rotationSampler.sample(0.5)[0]) <= EPSILON);

  const text = binding('text', 'text', 'discrete');
  const textSampler = new Animation2DSampler(discreteTrack(text, ['idle', 'hit'], {
    times: [0, 0.5],
  }));
  assert.equal(textSampler.sample(0.49), 'idle');
  assert.equal(textSampler.sample(0.5), 'hit');
});

test('Animation2DSampler follows spatial cubic controls independently from temporal easing', () => {
  const position = binding('curved-position', 'transform.position', 'continuous', 2, [0, 0]);
  const sampler = new Animation2DSampler({
    ...numericTrack(position, [0, 0, 100, 0]),
    spatialTangents: new Float32Array([0, 100, 0, 100]),
  });
  assertClose(sampler.sample(0), [0, 0]);
  assertClose(sampler.sample(0.5), [50, 75]);
  assertClose(sampler.sample(1), [100, 0]);
  assert.throws(() => new Animation2DSampler({
    ...numericTrack(binding('bad', 'opacity', 'continuous', 2, [0, 0]), [0, 0, 1, 1]),
    spatialTangents: new Float32Array([0, 0, 0, 0]),
  }), /transform.position/);
});

test('Animation2DMixer blends sampled transform, opacity, color, and crossfades without angle discontinuity', () => {
  const position = binding('position', 'transform.position', 'continuous', 2, [0, 0]);
  const opacity = binding('opacity', 'opacity', 'continuous', 1, [1]);
  const color = binding('color', 'color', 'continuous', 4, [1, 1, 1, 1]);
  const sampled = clip('sampled', [
    numericTrack(position, [0, 0, 10, 20]),
    numericTrack(opacity, [0, 1]),
    numericTrack(color, [1, 0, 0, 1, 0, 0, 1, 1]),
  ]);
  const mixer = new Animation2DMixerRuntime();
  mixer.createAction(sampled).play();
  const pose = mixer.update(0.5, new Animation2DPoseBuffer());
  assertClose(channel(pose, 'position').value, [5, 10]);
  assertClose(channel(pose, 'opacity').value, [0.5]);
  assertClose(channel(pose, 'color').value, [0.5, 0, 0.5, 1]);

  const sourceMixer = new Animation2DMixerRuntime();
  const rotation = binding('rotation', 'transform.rotation', 'rotation', 1, [0]);
  const degrees = value => value * Math.PI / 180;
  const source = sourceMixer.createAction(clip('source', [
    numericTrack(position, [0, 0], { times: [0] }),
    numericTrack(rotation, [degrees(170)], { times: [0] }),
  ]), { clampWhenFinished: true }).play();
  const destination = sourceMixer.createAction(clip('destination', [
    numericTrack(position, [10, 0], { times: [0] }),
    numericTrack(rotation, [degrees(-170)], { times: [0] }),
  ]), { clampWhenFinished: true });
  destination.crossFadeFrom(source, 1);
  const crossfadePose = new Animation2DPoseBuffer();
  const middle = sourceMixer.update(0.5, crossfadePose);
  assertClose(channel(middle, 'position').value, [5, 0]);
  assert.ok(Math.abs(Math.abs(channel(middle, 'rotation').value[0]) - Math.PI) <= EPSILON);
  assertClose(channel(sourceMixer.update(0.5, crossfadePose), 'position').value, [10, 0]);
});

test('Animation2DMixer applies ascending layers, masks, and deterministic discrete/dominant winners', () => {
  const position = binding('position', 'transform.position', 'continuous', 2, [0, 0]);
  const opacity = binding('opacity', 'opacity', 'continuous', 1, [1]);
  const visible = binding('visible', 'visibility', 'discrete');
  const text = binding('text', 'text', 'discrete');
  const sprite = binding('sprite', 'sprite', 'discrete');
  const composite = binding('composite', 'composite', 'dominant');
  const sourceComposite = Object.freeze({ kind: 'mask', source: 'source-a' });
  const destinationComposite = Object.freeze({ kind: 'mask', source: 'source-b' });

  const mixer = new Animation2DMixerRuntime();
  mixer.createAction(clip('lower', [
    numericTrack(position, [2, 4], { times: [0] }),
    numericTrack(opacity, [0.4], { times: [0] }),
    discreteTrack(visible, [true], { times: [0] }),
    discreteTrack(text, ['lower'], { times: [0] }),
    discreteTrack(sprite, ['sprite-a'], { times: [0] }),
    discreteTrack(composite, [sourceComposite], { times: [0] }),
  ]), { layer: 0 }).play();
  const equal = mixer.createAction(clip('equal', [
    discreteTrack(visible, [false], { times: [0] }),
    discreteTrack(text, ['equal'], { times: [0] }),
    discreteTrack(sprite, ['sprite-b'], { times: [0] }),
    discreteTrack(composite, [destinationComposite], { times: [0] }),
  ]), { layer: 0 }).play();
  const upper = mixer.createAction(clip('upper', [
    numericTrack(position, [10, 12], { times: [0] }),
    numericTrack(opacity, [0], { times: [0] }),
  ]), {
    layer: 1,
    weight: 0.5,
    mask: { include: ['position'] },
  }).play();

  const pose = new Animation2DPoseBuffer();
  let result = mixer.evaluate(pose);
  assertClose(channel(result, 'position').value, [6, 8]);
  assertClose(channel(result, 'opacity').value, [0.4]);
  assert.equal(channel(result, 'visible').value, true, 'first equal-weight source wins');
  assert.equal(channel(result, 'text').value, 'lower');
  assert.equal(channel(result, 'sprite').value, 'sprite-a');
  assert.equal(channel(result, 'composite').value, sourceComposite);

  equal.weight = 1.1;
  result = mixer.evaluate(pose);
  assert.equal(channel(result, 'visible').value, false);
  assert.equal(channel(result, 'text').value, 'equal');
  assert.equal(channel(result, 'sprite').value, 'sprite-b');
  assert.equal(channel(result, 'composite').value, destinationComposite);

  upper.weight = 1;
  result = mixer.evaluate(pose);
  assertClose(channel(result, 'position').value, [10, 12]);
});

test('Animation2DAction supports repeat, reverse, and seek for sampled values', () => {
  const position = binding('position', 'transform.position', 'continuous', 1, [0]);
  const mixer = new Animation2DMixerRuntime();
  const action = mixer.createAction(clip('looping', [
    numericTrack(position, [0, 10]),
  ]), { loop: 'repeat' }).play();
  const pose = new Animation2DPoseBuffer();

  assertClose(channel(mixer.update(1.25, pose), 'position').value, [2.5]);
  action.reverse();
  assertClose(channel(mixer.update(0.5, pose), 'position').value, [7.5]);
  action.seek(0.2);
  assertClose(channel(mixer.evaluate(pose), 'position').value, [2]);
});

test('Animation2D effects emit enter, loop/restart, reverse-loop, and exit exactly once', () => {
  const mixer = new Animation2DMixerRuntime();
  const action = mixer.createAction(clip('effects', [], {
    duration: 1,
    effects: [
      { id: 'music', kind: 'audio', start: 0, end: 1 },
      { id: 'sparks', kind: 'particle', start: 0, end: 1 },
    ],
  }), { loop: 'repeat' }).play();
  const pose = new Animation2DPoseBuffer();

  assert.deepEqual(
    mixer.update(0, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['music:enter', 'sparks:enter'],
  );
  assert.deepEqual(
    mixer.update(1.1, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['music:loop', 'sparks:restart'],
  );
  assert.equal(mixer.update(0.1, pose).effects.length, 0);

  action.reverse();
  assert.deepEqual(
    mixer.update(0.3, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['music:loop', 'sparks:restart'],
  );
  action.stop();
  assert.deepEqual(
    mixer.evaluate(pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['music:exit', 'sparks:exit'],
  );
  assert.equal(mixer.evaluate(pose).effects.length, 0);
});

test('Animation2D effect seek and reverse interval crossings are deterministic and exactly once', () => {
  const mixer = new Animation2DMixerRuntime();
  const action = mixer.createAction(clip('seek-effects', [], {
    effects: [{ id: 'voice', kind: 'audio', start: 0.2, end: 0.8 }],
  })).play();
  const pose = new Animation2DPoseBuffer();

  assert.deepEqual(
    mixer.update(0.3, pose).effects.map(event => event.lifecycle),
    ['enter'],
  );
  action.seek(0.9);
  assert.deepEqual(
    mixer.evaluate(pose).effects.map(event => event.lifecycle),
    ['exit', 'seek'],
  );
  assert.equal(mixer.evaluate(pose).effects.length, 0);

  action.seek(0.4);
  assert.deepEqual(
    mixer.evaluate(pose).effects.map(event => event.lifecycle),
    ['seek', 'enter'],
  );
  action.reverse();
  assert.deepEqual(
    mixer.update(0.3, pose).effects.map(event => event.lifecycle),
    ['exit'],
  );
  assert.equal(mixer.update(0.05, pose).effects.length, 0);
});

test('Animation2D finite repeat exits effects at the terminal boundary without starting another cycle', () => {
  const mixer = new Animation2DMixerRuntime();
  mixer.createAction(clip('finite-effects', [], {
    effects: [
      { id: 'music', kind: 'audio', start: 0, end: 1 },
      { id: 'burst', kind: 'particle', start: 0, end: 0.5 },
    ],
  }), { loop: 'repeat', repetitions: 2 }).play();
  const pose = new Animation2DPoseBuffer();

  assert.deepEqual(
    mixer.update(0, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['music:enter', 'burst:enter'],
  );
  assert.deepEqual(
    mixer.update(2, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    [
      'music:loop',
      'music:exit',
      'burst:exit',
      'burst:enter',
      'burst:exit',
    ],
  );
  assert.equal(mixer.evaluate(pose).effects.length, 0);
});

test('Animation2D ping-pong effects preserve every crossing across large and reverse deltas', () => {
  const mixer = new Animation2DMixerRuntime();
  const action = mixer.createAction(clip('ping-pong-effects', [], {
    effects: [
      { id: 'voice', kind: 'audio', start: 0.2, end: 0.8 },
      { id: 'trail', kind: 'particle', start: 0, end: 1 },
    ],
  }), { loop: 'ping-pong' }).play();
  const pose = new Animation2DPoseBuffer();

  assert.deepEqual(
    mixer.update(0, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['trail:enter'],
  );
  assert.deepEqual(
    mixer.update(2.3, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    [
      'voice:enter',
      'voice:exit',
      'voice:enter',
      'voice:exit',
      'voice:enter',
      'trail:restart',
      'trail:restart',
    ],
  );

  action.reverse();
  assert.deepEqual(
    mixer.update(0.6, pose).effects.map(event => `${event.cue.id}:${event.lifecycle}`),
    ['voice:exit', 'voice:enter', 'trail:restart'],
  );
  assert.equal(mixer.evaluate(pose).effects.length, 0);
});

test('Animation2DPoseBuffer and sampler results reuse warm storage', () => {
  const opacity = binding('opacity', 'opacity', 'continuous', 1, [1]);
  const runtimeClip = clip('reuse', [numericTrack(opacity, [0, 1])]);
  const mixer = new Animation2DMixerRuntime();
  const action = mixer.createAction(runtimeClip, { loop: 'repeat' }).play();
  const pose = new Animation2DPoseBuffer();

  const first = mixer.update(0.25, pose);
  const channels = first.channels;
  const effects = first.effects;
  const firstChannel = channels[0];
  const firstValue = firstChannel.value;
  const samplerOutput = action.runtimeTracks[0].sampler.output;

  const second = mixer.update(0.25, pose);
  assert.equal(second, first);
  assert.equal(second.channels, channels);
  assert.equal(second.effects, effects);
  assert.equal(second.channels[0], firstChannel);
  assert.equal(second.channels[0].value, firstValue);
  assert.equal(action.runtimeTracks[0].sampler.output, samplerOutput);
  assertClose(second.channels[0].value, [0.5]);
});

test('Animation2DMixer is directly usable as the shared state-machine mixer port', () => {
  const opacity = binding('opacity', 'opacity', 'continuous', 1, [1]);
  const runtimeClip = clip('idle', [numericTrack(opacity, [0.25], { times: [0] })]);
  const mixer = new Animation2DMixerRuntime([runtimeClip]);
  const action = mixer.createAction('idle', {
    layerId: 'base',
    stateId: 'idle',
    loop: 'repeat',
    blendMode: 'override',
    mask: null,
  });
  assert.equal(action.duration, 1);
  mixer.play(action);
  mixer.setWeight(action, 0.5);
  const pose = mixer.evaluate(new Animation2DPoseBuffer());
  assertClose(channel(pose, 'opacity').value, [0.625]);
  mixer.stop(action);
  mixer.destroyAction(action);
  assert.equal(mixer.actions.length, 0);
});

test('Animation2D shared state machine drives real mixer crossfade weights and masks', () => {
  const opacity = binding('root.opacity', 'opacity', 'continuous', 1, [0]);
  const idle = clip('idle', [numericTrack(opacity, [0], { times: [0] })]);
  const pressed = clip('pressed', [numericTrack(opacity, [1], { times: [0] })]);
  const mixer = new Animation2DMixerRuntime([idle, pressed]);
  const controller = createAnimation2DStateMachineController({
    format: 'haiyue-animation-state-machine@1',
    id: 'button',
    name: 'Button',
    parameters: [{ name: 'pressed', type: 'boolean', defaultValue: false }],
    layers: [{
      id: 'base',
      name: 'Base',
      initialStateId: 'idle',
      mask: { include: ['root.opacity'] },
      states: [
        { id: 'idle', name: 'Idle', motion: { kind: 'clip', clipId: 'idle' }, loop: 'repeat' },
        { id: 'pressed', name: 'Pressed', motion: { kind: 'clip', clipId: 'pressed' }, loop: 'once' },
      ],
      transitions: [{
        id: 'press',
        from: 'idle',
        to: 'pressed',
        conditions: [{ parameter: 'pressed', operator: 'is-true' }],
        duration: 0.1,
      }],
    }],
  }, mixer);
  const pose = new Animation2DPoseBuffer();
  assertClose(channel(mixer.evaluate(pose), 'root.opacity').value, [0]);

  controller.setBoolean('pressed', true).update(0.05);
  assertClose(channel(mixer.evaluate(pose), 'root.opacity').value, [0.5]);
  controller.update(0.05);
  assertClose(channel(mixer.evaluate(pose), 'root.opacity').value, [1]);

  controller.destroy();
  mixer.destroy();
});

test('Animation2D state-machine clock synchronization crosses effects without emitting seek every frame', () => {
  const idle = clip('idle', [], {
    effects: [{ id: 'ambience', kind: 'audio', start: 0, end: 1 }],
  });
  const mixer = new Animation2DMixerRuntime([idle]);
  const controller = createAnimation2DStateMachineController({
    format: 'haiyue-animation-state-machine@1',
    id: 'effect-clock',
    name: 'Effect clock',
    parameters: [],
    layers: [{
      id: 'base',
      name: 'Base',
      initialStateId: 'idle',
      states: [{
        id: 'idle',
        name: 'Idle',
        motion: { kind: 'clip', clipId: 'idle' },
        loop: 'repeat',
      }],
      transitions: [],
    }],
  }, mixer);
  const pose = new Animation2DPoseBuffer();

  assert.deepEqual(
    mixer.evaluate(pose).effects.map(event => event.lifecycle),
    ['enter'],
  );
  controller.update(0.2);
  assert.deepEqual(mixer.evaluate(pose).effects, []);
  controller.update(0.9);
  assert.deepEqual(
    mixer.evaluate(pose).effects.map(event => event.lifecycle),
    ['loop'],
  );
  assert.deepEqual(mixer.evaluate(pose).effects, []);

  controller.destroy();
  mixer.destroy();
});
