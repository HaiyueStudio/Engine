import assert from 'node:assert/strict';
import test from 'node:test';
import { Entity } from '@haiyue/engine';
import { ParticleEmitter3D } from '@haiyue/engine/components';

import {
  AnimationStateMachineChannelError,
  audioAutoplayRejectedDiagnostic,
  audioStateMachineCompatibilityDiagnostic,
} from '../dist-test/animation-state-machine/AnimationStateMachineChannels.js';
import {
  Animation2DStateMachineMixerAdapter,
} from '../dist-test/animation-state-machine/runtime/Animation2DStateMachineMixerAdapter.js';
import {
  runAnimationStateMachineControllerUpdateTransaction,
} from '../dist-test/animation-state-machine/runtime/AnimationStateMachineController.js';
import {
  createAnimation2DStateMachineController,
} from '../dist-test/animation/Animation2DStateMachine.js';
import {
  createHyaAnimation2DClips,
} from '../dist-test/animation/HyaAnimation2DClipAdapter.js';
import { AnimationAudioClip } from '../dist-test/animation/AnimationAudioClip.js';
import {
  Animation2DStateMachineVisualRuntime,
} from '../dist-test/animation/Animation2DStateMachineVisualRuntime.js';
import {
  Animation2DMixerRuntime,
  Animation2DPoseBuffer,
} from '../dist-test/animation/runtime/mixer/index.js';
import {
  HyaAnimation3DStateMachineRuntime,
} from '../dist-test/animation3d/hya/HyaAnimation3DStateMachineRuntime.js';
import {
  Animation3DMixerRuntime,
} from '../dist-test/animation3d/runtime/mixer/Mixer.js';

function track(id, path, strategy, value) {
  const numeric = strategy === 'continuous';
  return {
    id,
    binding: {
      id: `node.${path}`,
      targetId: 'node',
      path,
      strategy,
      ...(numeric ? { valueSize: 1, defaultValue: [0] } : { defaultValue: 'A' }),
    },
    interpolation: numeric ? 'linear' : 'step',
    times: new Float32Array([0, 1]),
    values: numeric ? new Float32Array([value, value]) : [value, value],
  };
}

function clip(id, morph, sprite) {
  return {
    format: 'haiyue-animation2d-clip@1',
    id,
    name: id,
    duration: 1,
    tracks: [
      track(`${id}:morph`, 'components.0.vector.morph', 'continuous', morph),
      track(`${id}:sprite`, 'components.1.sprite.uv-rect', 'discrete', sprite),
    ],
    effects: [{
      id: `${id}:particle`,
      kind: 'particle',
      start: 0,
      end: 1,
      loopBehavior: 'restart',
      payload: { targetId: 'node', slot: 0, sourcePath: '$.nodes[0].components[2]', component: {} },
    }],
  };
}

function machine(mask) {
  return {
    format: 'haiyue-animation-state-machine@1',
    id: 'channels',
    name: 'Channels',
    parameters: [{ name: 'go', type: 'boolean', defaultValue: false }],
    layers: [{
      id: 'base',
      name: 'Base',
      initialStateId: 'a',
      ...(mask ? { mask } : {}),
      states: [
        { id: 'a', name: 'A', motion: { kind: 'clip', clipId: 'a' }, loop: 'once' },
        { id: 'b', name: 'B', motion: { kind: 'clip', clipId: 'b' }, loop: 'once' },
      ],
      transitions: [{
        id: 'a-b', from: 'a', to: 'b', duration: 1,
        conditions: [{ parameter: 'go', operator: 'is-true' }],
      }],
    }],
  };
}

