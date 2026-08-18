import { Component, type Entity } from '@haiyue/engine';
import { createAbortError } from '@haiyue/engine/experimental/async';
import type {
  Animation3DBinding,
  Animation3DBindingResolver,
  Animation3DResolvedBinding,
} from '../animation3d/Animation3DBinding';
import type { Animation3DClip } from '../animation3d/Animation3DClip';
import { Animation3DMixer } from '../animation3d/Animation3DMixer';
import type { Animation3DPose } from '../animation3d/Animation3DPose';
import { Animation3DPoseBuffer } from '../animation3d/Animation3DPoseBuffer';
import type { Animation3DTrack } from '../animation3d/Animation3DTrack';
import {
  applyMorphWeights,
  composeTrsMatrix,
  updateSkinnedPrimitive,
} from './GltfAnimationRuntime';
import type {
  GltfAnimationChannelRuntime,
  GltfAnimationClip,
  GltfAnimationPath,
  GltfAnimationTarget,
  GltfSkinnedPrimitiveRuntime,
  LoadedGltfModel,
} from './GltfLoaderContract';

export interface GltfAnimation3DRuntimeOptions {
  /** Cancels and destroys the adapter without taking ownership of the glTF model. */
  readonly signal?: AbortSignal;
  /** Stable prefix used when several glTF models share a higher-level clip registry. */
  readonly clipIdPrefix?: string;
}

export type GltfAnimation3DRuntimeState = 'active' | 'destroyed';

type GltfAnimation3DBindingPath =
  | 'transform.translation'
  | 'transform.rotation'
  | 'transform.scale'
  | 'morph.weights';

interface GltfAnimation3DTargetState {
  readonly target: GltfAnimationTarget;
  readonly nodePath: readonly string[];
  readonly nodeKey: string;
  readonly baseTranslation: Float32Array;
  readonly baseRotation: Float32Array;
  readonly baseScale: Float32Array;
  readonly baseWeights: Float32Array;
  readonly translation: Float32Array;
  readonly rotation: Float32Array;
  readonly scale: Float32Array;
  readonly weights: Float32Array;
  readonly matrix: Float32Array<ArrayBuffer>;
  seenGeneration: number;
  touchedTransform: boolean;
  touchedWeights: boolean;
  appliedTransform: boolean;
  appliedWeights: boolean;
}

interface GltfAnimation3DAdapterContext {
  readonly targetStates: Map<GltfAnimationTarget, GltfAnimation3DTargetState>;
  readonly endpoints: Map<string, GltfAnimation3DResolvedEndpoint>;
  readonly skinnedPrimitives: readonly GltfSkinnedPrimitiveRuntime[];
}

class GltfAnimation3DResolvedEndpoint implements Animation3DResolvedBinding {
  readonly binding: Animation3DBinding;
  readonly state: GltfAnimation3DTargetState;
  readonly path: GltfAnimation3DBindingPath;
  private readonly _onDirectWrite: () => void;

  constructor(
    binding: Animation3DBinding,
    state: GltfAnimation3DTargetState,
    path: GltfAnimation3DBindingPath,
    onDirectWrite: () => void,
  ) {
    this.binding = binding;
    this.state = state;
    this.path = path;
    this._onDirectWrite = onDirectWrite;
  }

  read(out: Float32Array): void {
    copyValues(this.baseValue(), out, this.binding.valueSize);
  }

  write(value: ArrayLike<number>): void {
    this.writeCurrent(value);
    commitTargetState(this.state, this.path.startsWith('transform.'), this.path === 'morph.weights');
    this._onDirectWrite();
  }

  resetCurrentFromBase(): void {
    this.state.translation.set(this.state.baseTranslation);
    this.state.rotation.set(this.state.baseRotation);
    this.state.scale.set(this.state.baseScale);
    this.state.weights.set(this.state.baseWeights);
  }

