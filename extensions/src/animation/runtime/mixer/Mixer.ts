import type {
  AnimationStateMachineActionOptions,
  AnimationStateMachineMixerPort,
} from '../../../animation-state-machine/runtime/AnimationStateMachineMixerPort.js';
import {
  Animation2DActionRuntime,
  type Animation2DActionOwner,
  type Animation2DActionTrackRuntime,
} from './Action.js';
import { isNumericBinding, wrapAngle } from './Sampler.js';
import type {
  Animation2DActionOptions,
  Animation2DBinding,
  Animation2DClip,
  Animation2DMutablePose,
  Animation2DPose,
} from './Types.js';

interface LayerAccumulator {
  readonly layer: number;
  readonly overrideSum: Float32Array;
  readonly additiveSum: Float32Array;
  overrideWeight: number;
  rotationAnchor: number;
  rotationAnchorSet: boolean;
  dominantSet: boolean;
  dominantValue: unknown;
  dominantWeight: number;
  dominantOrder: number;
}

interface BindingAccumulator {
  readonly binding: Animation2DBinding;
  readonly result: Float32Array;
  readonly base: Float32Array;
  readonly layers: LayerAccumulator[];
  readonly layersById: Map<number, LayerAccumulator>;
  references: number;
  active: boolean;
}

/**
 * Format-independent 2D pose mixer and shared state-machine mixer port.
 *
 * Action/track/layer accumulators are retained across frames. Once actions
 * and their masks/layers have been warmed, update/evaluate allocates no
 * action- or property-proportional temporary objects.
 */
