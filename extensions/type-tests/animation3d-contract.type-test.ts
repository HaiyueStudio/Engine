import {
  Animation3DMixer,
  Animation3DPoseApplier,
  Animation3DPoseBuffer,
  Animation3DStateMachineController,
  compileAnimation3DStateMachineDefinition,
  validateAnimation3DStateMachineDefinition,
} from '../src/animation3d/index';
import type {
  Animation3DAction,
  Animation3DBindingResolver,
  Animation3DClip,
  Animation3DCompiledStateMachine,
  Animation3DMorphWeightsBinding,
  Animation3DPose,
  Animation3DRotationBinding,
  Animation3DStateMachineDefinition,
  Animation3DTrack,
  Animation3DTranslationBinding,
} from '../src/animation3d/index';

// @ts-expect-error Track samplers are implementation details.
import type { Animation3DTrackSampler } from '../src/animation3d/index';
// @ts-expect-error Compiled nodes are hidden behind an opaque machine.
import type { CompiledAnimation3DState } from '../src/animation3d/index';
// @ts-expect-error The mixer port is not part of the facade.
import type { Animation3DStateMachineMixerPort } from '../src/animation3d/index';
// @ts-expect-error Mixer-owned action implementations are not constructible API.
import type { Animation3DActionRuntime } from '../src/animation3d/index';
// @ts-expect-error Resource loading is not part of this stable facade.
import type { Animation3DResourceLoader } from '../src/animation3d/index';

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
    ? true
    : false;
type Expect<TValue extends true> = TValue;

const nodeTarget = {
  kind: 'node-id',
  nodeId: 'character/hips',
} as const;

const translationBinding = {
  id: 'hips.translation',
  target: nodeTarget,
  path: 'transform.translation',
  valueType: 'vec3',
  valueSize: 3,
} as const satisfies Animation3DTranslationBinding;

const translationTrack = {
  id: 'walk.hips.translation',
  binding: translationBinding,
  interpolation: 'linear',
  times: new Float32Array([0, 1]),
  values: new Float32Array([0, 0, 0, 1, 0, 0]),
} as const satisfies Animation3DTrack;

const weightsBinding = {
  id: 'face.weights',
  target: { kind: 'slot', slot: 'face' },
  path: 'morph.weights',
  valueType: 'weights',
  valueSize: 4,
} as const satisfies Animation3DMorphWeightsBinding;

const weightsTrack = {
  id: 'smile.weights',
  binding: weightsBinding,
  interpolation: 'cubic-spline',
  times: new Float32Array([0, 0.5]),
  values: new Float32Array(2 * 3 * 4),
} as const satisfies Animation3DTrack;

const clip = {
  format: 'haiyue-animation3d-clip@1',
  id: 'walk',
  name: 'Walk',
  duration: 1,
  tracks: [translationTrack, weightsTrack],
  events: [{
    id: 'left-foot',
    time: 0.25,
    name: 'footstep',
    payload: { foot: 'left' },
  }],
} as const satisfies Animation3DClip;

const machine = {
  format: 'haiyue-animation3d-state-machine@1',
  id: 'locomotion',
  name: 'Locomotion',
  parameters: [
    { name: 'speed', type: 'float', defaultValue: 0 },
    { name: 'grounded', type: 'boolean', defaultValue: true },
    { name: 'jump', type: 'trigger' },
  ],
  layers: [{
    id: 'base',
    name: 'Base',
    initialStateId: 'idle',
    states: [
      {
        id: 'idle',
        name: 'Idle',
        motion: { kind: 'clip', clipId: 'idle' },
      },
      {
        id: 'move',
        name: 'Move',
        motion: {
          kind: 'blend-1d',
          parameter: 'speed',
          children: [
            { threshold: 0, motion: { kind: 'clip', clipId: 'walk' } },
            { threshold: 4, motion: { kind: 'clip', clipId: 'run' } },
          ],
        },
      },
    ],
    transitions: [{
      id: 'idle-to-move',
      from: 'idle',
      to: 'move',
      conditions: [{
        parameter: 'speed',
        operator: 'greater',
        value: 0.1,
      }],
      duration: 0.2,
    }],
  }],
} as const satisfies Animation3DStateMachineDefinition;

type _MixerCreatesAction = Expect<Equal<
  ReturnType<Animation3DMixer['createAction']>,
  Animation3DAction
>>;
type _MixerUpdateProducesPose = Expect<Equal<
  ReturnType<Animation3DMixer['update']>,
  Animation3DPose
>>;
type _ResolverCanMiss = Expect<Equal<
  ReturnType<Animation3DBindingResolver['resolve']>,
  import('../src/animation3d/index').Animation3DResolvedBinding | null
>>;

void clip;
void machine;
void (null as unknown as Animation3DTrackSampler);
void (null as unknown as CompiledAnimation3DState);
void (null as unknown as Animation3DStateMachineMixerPort);
void (null as unknown as Animation3DActionRuntime);
void (null as unknown as Animation3DResourceLoader);

const issues = validateAnimation3DStateMachineDefinition(machine);
const compiled: Animation3DCompiledStateMachine =
  compileAnimation3DStateMachineDefinition(machine);
compiled.id;
issues[0]?.path;
// @ts-expect-error Compiled state/layer nodes are intentionally opaque.
compiled.layers;

const resolver: Animation3DBindingResolver = {
  revision: 0,
  resolve: () => null,
};
const mixer = new Animation3DMixer(resolver);
const poseBuffer = new Animation3DPoseBuffer();
const pose = mixer.evaluate(poseBuffer);
new Animation3DPoseApplier(resolver).apply(pose);
const controller = new Animation3DStateMachineController(
  compiled,
  mixer,
  { resolve: () => clip },
);
controller.update(0, poseBuffer);
// @ts-expect-error Controller-owned synchronized frames stay internal.
mixer.beginSynchronizedFrame(0, poseBuffer);
// @ts-expect-error Internal controller ports are not inspectable.
controller.port;
// @ts-expect-error Transition-loop diagnostics are not public handles.
controller.transitionLimitReached;

const invalidRotationBinding: Animation3DRotationBinding = {
  id: 'hips.rotation',
  target: nodeTarget,
  path: 'transform.rotation',
  valueType: 'quaternion',
  // @ts-expect-error Quaternion bindings always contain XYZW.
  valueSize: 3,
};
void invalidRotationBinding;

const immutableClip: Animation3DClip = clip;
// @ts-expect-error Clip descriptors are immutable.
immutableClip.duration = 2;

const invalidMachine: Animation3DStateMachineDefinition = {
  ...machine,
  layers: [{
    ...machine.layers[0],
    transitions: [{
      id: 'bad-condition',
      from: 'idle',
      to: 'move',
      conditions: [{
        parameter: 'speed',
        operator: 'greater',
        // @ts-expect-error Numeric comparisons require numeric values.
        value: 'fast',
      }],
      duration: 0.1,
    }],
  }],
};
void invalidMachine;
