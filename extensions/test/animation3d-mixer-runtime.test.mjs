import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Animation3DMixerRuntime,
  Animation3DPoseBuffer,
  Animation3DTrackSampler,
} from '../dist-test/animation3d/runtime/mixer/index.js';

const TARGET = Object.freeze({ kind: 'node-id', nodeId: 'node' });

class TestResolver {
  revision = 0;
  resolveCalls = 0;
  values = new Map();

  set(binding, values) {
    this.values.set(binding.id, new Float32Array(values));
  }

  resolve(binding) {
    this.resolveCalls++;
    const values = this.values.get(binding.id);
    if (!values) return null;
    return {
      binding,
      read(out) {
        out.set(values);
      },
      write(source) {
        for (let index = 0; index < values.length; index++) values[index] = source[index] ?? 0;
      },
    };
  }
}

function translationBinding(id = 'translation') {
  return { id, target: TARGET, path: 'transform.translation', valueType: 'vec3', valueSize: 3 };
}

function rotationBinding(id = 'rotation') {
  return { id, target: TARGET, path: 'transform.rotation', valueType: 'quaternion', valueSize: 4 };
}

function scaleBinding(id = 'scale') {
  return { id, target: TARGET, path: 'transform.scale', valueType: 'vec3', valueSize: 3 };
}

function weightsBinding(size, id = 'weights') {
  return { id, target: TARGET, path: 'morph.weights', valueType: 'weights', valueSize: size };
}

function scalarBinding(id) {
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

function track(binding, times, values, interpolation = 'linear', id = `${binding.id}-track`) {
  return {
    id,
    binding,
    interpolation,
    times: new Float32Array(times),
    values: new Float32Array(values),
  };
}

function clip(id, tracks, options = {}) {
  return {
    format: 'haiyue-animation3d-clip@1',
    id,
    name: id,
    duration: options.duration ?? 1,
    tracks,
    events: options.events ?? [],
    ...options.extra,
  };
}

function channel(pose, id) {
  return pose.channels.find(entry => entry.binding.id === id);
}

function assertClose(actual, expected, epsilon = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    assert.ok(delta <= epsilon, `${index}: ${actual[index]} differs from ${expected[index]} by ${delta}`);
  }
}

test('TrackSampler covers STEP, LINEAR, quaternion shortest-path slerp, and CUBIC_SPLINE', () => {
  const step = new Animation3DTrackSampler(
    track(scalarBinding('step'), [0, 1], [2, 8], 'step'),
  );
  assertClose(step.sample(0.75), [2]);

  const linear = new Animation3DTrackSampler(
    track(translationBinding(), [0, 1], [0, 0, 0, 2, 4, 6]),
  );
  const linearScratch = linear.sample(0.5);
  assert.equal(linearScratch, linear.output);
  assertClose(linear.output, [1, 2, 3]);
  for (let sampleIndex = 0; sampleIndex < 100; sampleIndex++) {
    assert.equal(linear.sample(sampleIndex / 100), linearScratch);
  }

  const shortest = new Animation3DTrackSampler(
    track(rotationBinding(), [0, 1], [0, 0, 0, 1, 0, 0, 0, -1]),
  );
  assertClose(shortest.sample(0.5), [0, 0, 0, 1]);

  const morphSize = 5;
  const cubicValues = [
    ...new Array(morphSize).fill(0),
    ...new Array(morphSize).fill(0),
    ...new Array(morphSize).fill(2),
    ...new Array(morphSize).fill(2),
    ...new Array(morphSize).fill(2),
    ...new Array(morphSize).fill(0),
  ];
  const cubicMorph = new Animation3DTrackSampler(
    track(weightsBinding(morphSize), [0, 1], cubicValues, 'cubic-spline'),
  );
  assertClose(cubicMorph.sample(0.5), [1, 1, 1, 1, 1]);

  const cubicQuaternion = new Animation3DTrackSampler(
    track(rotationBinding('cubic-q'), [0, 1], [
      0, 0, 0, 0,
      0, 0, 0, 1,
      0, 0, 1, 0,
      0, 0, 1, 0,
      0, 0, 1, 0,
      0, 0, 0, 0,
    ], 'cubic-spline'),
  );
  const cubicResult = cubicQuaternion.sample(0.5);
  assert.ok(Math.abs(Math.hypot(...cubicResult) - 1) <= 1e-6);
});