  writeCurrent(value: ArrayLike<number>): void {
    switch (this.path) {
      case 'transform.translation':
        copyValues(value, this.state.translation, 3);
        this.state.touchedTransform = true;
        break;
      case 'transform.rotation':
        copyValues(value, this.state.rotation, 4);
        normalizeQuaternion(this.state.rotation);
        this.state.touchedTransform = true;
        break;
      case 'transform.scale':
        copyValues(value, this.state.scale, 3);
        this.state.touchedTransform = true;
        break;
      case 'morph.weights':
        copyValues(value, this.state.weights, this.binding.valueSize);
        this.state.touchedWeights = true;
        break;
    }
  }

  private baseValue(): Float32Array {
    switch (this.path) {
      case 'transform.translation': return this.state.baseTranslation;
      case 'transform.rotation': return this.state.baseRotation;
      case 'transform.scale': return this.state.baseScale;
      case 'morph.weights': return this.state.baseWeights;
    }
  }
}

/**
 * Resolves source-independent Animation3D bindings to one loaded glTF model.
 * Base reads remain the authored glTF pose so partial fades do not accumulate
 * the previously applied frame back into the next mix.
 */
class GltfAnimation3DBindingResolver implements Animation3DBindingResolver {
  private readonly _endpoints: Map<string, GltfAnimation3DResolvedEndpoint>;
  private _revision = 0;
  private _destroyed = false;

  constructor(endpoints: Map<string, GltfAnimation3DResolvedEndpoint>) {
    this._endpoints = endpoints;
  }

  get revision(): number { return this._revision; }
  get bindingCount(): number { return this._endpoints.size; }
  get destroyed(): boolean { return this._destroyed; }

  resolve<TBinding extends Animation3DBinding>(
    binding: TBinding,
  ): Animation3DResolvedBinding<TBinding> | null {
    if (this._destroyed) return null;
    const endpoint = this._endpoints.get(binding.id);
    if (!endpoint
      || endpoint.binding.path !== binding.path
      || endpoint.binding.valueType !== binding.valueType
      || endpoint.binding.valueSize !== binding.valueSize) {
      return null;
    }
    return endpoint as unknown as Animation3DResolvedBinding<TBinding>;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._endpoints.clear();
    this._revision++;
  }
}

/**
 * Applies a transient Animation3D pose to glTF Transform3D, skinning and morph
 * resources. Target scratch and active lists are retained and reused.
 */
class GltfAnimation3DPoseApplier {
  private readonly _targetStates: Map<GltfAnimationTarget, GltfAnimation3DTargetState>;
  private readonly _endpoints: Map<string, GltfAnimation3DResolvedEndpoint>;
  private readonly _skinnedPrimitives: readonly GltfSkinnedPrimitiveRuntime[];
  private readonly _activeTargets: GltfAnimation3DTargetState[] = [];
  private readonly _previousTargets: GltfAnimation3DTargetState[] = [];
  private _generation = 0;
  private _destroyed = false;

  constructor(context: GltfAnimation3DAdapterContext) {
    this._targetStates = context.targetStates;
    this._endpoints = context.endpoints;
    this._skinnedPrimitives = context.skinnedPrimitives;
  }

  get targetCount(): number { return this._targetStates.size; }
  get destroyed(): boolean { return this._destroyed; }

  apply(pose: Animation3DPose): void {
    this.assertActive();
    const generation = ++this._generation;
    this._activeTargets.length = 0;
    for (const channel of pose.channels) {
      const endpoint = this._endpoints.get(channel.binding.id);
      if (!endpoint) continue;
      const state = endpoint.state;
      if (state.seenGeneration !== generation) {
        state.seenGeneration = generation;
        state.touchedTransform = false;
        state.touchedWeights = false;
        endpoint.resetCurrentFromBase();
        this._activeTargets.push(state);
      }
      endpoint.writeCurrent(channel.value);
    }

    let changed = false;
    for (const state of this._previousTargets) {
      if (state.seenGeneration === generation) continue;
      state.translation.set(state.baseTranslation);
      state.rotation.set(state.baseRotation);
      state.scale.set(state.baseScale);
      state.weights.set(state.baseWeights);
      commitTargetState(state, state.appliedTransform, state.appliedWeights);
      changed ||= state.appliedTransform || state.appliedWeights;
      state.appliedTransform = false;
      state.appliedWeights = false;
    }

    for (const state of this._activeTargets) {
      const restoreTransform = state.appliedTransform && !state.touchedTransform;
      const restoreWeights = state.appliedWeights && !state.touchedWeights;
      commitTargetState(
        state,
        state.touchedTransform || restoreTransform,
        state.touchedWeights || restoreWeights,
      );
      changed ||= state.touchedTransform || state.touchedWeights || restoreTransform || restoreWeights;
      state.appliedTransform = state.touchedTransform;
      state.appliedWeights = state.touchedWeights;
    }

    this._previousTargets.length = 0;
    this._previousTargets.push(...this._activeTargets);
    if (changed) updateSkinnedPrimitives(this._skinnedPrimitives);
  }