test('HYA adapter registers Sprite Step, morph, and particle cues without a second sampler', () => {
  const extension = {
    clips: [
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 1 },
    ],
    stateMachine: machine(),
  };
  const animation = {
    name: 'Channel visual fixture',
    canvas: { width: 64, height: 64, coordinateSystem: 'screen-y-down' },
    duration: 2,
    resources: [{ id: 'atlas', type: 'image', uri: 'atlas.png', width: 2, height: 1 }],
    extensionsRequired: [],
    nodes: [{
      id: 'node',
      components: [
        {
          type: 'org.haiyue.vector-shape@1',
          commands: 'MLLZ',
          values: [0, 0, 10, 0, 5, 10],
          morph: {
            times: new Float32Array([0, 1, 2]),
            values: new Float32Array([
              0, 0, 10, 0, 5, 10,
              0, 0, 20, 0, 10, 20,
              0, 0, 30, 0, 15, 30,
            ]),
            valueSize: 6,
            interpolation: 'linear',
          },
          fill: { kind: 'solid', color: [1, 1, 1, 1] },
        },
        {
          type: 'sprite2d', resource: 'atlas', size: [16, 16],
          uvRectTrack: {
            times: new Float32Array([0, 1, 2]),
            values: new Float32Array([0, 0, 0.5, 1, 0.5, 0, 0.5, 1, 0, 0, 0.5, 1]),
            valueSize: 4,
            interpolation: 'step',
          },
        },
        {
          type: 'particle2d', maxParticles: 8, emissionRate: 2,
          lifetime: [1, 1], speed: [1, 1], angle: [0, 0],
          startSize: [1, 1], endSize: [0, 0],
          startColor: [1, 1, 1, 1], endColor: [1, 1, 1, 0],
        },
      ],
    }],
    tracks: [],
  };

  const clips = createHyaAnimation2DClips(animation, extension);
  assert.equal(clips.length, 2);
  const spriteTrack = clips[0].tracks.find(item => item.binding.path.endsWith('sprite.uv-rect'));
  assert.equal(spriteTrack.binding.strategy, 'discrete');
  assert.ok(spriteTrack.values.every(value => value instanceof Float32Array));
  assert.equal(clips[0].tracks.find(item => item.binding.path.endsWith('vector.morph')).binding.valueSize, 6);
  assert.equal(clips[0].effects[0].kind, 'particle');
  assert.equal(clips[0].effects[0].payload.component, animation.nodes[0].components[2]);

  const mixer = new Animation2DMixerRuntime(clips);
  const action = mixer.createAction(clips[0], { id: 'shared-visual' });
  action.play().seek(0.5);
  const pose = mixer.evaluate(new Animation2DPoseBuffer());
  const owner = new Entity('visual owner');
  const visual = new Animation2DStateMachineVisualRuntime(owner, animation);
  visual.applyPose(pose, true, 1);
  const sprite = visual._nodes[0].visuals.find(item => item.sourceComponentIndex === 1);
  assert.deepEqual(sprite.component.uvRect, [0, 0, 0.5, 1]);
  assert.equal(visual.sideEffectOwnerCount, 1);
  action.stop();
  visual.applyPose(mixer.evaluate(new Animation2DPoseBuffer()), false, 1);
  assert.equal(visual.sideEffectOwnerCount, 0);
  visual.destroy();
  mixer.destroy();
  owner.destroy();
});

test('2D cross-fade mixes morph, switches Sprite deterministically, emits particle enter/exit, and rolls back failure', () => {
  const mixer = new Animation2DMixerRuntime([clip('a', 0, 'A'), clip('b', 10, 'B')]);
  const adapter = new Animation2DStateMachineMixerAdapter(mixer);
  const controller = createAnimation2DStateMachineController(machine(), adapter);
  const out = new Animation2DPoseBuffer();

  const initial = mixer.evaluate(out);
  assert.deepEqual(initial.effects.map(item => [item.clipId, item.lifecycle]), [['a', 'enter']]);
  controller.setBoolean('go', true);
  assert.throws(() => runAnimationStateMachineControllerUpdateTransaction(
    controller,
    0.5,
    () => undefined,
    () => { throw new Error('pose failure'); },
  ), /pose failure/);
  assert.equal(controller.getLayerSnapshot('base').transitionId, null);
  assert.equal(adapter.liveActionCount, 1);
  assert.equal(adapter.liveBindingCount, 2);

  const middle = runAnimationStateMachineControllerUpdateTransaction(
    controller,
    0.5,
    () => undefined,
    () => mixer.evaluate(out),
  );
  const middleMorph = middle.channels.find(item => item.binding.path.endsWith('vector.morph'));
  const middleSprite = middle.channels.find(item => item.binding.path.endsWith('sprite.uv-rect'));
  assert.ok(Math.abs(middleMorph.value[0] - 5) < 1e-6);
  assert.equal(middleSprite.value, 'A', 'equal weights retain the earlier action deterministically');
  assert.deepEqual(middle.effects.map(item => [item.clipId, item.lifecycle]), [['b', 'enter']]);

  const end = runAnimationStateMachineControllerUpdateTransaction(
    controller,
    0.5,
    () => undefined,
    () => mixer.evaluate(out),
  );
  assert.equal(end.channels.find(item => item.binding.path.endsWith('sprite.uv-rect')).value, 'B');
  assert.ok(end.effects.some(item => item.clipId === 'a' && item.lifecycle === 'exit'));
  assert.equal(adapter.liveActionCount, 1);
  assert.equal(adapter.liveBindingCount, 2);

  controller.destroy();
  adapter.destroy();
  assert.equal(adapter.liveBindingCount, 0);
  mixer.destroy();
});