test('Mixer evaluates TRS, quaternion, arbitrary morph tracks and reuses caller PoseBuffer storage', () => {
  const translation = translationBinding();
  const rotation = rotationBinding();
  const scale = scaleBinding();
  const weights = weightsBinding(5);
  const runtimeClip = clip('trs-morph', [
    track(translation, [0, 1], [0, 0, 0, 2, 4, 6]),
    track(rotation, [0, 1], [0, 0, 0, 1, 0, 0, 1, 0]),
    track(scale, [0], [2, 3, 4], 'step'),
    track(weights, [0, 1], [
      0, 0.2, 0.4, 0.6, 0.8,
      1, 0.8, 0.6, 0.4, 0.2,
    ]),
  ]);
  const resolver = new TestResolver();
  resolver.set(translation, [0, 0, 0]);
  resolver.set(rotation, [0, 0, 0, 1]);
  resolver.set(scale, [1, 1, 1]);
  resolver.set(weights, [0, 0, 0, 0, 0]);
  const mixer = new Animation3DMixerRuntime(resolver);
  mixer.createAction(runtimeClip).play();
  const out = new Animation3DPoseBuffer();

  const firstPose = mixer.update(0.5, out);
  assertClose(channel(firstPose, translation.id).value, [1, 2, 3]);
  assertClose(channel(firstPose, rotation.id).value, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  assertClose(channel(firstPose, scale.id).value, [2, 3, 4]);
  assertClose(channel(firstPose, weights.id).value, [0.5, 0.5, 0.5, 0.5, 0.5]);

  const channelArray = firstPose.channels;
  const channelValues = firstPose.channels.map(entry => entry.value);
  const sequence = firstPose.sequence;
  const secondPose = mixer.evaluate(out);
  assert.equal(secondPose, firstPose);
  assert.equal(secondPose.channels, channelArray);
  assert.equal(secondPose.sequence, sequence + 1);
  for (let index = 0; index < channelValues.length; index++) {
    assert.equal(secondPose.channels[index].value, channelValues[index]);
  }
});

test('two override actions normalize their weights while preserving the resolver base below total weight one', () => {
  const binding = scalarBinding('override');
  const resolver = new TestResolver();
  resolver.set(binding, [4]);
  const mixer = new Animation3DMixerRuntime(resolver);
  mixer.createAction(clip('low', [track(binding, [0], [0])]), { weight: 0.25 }).play();
  mixer.createAction(clip('high', [track(binding, [0], [10])]), { weight: 0.75 }).play();
  const pose = mixer.evaluate(new Animation3DPoseBuffer());
  assertClose(channel(pose, binding.id).value, [7.5]);

  mixer.stopAllActions();
  const partial = mixer.createAction(
    clip('partial', [track(binding, [0], [10])]),
    { weight: 0.5 },
  ).play();
  assert.ok(partial);
  assertClose(channel(mixer.evaluate(new Animation3DPoseBuffer()), binding.id).value, [7]);
});

test('additive layers apply sampled deltas relative to the track reference pose', () => {
  const binding = translationBinding('additive-translation');
  const resolver = new TestResolver();
  resolver.set(binding, [1, 2, 3]);
  const mixer = new Animation3DMixerRuntime(resolver);
  const action = mixer.createAction(
    clip('additive', [track(binding, [0, 1], [0, 0, 0, 2, 0, 0])]),
    { blendMode: 'additive', weight: 0.5 },
  );
  action.time = 1;
  action.play();
  assertClose(
    channel(mixer.evaluate(new Animation3DPoseBuffer()), binding.id).value,
    [2, 2, 3],
  );
});

test('cross-fade produces the expected midpoint and destination endpoint', () => {
  const binding = scalarBinding('cross-fade');
  const resolver = new TestResolver();
  resolver.set(binding, [0]);
  const mixer = new Animation3DMixerRuntime(resolver);
  const source = mixer.createAction(
    clip('source', [track(binding, [0], [0])], { duration: 2 }),
    { loop: 'repeat' },
  ).play();
  const destination = mixer.createAction(
    clip('destination', [track(binding, [0], [10])], { duration: 2 }),
    { loop: 'repeat' },
  );
  source.crossFadeTo(destination, 2);
  const out = new Animation3DPoseBuffer();

  assertClose(channel(mixer.update(1, out), binding.id).value, [5]);
  assert.ok(Math.abs(source.effectiveWeight - 0.5) <= 1e-6);
  assert.ok(Math.abs(destination.effectiveWeight - 0.5) <= 1e-6);
  assertClose(channel(mixer.update(1, out), binding.id).value, [10]);
  assert.equal(source.effectiveWeight, 0);
  assert.equal(destination.effectiveWeight, 1);
});

test('action controls cover startAt, mixer/action timeScale, pause, reset, stop and fading', () => {
  const binding = scalarBinding('controls');
  const resolver = new TestResolver();
  resolver.set(binding, [0]);
  const mixer = new Animation3DMixerRuntime(resolver);
  mixer.timeScale = 2;
  const action = mixer.createAction(
    clip('controls', [track(binding, [0, 1], [0, 1])]),
    { timeScale: 2, weight: 0.8, clampWhenFinished: true },
  );
  action.startAt(1).play();
  const out = new Animation3DPoseBuffer();

  assert.equal(mixer.update(0.25, out).channels.length, 0);
  assert.equal(action.status, 'scheduled');
  mixer.update(0.25, out);
  assert.equal(action.status, 'running');
  assert.equal(action.time, 0);
  mixer.timeScale = 1;
  mixer.update(0.25, out);
  assert.equal(action.time, 0.5);

  action.paused = true;
  mixer.update(0.25, out);
  assert.equal(action.time, 0.5);
  assert.equal(action.status, 'paused');
  action.paused = false;
  action.fadeIn(2);
  mixer.update(1, out);
  assert.ok(Math.abs(action.effectiveWeight - 0.4) <= 1e-6);
  action.stopFading();
  const stoppedFadeWeight = action.effectiveWeight;
  mixer.update(0.25, out);
  assert.ok(Math.abs(action.effectiveWeight - stoppedFadeWeight) <= 1e-6);
  action.fadeOut(0);
  assert.equal(action.effectiveWeight, 0);

  action.reset();
  assert.equal(action.status, 'idle');
  assert.equal(action.time, 0);
  action.play().stop();
  assert.equal(action.status, 'stopped');
  assert.equal(action.enabled, false);
});

test('repeat, ping-pong, repetitions, clampWhenFinished and reverse playback retain terminal poses', () => {
  const binding = scalarBinding('looping');
  const resolver = new TestResolver();
  resolver.set(binding, [0]);
  const runtimeClip = clip('looping', [track(binding, [0, 1], [0, 10])]);

  const repeatMixer = new Animation3DMixerRuntime(resolver);
  const repeat = repeatMixer.createAction(runtimeClip, {
    loop: 'repeat',
    repetitions: 3,
    clampWhenFinished: true,
  }).play();
  const repeatOut = new Animation3DPoseBuffer();
  assertClose(channel(repeatMixer.update(1.25, repeatOut), binding.id).value, [2.5]);
  assert.equal(repeat.time, 0.25);
  assertClose(channel(repeatMixer.update(1.75, repeatOut), binding.id).value, [10]);
  assert.equal(repeat.status, 'finished');

  const pingMixer = new Animation3DMixerRuntime(resolver);
  const ping = pingMixer.createAction(runtimeClip, {
    loop: 'ping-pong',
    repetitions: 3,
    clampWhenFinished: true,
  }).play();
  const pingOut = new Animation3DPoseBuffer();
  assertClose(channel(pingMixer.update(1.25, pingOut), binding.id).value, [7.5]);
  assert.equal(ping.time, 0.75);
  assertClose(channel(pingMixer.update(1.75, pingOut), binding.id).value, [10]);
  assert.equal(ping.status, 'finished');

  const reverseMixer = new Animation3DMixerRuntime(resolver);
  const reverse = reverseMixer.createAction(runtimeClip, {
    loop: 'once',
    clampWhenFinished: true,
    timeScale: -1,
  });
  reverse.time = 1;
  reverse.play();
  const reverseOut = new Animation3DPoseBuffer();
  assertClose(channel(reverseMixer.update(0.25, reverseOut), binding.id).value, [7.5]);
  assertClose(channel(reverseMixer.update(0.75, reverseOut), binding.id).value, [0]);
  assert.equal(reverse.status, 'finished');
});

test('clip events are emitted once in traversal order across loops, large deltas, and reverse playback', () => {
  const runtimeClip = clip('events', [], {
    duration: 1,
    events: [
      { id: 'a', time: 0.25, name: 'a' },
      { id: 'b', time: 0.75, name: 'b' },
    ],
  });
  const mixer = new Animation3DMixerRuntime(new TestResolver());
  const action = mixer.createAction(runtimeClip, { loop: 'repeat' }).play();
  const out = new Animation3DPoseBuffer();

  assert.deepEqual(
    mixer.update(2.1, out).events.map(entry => entry.event.name),
    ['a', 'b', 'a', 'b'],
  );
  action.timeScale = -1;
  assert.deepEqual(
    mixer.update(1.5, out).events.map(entry => entry.event.name),
    ['b', 'a', 'b'],
  );
});

test('clip events at playback boundaries are emitted once rather than skipped or duplicated', () => {
  const boundaryClip = clip('boundary-events', [], {
    duration: 1,
    events: [
      { id: 'start', time: 0, name: 'start' },
      { id: 'end', time: 1, name: 'end' },
    ],
  });
  const forwardMixer = new Animation3DMixerRuntime(new TestResolver());
  forwardMixer.createAction(boundaryClip, { loop: 'repeat' }).play();
  const out = new Animation3DPoseBuffer();
  assert.deepEqual(
    forwardMixer.update(1.1, out).events.map(entry => entry.event.name),
    ['start', 'end', 'start'],
  );
  assert.equal(forwardMixer.update(0.1, out).events.length, 0);

  const reverseMixer = new Animation3DMixerRuntime(new TestResolver());
  const reverse = reverseMixer.createAction(boundaryClip, {
    timeScale: -1,
    clampWhenFinished: true,
  });
  reverse.time = 1;
  reverse.play();
  assert.deepEqual(
    reverseMixer.update(0.1, out).events.map(entry => entry.event.name),
    ['end'],
  );
  assert.equal(reverseMixer.update(0.1, out).events.length, 0);
});

test('binding masks support include and exclude filtering', () => {
  const a = scalarBinding('mask-a');
  const b = scalarBinding('mask-b');
  const c = scalarBinding('mask-c');
  const resolver = new TestResolver();
  resolver.set(a, [0]);
  resolver.set(b, [0]);
  resolver.set(c, [0]);
  const mixer = new Animation3DMixerRuntime(resolver);
  const action = mixer.createAction(clip('mask', [
    track(a, [0], [1]),
    track(b, [0], [2]),
    track(c, [0], [3]),
  ]), {
    mask: { include: [a.id, b.id], exclude: [b.id] },
  }).play();
  const out = new Animation3DPoseBuffer();

  assert.deepEqual(mixer.evaluate(out).channels.map(entry => entry.binding.id), [a.id]);
  action.mask = { exclude: [c.id] };
  assert.deepEqual(mixer.evaluate(out).channels.map(entry => entry.binding.id), [a.id, b.id]);
});

test('resolver revision invalidates resolved-binding cache without changing the clip or action', () => {
  const binding = scalarBinding('revision');
  const resolver = new TestResolver();
  resolver.set(binding, [0]);
  const mixer = new Animation3DMixerRuntime(resolver);
  mixer.createAction(
    clip('revision', [track(binding, [0], [10])]),
    { weight: 0.5 },
  ).play();
  const out = new Animation3DPoseBuffer();

  assertClose(channel(mixer.evaluate(out), binding.id).value, [5]);
  assert.equal(resolver.resolveCalls, 1);
  mixer.evaluate(out);
  assert.equal(resolver.resolveCalls, 1);
  resolver.set(binding, [4]);
  resolver.revision++;
  assertClose(channel(mixer.evaluate(out), binding.id).value, [7]);
  assert.equal(resolver.resolveCalls, 2);
});

test('destroy is idempotent, invalidates actions, and never releases clip-like handles', () => {
  let releases = 0;
  const binding = scalarBinding('destroy');
  const runtimeClip = clip(
    'destroy',
    [track(binding, [0], [1])],
    { extra: { release() { releases++; } } },
  );
  const mixer = new Animation3DMixerRuntime(new TestResolver());
  const action = mixer.createAction(runtimeClip).play();

  mixer.destroy();
  mixer.destroy();
  assert.equal(mixer.state, 'destroyed');
  assert.equal(releases, 0);
  assert.throws(() => action.play(), /destroyed|no longer valid/);
  assert.throws(() => mixer.update(0, new Animation3DPoseBuffer()), /destroyed/);
});