  destroy(restoreBasePose = true): void {
    if (this._destroyed) return;
    if (restoreBasePose) {
      let changed = false;
      for (const state of this._previousTargets) {
        state.translation.set(state.baseTranslation);
        state.rotation.set(state.baseRotation);
        state.scale.set(state.baseScale);
        state.weights.set(state.baseWeights);
        commitTargetState(state, state.appliedTransform, state.appliedWeights);
        changed ||= state.appliedTransform || state.appliedWeights;
      }
      if (changed) updateSkinnedPrimitives(this._skinnedPrimitives);
    }
    this._destroyed = true;
    this._activeTargets.length = 0;
    this._previousTargets.length = 0;
    this._targetStates.clear();
    this._endpoints.clear();
  }

  private assertActive(): void {
    if (this._destroyed) throw new Error('glTF Animation3D pose applier has been destroyed.');
  }
}

class GltfAnimation3DRuntimeOwnerComponent extends Component {
  private _runtime: GltfAnimation3DRuntime | null = null;

  constructor() {
    super('GltfAnimation3DRuntimeOwner');
  }

  attach(runtime: GltfAnimation3DRuntime): void {
    this._runtime = runtime;
  }

  release(runtime: GltfAnimation3DRuntime): void {
    if (this._runtime === runtime) this._runtime = null;
  }

  override clone(): GltfAnimation3DRuntimeOwnerComponent {
    return new GltfAnimation3DRuntimeOwnerComponent();
  }

  override destroy(): void {
    if (this.destroyed) return;
    const runtime = this._runtime;
    this._runtime = null;
    runtime?.destroy();
    super.destroy();
  }
}

/**
 * Model-scoped owner combining the existing Animation3D mixer with glTF
 * binding and pose adapters. It does not own or dispose the LoadedGltfModel.
 */
export class GltfAnimation3DRuntime {
  readonly mixer: Animation3DMixer;
  readonly pose = new Animation3DPoseBuffer();

  private readonly _clips: Animation3DClip[];
  private readonly _owner: GltfAnimation3DRuntimeOwnerComponent;
  private readonly _resolver: GltfAnimation3DBindingResolver;
  private readonly _poseApplier: GltfAnimation3DPoseApplier;
  private _root: Entity | null;
  private _state: GltfAnimation3DRuntimeState = 'active';
  private readonly _signal: AbortSignal | null;
  private readonly _abortListener: (() => void) | null;

  constructor(model: LoadedGltfModel, options: GltfAnimation3DRuntimeOptions = {}) {
    if (options.signal?.aborted) throw createAbortError('glTF Animation3D runtime creation aborted.', options.signal.reason);
    const context = createAdapterContext(model);
    this._clips = createClips(model.animationClips, context, options.clipIdPrefix);
    this._resolver = new GltfAnimation3DBindingResolver(context.endpoints);
    this._poseApplier = new GltfAnimation3DPoseApplier(context);
    this.mixer = new Animation3DMixer(this._resolver);
    this._root = model.root;
    this._owner = new GltfAnimation3DRuntimeOwnerComponent();
    this._owner.attach(this);
    model.root.addComponent(this._owner);
    this._signal = options.signal ?? null;
    this._abortListener = this._signal
      ? () => this.destroy()
      : null;
    if (this._signal && this._abortListener) {
      this._signal.addEventListener('abort', this._abortListener, { once: true });
    }
  }