test('2D layer masks exclude discrete bindings while retaining continuous morph', () => {
  const mixer = new Animation2DMixerRuntime([clip('a', 3, 'A'), clip('b', 6, 'B')]);
  const adapter = new Animation2DStateMachineMixerAdapter(mixer);
  const controller = createAnimation2DStateMachineController(
    machine({ include: ['node.components.0.vector.morph'] }),
    adapter,
  );
  const pose = mixer.evaluate(new Animation2DPoseBuffer());
  assert.ok(pose.channels.some(item => item.binding.path.endsWith('vector.morph')));
  assert.equal(pose.channels.some(item => item.binding.path.endsWith('sprite.uv-rect')), false);
  controller.destroy();
  adapter.destroy();
  mixer.destroy();
});

test('one 3D controller transaction spans scene/model mixers and Particle3D ownership', () => {
  class Resolver {
    revision = 0;
    fail = false;
    value = new Float32Array([0]);
    resolve(binding) {
      return {
        binding,
        read: out => {
          if (this.fail) throw new Error('model pose read failed');
          out.set(this.value);
        },
        write: source => { this.value[0] = source[0]; },
      };
    }
  }
  const scalar = id => ({
    id, target: { kind: 'node-id', nodeId: id }, path: 'property',
    component: 'test', property: 'value', valueType: 'scalar', valueSize: 1,
  });
  const clip3d = (id, binding, value) => ({
    format: 'haiyue-animation3d-clip@1', id, name: id, duration: 1,
    tracks: [{
      id: `${id}:${binding.id}`, binding, interpolation: 'linear',
      times: new Float32Array([0, 1]), values: new Float32Array([value, value]),
    }],
    events: [],
  });
  const sceneBinding = scalar('scene');
  const modelBinding = scalar('model');
  const sceneClips = [clip3d('a', sceneBinding, 0), clip3d('b', sceneBinding, 10)];
  const modelClips = [clip3d('a', modelBinding, 10), clip3d('b', modelBinding, 20)];
  const sceneResolver = new Resolver();
  const modelResolver = new Resolver();
  const sceneMixer = new Animation3DMixerRuntime(sceneResolver);
  const modelMixer = new Animation3DMixerRuntime(modelResolver);
  const applied = { scene: Number.NaN, model: Number.NaN };
  const particle = new ParticleEmitter3D({ maxParticles: 8, burst: 1, playing: false, emitting: false });
  let particleRestarts = 0;
  const restartParticle = particle.restart.bind(particle);
  particle.restart = clear => {
    particleRestarts++;
    return restartParticle(clear);
  };
  const cues = new Map([
    ['a', [{ key: 'spark', emitter: particle, start: 0, end: 1 }]],
    ['b', [{ key: 'spark', emitter: particle, start: 0, end: 1 }]],
  ]);
  const definition = {
    ...machine(), format: 'haiyue-animation3d-state-machine@1',
    layers: [{
      ...machine().layers[0],
      states: machine().layers[0].states.map(state => ({ ...state, loop: 'repeat' })),
      mask: { include: ['scene', 'authored-model'] },
    }],
  };
  const runtime = new HyaAnimation3DStateMachineRuntime({
    definition,
    clips: sceneClips,
    partitions: [
      {
        id: 'scene', mixer: sceneMixer, clips: new Map(sceneClips.map(item => [item.id, item])),
        apply: pose => { applied.scene = pose.channels[0].value[0]; },
      },
      {
        id: 'model', mixer: modelMixer, clips: new Map(modelClips.map(item => [item.id, item])),
        bindingIds: new Map([['authored-model', 'model']]),
        apply: pose => { applied.model = pose.channels[0].value[0]; },
      },
    ],
    particleCues: cues,
  });
  assert.equal(runtime.liveActionCount, 1);
  assert.equal(runtime.liveBindingCount, 2);
  assert.equal(runtime.sideEffectOwnerCount, 1);
  assert.equal(particle.playing, true);
  assert.equal(particleRestarts, 1);

  runtime.controller.setBoolean('go', true);
  modelResolver.fail = true;
  assert.throws(() => runtime.update(0.25), /model pose read failed/);
  assert.equal(runtime.controller.getLayerSnapshot('base').transitionId, null);
  assert.equal(sceneMixer.time, 0);
  assert.equal(modelMixer.time, 0);
  assert.equal(runtime.liveActionCount, 1);
  assert.equal(runtime.liveBindingCount, 2);
  assert.equal(runtime.sideEffectOwnerCount, 1);
  assert.equal(particleRestarts, 1, 'failed transaction must not commit a Particle3D restart');

  modelResolver.fail = false;
  runtime.update(0.5);
  assert.ok(Math.abs(applied.scene - 5) < 1e-6);
  assert.ok(Math.abs(applied.model - 15) < 1e-6);
  assert.equal(runtime.liveActionCount, 2);
  assert.equal(runtime.liveBindingCount, 2);
  assert.equal(runtime.sideEffectOwnerCount, 2);
  assert.equal(particleRestarts, 2, 'destination enter restarts the shared emitter once');
  runtime.update(0.5);
  assert.equal(runtime.liveActionCount, 1);
  assert.equal(runtime.sideEffectOwnerCount, 1);
  assert.equal(particleRestarts, 3, 'repeat traversal restarts only the dominant Particle3D owner');

  runtime.destroy();
  assert.equal(runtime.liveActionCount, 0);
  assert.equal(runtime.liveBindingCount, 0);
  assert.equal(runtime.sideEffectOwnerCount, 0);
  assert.equal(particle.activeParticles, 0);
  assert.equal(particle.playing, false);
  assert.equal(particle.emitting, false);
  sceneMixer.destroy();
  modelMixer.destroy();
  particle.destroy();
});