export class Animation2DMixerRuntime
implements Animation2DActionOwner, AnimationStateMachineMixerPort<Animation2DActionRuntime> {
  private readonly _clips = new Map<string, Animation2DClip>();
  private readonly _actions: Animation2DActionRuntime[] = [];
  private readonly _actionsById = new Map<string, Animation2DActionRuntime>();
  private readonly _accumulators = new Map<string, BindingAccumulator>();
  private readonly _accumulatorList: BindingAccumulator[] = [];
  private readonly _stateMachineLayers = new Map<string, number>();
  private _destroyed = false;
  private _time = 0;
  private _timeScale = 1;
  private _nextActionId = 1;
  private _nextActionOrder = 0;
  private _nextStateMachineLayer = 0;

  constructor(clips: readonly Animation2DClip[] = []) {
    for (let index = 0; index < clips.length; index++) this.registerClip(clips[index]!);
  }

  get time(): number { return this._time; }
  get timeScale(): number { return this._timeScale; }
  set timeScale(value: number) {
    this.assertActive();
    if (!Number.isFinite(value)) {
      throw new RangeError(`Animation2D mixer timeScale must be finite; received ${value}.`);
    }
    this._timeScale = value;
  }
  get actions(): readonly Animation2DActionRuntime[] { return this._actions; }
  get liveBindingCount(): number { return this._accumulators.size; }

  registerClip(clip: Animation2DClip): this {
    this.assertActive();
    const existing = this._clips.get(clip.id);
    if (existing && existing !== clip) {
      throw new RangeError(`Animation2D clip id "${clip.id}" is already registered.`);
    }
    this._clips.set(clip.id, clip);
    return this;
  }

  unregisterClip(clipId: string): boolean {
    this.assertActive();
    return this._clips.delete(clipId);
  }

  createAction(
    clip: Animation2DClip,
    options?: Animation2DActionOptions,
  ): Animation2DActionRuntime;
  createAction(
    clipId: string,
    options: AnimationStateMachineActionOptions,
  ): Animation2DActionRuntime;
  createAction(
    source: Animation2DClip | string,
    options: Animation2DActionOptions | AnimationStateMachineActionOptions = {},
  ): Animation2DActionRuntime {
    this.assertActive();
    const clip = typeof source === 'string' ? this._clips.get(source) : source;
    if (!clip) throw new RangeError(`Animation2D clip "${String(source)}" is not registered.`);
    const stateOptions = isStateMachineOptions(options) ? options : null;
    const runtimeOptions = stateOptions ? null : options as Animation2DActionOptions;
    const layer = stateOptions
      ? this._stateMachineLayer(stateOptions.layerId)
      : runtimeOptions!.layer ?? 0;
    const id = runtimeOptions?.id
      ? runtimeOptions.id
      : `${clip.id}:${stateOptions?.stateId ?? 'action'}:${this._nextActionId++}`;
    if (!id) throw new RangeError('Animation2D action id must not be empty.');
    if (this._actionsById.has(id)) {
      throw new RangeError(`Animation2D action id "${id}" already exists.`);
    }
    const actionOptions: Animation2DActionOptions = stateOptions
      ? {
          id,
          layer,
          loop: stateOptions.loop,
          blendMode: stateOptions.blendMode,
          ...(stateOptions.mask ? { mask: stateOptions.mask } : {}),
        }
      : { ...runtimeOptions!, id, layer };
    const action = new Animation2DActionRuntime(
      this,
      clip,
      id,
      this._nextActionOrder++,
      actionOptions,
    );
    for (let index = 0; index < action.runtimeTracks.length; index++) {
      this._retainBinding(action.runtimeTracks[index]!.track.binding, layer);
    }
    this._actions.push(action);
    this._actionsById.set(id, action);
    return action;
  }

  getAction(actionId: string): Animation2DActionRuntime | null {
    this.assertActive();
    return this._actionsById.get(actionId) ?? null;
  }

  removeAction(action: Animation2DActionRuntime | string): boolean {
    this.assertActive();
    const runtime = typeof action === 'string' ? this._actionsById.get(action) : action;
    if (!runtime || this._actionsById.get(runtime.id) !== runtime) return false;
    const index = this._actions.indexOf(runtime);
    if (index >= 0) this._actions.splice(index, 1);
    this._actionsById.delete(runtime.id);
    for (let trackIndex = 0; trackIndex < runtime.runtimeTracks.length; trackIndex++) {
      this._releaseBinding(runtime.runtimeTracks[trackIndex]!.track.binding);
    }
    runtime.invalidate();
    return true;
  }

  update(deltaSeconds: number, out: Animation2DMutablePose): Animation2DPose {
    this.assertActive();
    if (!Number.isFinite(deltaSeconds)) {
      throw new RangeError(`Animation2D mixer delta must be finite; received ${deltaSeconds}.`);
    }
    const mixerDelta = deltaSeconds * this._timeScale;
    this._time += mixerDelta;
    out.reset(this._time);
    this._advanceActions(mixerDelta, out);
    this._evaluateInto(out);
    return out.seal();
  }

  evaluate(out: Animation2DMutablePose): Animation2DPose {
    this.assertActive();
    out.reset(this._time);
    for (let index = 0; index < this._actions.length; index++) {
      this._actions[index]!.flushPendingEffects(out);
    }
    this._evaluateInto(out);
    return out.seal();
  }

  setMixerTime(timeSeconds: number, out: Animation2DMutablePose): Animation2DPose {
    this.assertActive();
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation2D mixer time must be finite; received ${timeSeconds}.`);
    }
    const delta = timeSeconds - this._time;
    this._time = timeSeconds;
    out.reset(this._time);
    this._advanceActions(delta, out);
    this._evaluateInto(out);
    return out.seal();
  }

  play(action: Animation2DActionRuntime): void {
    this._assertOwned(action);
    action.play();
  }

  stop(action: Animation2DActionRuntime): void {
    this._assertOwned(action);
    action.stop();
  }

  fade(action: Animation2DActionRuntime, targetWeight: number, durationSeconds: number): void {
    this._assertOwned(action);
    action.fadeTo(targetWeight, durationSeconds);
  }

  setWeight(action: Animation2DActionRuntime, weight: number): void {
    this._assertOwned(action);
    action.weight = weight;
  }

  setTime(action: Animation2DActionRuntime, timeSeconds: number): void {
    this._assertOwned(action);
    action.synchronizeTime(timeSeconds);
  }

  setTimeScale(action: Animation2DActionRuntime, timeScale: number): void {
    this._assertOwned(action);
    action.timeScale = timeScale;
  }

  destroyAction(action: Animation2DActionRuntime): void {
    this.removeAction(action);
  }

  destroy(): void {
    if (this._destroyed) return;
    for (let index = 0; index < this._actions.length; index++) this._actions[index]!.invalidate();
    this._actions.length = 0;
    this._actionsById.clear();
    this._accumulators.clear();
    this._accumulatorList.length = 0;
    this._clips.clear();
    this._stateMachineLayers.clear();
    this._destroyed = true;
  }

  assertActive(): void {
    if (this._destroyed) throw new Error('Animation2D mixer has been destroyed.');
  }

  private _advanceActions(mixerDelta: number, out: Animation2DMutablePose): void {
    for (let index = 0; index < this._actions.length; index++) {
      this._actions[index]!.advance(mixerDelta, out);
    }
  }

  private _evaluateInto(out: Animation2DMutablePose): void {
    for (let index = 0; index < this._accumulatorList.length; index++) {
      resetAccumulator(this._accumulatorList[index]!);
    }

    for (let actionIndex = 0; actionIndex < this._actions.length; actionIndex++) {
      const action = this._actions[actionIndex]!;
      const weight = action.effectiveWeight;
      if (weight <= 0) continue;
      for (let trackIndex = 0; trackIndex < action.runtimeTracks.length; trackIndex++) {
        const runtimeTrack = action.runtimeTracks[trackIndex]!;
        const binding = runtimeTrack.track.binding;
        if (!action.acceptsBinding(binding)) continue;
        const accumulator = this._accumulators.get(binding.id);
        if (!accumulator) continue;
        let layer = accumulator.layersById.get(action.layer);
        if (!layer) {
          layer = createLayerAccumulator(binding, action.layer);
          insertLayer(accumulator, layer);
        }
        accumulator.active = true;
        const sampled = runtimeTrack.sampler.sample(action.time);
        if (isNumericBinding(binding)) {
          accumulateNumeric(
            layer,
            binding,
            runtimeTrack,
            sampled as Float32Array,
            weight,
            action.blendMode,
          );
        } else {
          accumulateDominant(layer, sampled, weight, action.order);
        }
      }
    }

    for (let index = 0; index < this._accumulatorList.length; index++) {
      const accumulator = this._accumulatorList[index]!;
      if (!accumulator.active) continue;
      if (isNumericBinding(accumulator.binding)) {
        finalizeNumeric(accumulator);
        out.writeNumeric(accumulator.binding, accumulator.result);
      } else {
        let hasValue = false;
        let value: unknown;
        for (let layerIndex = 0; layerIndex < accumulator.layers.length; layerIndex++) {
          const layer = accumulator.layers[layerIndex]!;
          if (!layer.dominantSet) continue;
          hasValue = true;
          value = layer.dominantValue;
        }
        if (hasValue) out.writeDiscrete(accumulator.binding, value);
      }
    }
  }

  private _retainBinding(binding: Animation2DBinding, layer: number): void {
    const existing = this._accumulators.get(binding.id);
    if (existing) {
      if (existing.binding.strategy !== binding.strategy
        || existing.binding.valueSize !== binding.valueSize) {
        throw new RangeError(`Animation2D binding id "${binding.id}" has incompatible contracts.`);
      }
      existing.references++;
      if (!existing.layersById.has(layer)) insertLayer(existing, createLayerAccumulator(binding, layer));
      return;
    }
    const size = isNumericBinding(binding) ? binding.valueSize! : 0;
    const accumulator: BindingAccumulator = {
      binding,
      result: new Float32Array(size),
      base: new Float32Array(size),
      layers: [],
      layersById: new Map(),
      references: 1,
      active: false,
    };
    writeDefaultBase(binding, accumulator.base);
    insertLayer(accumulator, createLayerAccumulator(binding, layer));
    this._accumulators.set(binding.id, accumulator);
    this._accumulatorList.push(accumulator);
  }

  private _releaseBinding(binding: Animation2DBinding): void {
    const accumulator = this._accumulators.get(binding.id);
    if (!accumulator) return;
    accumulator.references--;
    if (accumulator.references > 0) return;
    this._accumulators.delete(binding.id);
    const index = this._accumulatorList.indexOf(accumulator);
    if (index >= 0) this._accumulatorList.splice(index, 1);
  }

  private _stateMachineLayer(layerId: string): number {
    const existing = this._stateMachineLayers.get(layerId);
    if (existing !== undefined) return existing;
    const layer = this._nextStateMachineLayer++;
    this._stateMachineLayers.set(layerId, layer);
    return layer;
  }

  private _assertOwned(action: Animation2DActionRuntime): void {
    this.assertActive();
    if (this._actionsById.get(action.id) !== action) {
      throw new RangeError('Animation2D action does not belong to this mixer.');
    }
  }
}

function resetAccumulator(accumulator: BindingAccumulator): void {
  accumulator.active = false;
  for (let index = 0; index < accumulator.layers.length; index++) {
    const layer = accumulator.layers[index]!;
    layer.overrideSum.fill(0);
    layer.additiveSum.fill(0);
    layer.overrideWeight = 0;
    layer.rotationAnchor = 0;
    layer.rotationAnchorSet = false;
    layer.dominantSet = false;
    layer.dominantValue = undefined;
    layer.dominantWeight = -1;
    layer.dominantOrder = Number.MAX_SAFE_INTEGER;
  }
}

function createLayerAccumulator(binding: Animation2DBinding, layer: number): LayerAccumulator {
  const size = isNumericBinding(binding) ? binding.valueSize! : 0;
  return {
    layer,
    overrideSum: new Float32Array(size),
    additiveSum: new Float32Array(size),
    overrideWeight: 0,
    rotationAnchor: 0,
    rotationAnchorSet: false,
    dominantSet: false,
    dominantValue: undefined,
    dominantWeight: -1,
    dominantOrder: Number.MAX_SAFE_INTEGER,
  };
}

function insertLayer(accumulator: BindingAccumulator, layer: LayerAccumulator): void {
  let index = accumulator.layers.length;
  while (index > 0 && accumulator.layers[index - 1]!.layer > layer.layer) index--;
  accumulator.layers.splice(index, 0, layer);
  accumulator.layersById.set(layer.layer, layer);
}

function accumulateNumeric(
  layer: LayerAccumulator,
  binding: Animation2DBinding,
  runtimeTrack: Animation2DActionTrackRuntime,
  sampled: Float32Array,
  weight: number,
  blendMode: 'override' | 'additive',
): void {
  if (blendMode === 'additive') {
    if (binding.strategy === 'rotation') {
      layer.additiveSum[0] = layer.additiveSum[0]!
        + wrapAngle(sampled[0]! - runtimeTrack.reference[0]!) * weight;
      return;
    }
    for (let index = 0; index < sampled.length; index++) {
      layer.additiveSum[index] = layer.additiveSum[index]!
        + (sampled[index]! - runtimeTrack.reference[index]!) * weight;
    }
    return;
  }

  if (binding.strategy === 'rotation') {
    if (!layer.rotationAnchorSet) {
      layer.rotationAnchor = sampled[0]!;
      layer.rotationAnchorSet = true;
    }
    const unwrapped = layer.rotationAnchor + wrapAngle(sampled[0]! - layer.rotationAnchor);
    layer.overrideSum[0] = layer.overrideSum[0]! + unwrapped * weight;
  } else {
    for (let index = 0; index < sampled.length; index++) {
      layer.overrideSum[index] = layer.overrideSum[index]! + sampled[index]! * weight;
    }
  }
  layer.overrideWeight += weight;
}

function accumulateDominant(
  layer: LayerAccumulator,
  value: unknown,
  weight: number,
  order: number,
): void {
  if (weight < layer.dominantWeight
    || (weight === layer.dominantWeight && order >= layer.dominantOrder)) return;
  layer.dominantSet = true;
  layer.dominantValue = value;
  layer.dominantWeight = weight;
  layer.dominantOrder = order;
}

function finalizeNumeric(accumulator: BindingAccumulator): void {
  const binding = accumulator.binding;
  const result = accumulator.result;
  result.set(accumulator.base);
  for (let layerIndex = 0; layerIndex < accumulator.layers.length; layerIndex++) {
    const layer = accumulator.layers[layerIndex]!;
    const weight = layer.overrideWeight;
    if (weight > 0) {
      if (binding.strategy === 'rotation') {
        const target = layer.overrideSum[0]! / weight;
        const current = target + wrapAngle(result[0]! - target);
        const alpha = Math.min(1, weight);
        result[0] = current + (target - current) * alpha;
      } else if (weight < 1) {
        const baseWeight = 1 - weight;
        for (let index = 0; index < result.length; index++) {
          result[index] = layer.overrideSum[index]! + result[index]! * baseWeight;
        }
      } else {
        const inverseWeight = 1 / weight;
        for (let index = 0; index < result.length; index++) {
          result[index] = layer.overrideSum[index]! * inverseWeight;
        }
      }
    }
    for (let index = 0; index < result.length; index++) {
      result[index] = result[index]! + layer.additiveSum[index]!;
    }
    if (binding.strategy === 'rotation') result[0] = wrapAngle(result[0]!);
  }
}

function writeDefaultBase(binding: Animation2DBinding, out: Float32Array): void {
  const authored = binding.defaultValue;
  if (authored && typeof authored === 'object' && 'length' in authored) {
    const values = authored as ArrayLike<number>;
    for (let index = 0; index < out.length; index++) out[index] = values[index] ?? 0;
    return;
  }
  out.fill(0);
  if (binding.path === 'transform.scale'
    || binding.path === 'opacity'
    || binding.path === 'color') out.fill(1);
}

function isStateMachineOptions(
  options: Animation2DActionOptions | AnimationStateMachineActionOptions,
): options is AnimationStateMachineActionOptions {
  return 'layerId' in options && 'stateId' in options;
}