  get state(): GltfAnimation3DRuntimeState { return this._state; }
  get root(): Entity | null { return this._root; }
  get clips(): readonly Animation3DClip[] { return this._clips; }
  /** Diagnostic count without exposing the model-specific resolver handle. */
  get bindingCount(): number { return this._resolver.bindingCount; }
  /** Diagnostic count without exposing the model-specific pose-applier handle. */
  get targetCount(): number { return this._poseApplier.targetCount; }

  update(deltaSeconds: number): Animation3DPose {
    this.assertActive();
    const pose = this.mixer.update(deltaSeconds, this.pose);
    this._poseApplier.apply(pose);
    return pose;
  }

  evaluate(): Animation3DPose {
    this.assertActive();
    const pose = this.mixer.evaluate(this.pose);
    this._poseApplier.apply(pose);
    return pose;
  }

  /** @internal Applies a pose produced by a shared multi-mixer state-machine transaction. */
  applySynchronizedPose(pose: Animation3DPose): void {
    this.assertActive();
    this._poseApplier.apply(pose);
  }

  setTime(timeSeconds: number): Animation3DPose {
    this.assertActive();
    const pose = this.mixer.setTime(timeSeconds, this.pose);
    this._poseApplier.apply(pose);
    return pose;
  }

  destroy(): void {
    if (this._state === 'destroyed') return;
    this._state = 'destroyed';
    if (this._signal && this._abortListener) {
      this._signal.removeEventListener('abort', this._abortListener);
    }
    const root = this._root;
    this._root = null;
    this._owner.release(this);
    this.mixer.destroy();
    this._poseApplier.destroy(root ? !root.destroyed : false);
    this._resolver.destroy();
    this._clips.length = 0;
  }

  private assertActive(): void {
    if (this._state !== 'active' || this._root?.destroyed) {
      this.destroy();
      throw new Error('glTF Animation3D runtime has been destroyed.');
    }
  }
}

export function createGltfAnimation3DRuntime(
  model: LoadedGltfModel,
  options: GltfAnimation3DRuntimeOptions = {},
): GltfAnimation3DRuntime {
  return new GltfAnimation3DRuntime(model, options);
}

/** Converts loaded legacy glTF clips without exposing glTF sampler structures. */
export function createGltfAnimation3DClips(
  model: LoadedGltfModel,
  clipIdPrefix?: string,
): readonly Animation3DClip[] {
  const context = createAdapterContext(model);
  return createClips(model.animationClips, context, clipIdPrefix);
}

function createAdapterContext(model: LoadedGltfModel): GltfAnimation3DAdapterContext {
  const targetSizes = new Map<GltfAnimationTarget, number>();
  const skinnedPrimitives = new Set<GltfSkinnedPrimitiveRuntime>();
  for (const clip of model.animationClips) {
    for (const channel of clip.channels) {
      const previousSize = targetSizes.get(channel.target) ?? channel.target.weights.length;
      targetSizes.set(channel.target, Math.max(previousSize, channel.path === 'weights' ? channel.valueSize : 0));
    }
    for (const primitive of clip.skinnedPrimitives) skinnedPrimitives.add(primitive);
  }

  const targetStates = new Map<GltfAnimationTarget, GltfAnimation3DTargetState>();
  for (const [target, weightSize] of targetSizes) {
    const nodePath = createStableNodePath(model.root, target.entity);
    const baseWeights = new Float32Array(Math.max(weightSize, target.weights.length));
    copyValues(target.weights, baseWeights, baseWeights.length);
    const baseRotation = new Float32Array(target.rotation);
    normalizeQuaternion(baseRotation);
    targetStates.set(target, {
      target,
      nodePath,
      nodeKey: nodePath.join('/'),
      baseTranslation: new Float32Array(target.translation),
      baseRotation,
      baseScale: new Float32Array(target.scale),
      baseWeights,
      translation: new Float32Array(target.translation),
      rotation: new Float32Array(baseRotation),
      scale: new Float32Array(target.scale),
      weights: new Float32Array(baseWeights),
      matrix: new Float32Array(16),
      seenGeneration: 0,
      touchedTransform: false,
      touchedWeights: false,
      appliedTransform: false,
      appliedWeights: false,
    });
  }

  const endpoints = new Map<string, GltfAnimation3DResolvedEndpoint>();
  const context: GltfAnimation3DAdapterContext = {
    targetStates,
    endpoints,
    skinnedPrimitives: [...skinnedPrimitives],
  };
  const updateSkinning = () => updateSkinnedPrimitives(context.skinnedPrimitives);
  for (const clip of model.animationClips) {
    for (const channel of clip.channels) {
      const state = requiredTargetState(context, channel.target);
      const binding = createBinding(state, channel.path, channel.valueSize);
      if (!endpoints.has(binding.id)) {
        endpoints.set(
          binding.id,
          new GltfAnimation3DResolvedEndpoint(binding, state, bindingPath(channel.path), updateSkinning),
        );
      }
    }
  }
  return context;
}