test('audio rejects every graph range that would overlap media playheads', () => {
  const diagnostic = audioStateMachineCompatibilityDiagnostic(machine());
  assert.equal(diagnostic.code, 'E_STATE_MACHINE_CHANNEL_AUDIO_UNMIXABLE_RANGE');
  assert.equal(diagnostic.path, '$.stateMachine.layers[0].transitions[0].duration');

  const extension = { clips: [{ id: 'a', start: 0, duration: 1 }, { id: 'b', start: 1, duration: 1 }], stateMachine: machine() };
  assert.throws(
    () => createHyaAnimation2DClips({
      duration: 2,
      nodes: [{ id: 'node', components: [{ type: 'audio', resource: 'voice' }] }],
      tracks: [],
    }, extension),
    error => error instanceof AnimationStateMachineChannelError
      && error.diagnostic.code === 'E_STATE_MACHINE_CHANNEL_AUDIO_UNMIXABLE_RANGE',
  );

  const immediateMachine = {
    ...machine(),
    layers: [{
      ...machine().layers[0],
      transitions: machine().layers[0].transitions.map(transition => ({ ...transition, duration: 0 })),
    }],
  };
  const immediateClips = createHyaAnimation2DClips({
    duration: 2,
    nodes: [{ id: 'node', components: [{ type: 'audio', resource: 'voice' }] }],
    tracks: [],
  }, { clips: extension.clips, stateMachine: immediateMachine });
  assert.equal(immediateClips[0].effects[0].kind, 'audio');
});

test('audio autoplay rejection is observable and leaves the media playhead pausable', async () => {
  const OriginalAudio = globalThis.Audio;
  const instances = [];
  globalThis.Audio = class FakeAudio {
    paused = true;
    currentTime = 0;
    duration = 4;
    volume = 1;
    playbackRate = 1;
    loop = false;
    preload = '';
    constructor(uri) { this.uri = uri; instances.push(this); }
    play() { return Promise.reject(new Error('gesture required')); }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  };
  try {
    const clip = new AnimationAudioClip(
      'voice.ogg',
      { type: 'audio', resource: 'voice', startOffset: 0.25 },
      { id: 'voice-node' },
      2,
    );
    let rejection = null;
    clip.enterStateMachine(true, 1, 1, reason => { rejection = reason; });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(rejection.message, /gesture required/);
    const diagnostic = audioAutoplayRejectedDiagnostic('$.nodes[0].components[0]', rejection);
    assert.equal(diagnostic.code, 'W_STATE_MACHINE_CHANNEL_AUDIO_AUTOPLAY_REJECTED');
    assert.equal(instances[0].currentTime, 0.25);
    clip.updateStateMachineProperties(2, 0.5);
    assert.equal(instances[0].playbackRate, 2);
    assert.equal(instances[0].volume, 0.5);
    clip.exitStateMachine();
    assert.equal(instances[0].paused, true);
    clip.destroy();
  } finally {
    if (OriginalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = OriginalAudio;
  }
});

test('audio destroy cancels a pending media start without a late residual playhead', async () => {
  const OriginalAudio = globalThis.Audio;
  let resolvePlay;
  let instance;
  globalThis.Audio = class FakeAudio {
    paused = true;
    currentTime = 0;
    duration = 4;
    volume = 1;
    playbackRate = 1;
    loop = false;
    preload = '';
    constructor() { instance = this; }
    play() {
      return new Promise(resolve => {
        resolvePlay = () => { this.paused = false; resolve(); };
      });
    }
    pause() { this.paused = true; }
    removeAttribute() {}
    load() {}
  };
  try {
    const clip = new AnimationAudioClip(
      'voice.ogg',
      { type: 'audio', resource: 'voice' },
      { id: 'voice-node' },
      2,
    );
    clip.enterStateMachine(true, 1, 1, () => undefined);
    clip.destroy();
    resolvePlay();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(instance.paused, true);
  } finally {
    if (OriginalAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = OriginalAudio;
  }
});