function createClips(
  clips: readonly GltfAnimationClip[],
  context: GltfAnimation3DAdapterContext,
  clipIdPrefix = 'gltf-animation',
): Animation3DClip[] {
  return clips.map((clip, clipIndex) => {
    const id = `${clipIdPrefix}:${clipIndex}`;
    const tracks = clip.channels.map((channel, channelIndex) => {
      const state = requiredTargetState(context, channel.target);
      const binding = context.endpoints.get(
        bindingId(state, bindingPath(channel.path)),
      )?.binding;
      if (!binding) throw new Error(`Missing glTF Animation3D binding for ${channel.path}.`);
      const times = copyFiniteValues(channel.input, `${id}.tracks[${channelIndex}].times`);
      validateTimes(times, clip.duration, `${id}.tracks[${channelIndex}].times`);
      const interpolation = mapInterpolation(channel.interpolation);
      const values = copyFiniteValues(channel.output, `${id}.tracks[${channelIndex}].values`);
      validateTrackValues(times, values, binding.valueSize, interpolation, `${id}.tracks[${channelIndex}]`);
      return {
        id: `${id}:track:${channelIndex}`,
        binding,
        interpolation,
        times,
        values,
      } satisfies Animation3DTrack;
    });
    return {
      format: 'haiyue-animation3d-clip@1',
      id,
      name: clip.name,
      duration: clip.duration,
      tracks,
      events: [],
    };
  });
}

function createBinding(
  state: GltfAnimation3DTargetState,
  path: GltfAnimationPath,
  valueSize: number,
): Animation3DBinding {
  const target = Object.freeze({
    kind: 'node-path' as const,
    segments: state.nodePath,
  });
  switch (path) {
    case 'translation':
      return {
        id: bindingId(state, 'transform.translation'),
        target,
        path: 'transform.translation',
        valueType: 'vec3',
        valueSize: 3,
      };
    case 'rotation':
      return {
        id: bindingId(state, 'transform.rotation'),
        target,
        path: 'transform.rotation',
        valueType: 'quaternion',
        valueSize: 4,
      };
    case 'scale':
      return {
        id: bindingId(state, 'transform.scale'),
        target,
        path: 'transform.scale',
        valueType: 'vec3',
        valueSize: 3,
      };
    case 'weights':
      if (!Number.isInteger(valueSize) || valueSize <= 0) {
        throw new RangeError(`glTF morph binding requires a positive valueSize; received ${valueSize}.`);
      }
      return {
        id: bindingId(state, 'morph.weights'),
        target,
        path: 'morph.weights',
        valueType: 'weights',
        valueSize,
      };
  }
}

function bindingPath(path: GltfAnimationPath): GltfAnimation3DBindingPath {
  switch (path) {
    case 'translation': return 'transform.translation';
    case 'rotation': return 'transform.rotation';
    case 'scale': return 'transform.scale';
    case 'weights': return 'morph.weights';
  }
}

function bindingId(state: GltfAnimation3DTargetState, path: GltfAnimation3DBindingPath): string {
  return `gltf:${state.nodeKey}:${path}`;
}

function mapInterpolation(
  interpolation: GltfAnimationChannelRuntime['interpolation'],
): Animation3DTrack['interpolation'] {
  switch (interpolation) {
    case 'STEP': return 'step';
    case 'CUBICSPLINE': return 'cubic-spline';
    case 'LINEAR': return 'linear';
  }
}

function requiredTargetState(
  context: GltfAnimation3DAdapterContext,
  target: GltfAnimationTarget,
): GltfAnimation3DTargetState {
  const state = context.targetStates.get(target);
  if (!state) throw new Error(`glTF animation target "${target.entity.name}" is not registered.`);
  return state;
}

function createStableNodePath(root: Entity, target: Entity): readonly string[] {
  const reversed: string[] = [];
  let current: Entity | null = target;
  while (current && current !== root) {
    const parent: Entity | null = current.parent;
    if (!parent) {
      throw new Error(`glTF animation target "${target.name}" is outside the loaded model root.`);
    }
    const siblingIndex = parent.children.indexOf(current);
    reversed.push(`${encodeURIComponent(current.name)}[${siblingIndex}]`);
    current = parent;
  }
  if (current !== root) {
    throw new Error(`glTF animation target "${target.name}" is outside the loaded model root.`);
  }
  reversed.reverse();
  return Object.freeze(reversed);
}

function copyFiniteValues(source: ArrayLike<number>, path: string): Float32Array {
  const out = new Float32Array(source.length);
  for (let index = 0; index < source.length; index++) {
    const value = source[index];
    if (!Number.isFinite(value)) throw new RangeError(`${path}[${index}] must be finite.`);
    out[index] = value as number;
  }
  return out;
}

function validateTimes(times: Float32Array, duration: number, path: string): void {
  if (times.length === 0) throw new RangeError(`${path} must contain at least one key.`);
  for (let index = 0; index < times.length; index++) {
    const value = times[index] as number;
    if ((index > 0 && value <= (times[index - 1] as number)) || value < 0 || value > duration) {
      throw new RangeError(`${path} must be strictly increasing and within clip duration.`);
    }
  }
}

function validateTrackValues(
  times: Float32Array,
  values: Float32Array,
  valueSize: number,
  interpolation: Animation3DTrack['interpolation'],
  path: string,
): void {
  const stride = interpolation === 'cubic-spline' ? valueSize * 3 : valueSize;
  const expected = times.length * stride;
  if (values.length !== expected) {
    throw new RangeError(`${path}.values requires ${expected} values; received ${values.length}.`);
  }
}

function commitTargetState(
  state: GltfAnimation3DTargetState,
  transformChanged: boolean,
  weightsChanged: boolean,
): void {
  if (transformChanged) {
    state.target.transform.localMatrix = composeTrsMatrix(
      state.translation,
      state.rotation,
      state.scale,
      state.matrix,
    );
  }
  if (weightsChanged) applyMorphWeights(state.target, state.weights);
}

function updateSkinnedPrimitives(primitives: readonly GltfSkinnedPrimitiveRuntime[]): void {
  for (const primitive of primitives) updateSkinnedPrimitive(primitive);
}

function copyValues(source: ArrayLike<number>, target: Float32Array, count: number): void {
  for (let index = 0; index < count; index++) target[index] = source[index] ?? 0;
}

function normalizeQuaternion(value: Float32Array): void {
  const x = value[0] ?? 0;
  const y = value[1] ?? 0;
  const z = value[2] ?? 0;
  const w = value[3] ?? 1;
  const length = Math.hypot(x, y, z, w);
  if (length <= Number.EPSILON) {
    value.set([0, 0, 0, 1]);
    return;
  }
  value[0] = x / length;
  value[1] = y / length;
  value[2] = z / length;
  value[3] = w / length;
}
