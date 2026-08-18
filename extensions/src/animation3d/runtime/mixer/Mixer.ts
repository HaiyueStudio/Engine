import type {
  Animation3DBinding,
  Animation3DBindingResolver,
  Animation3DResolvedBinding,
} from '../../Animation3DBinding.js';
import type { Animation3DAction, Animation3DActionOptions } from '../../Animation3DAction.js';
import type { Animation3DClip } from '../../Animation3DClip.js';
import { Animation3DError } from '../../Animation3DError.js';
import type { Animation3DMixerState } from '../../Animation3DMixer.js';
import type { Animation3DMutablePose, Animation3DPose } from '../../Animation3DPose.js';
import {
  Animation3DActionRuntime,
  type Animation3DActionOwner,
  type Animation3DActionTrackRuntime,
} from './Action.js';
import { normalizeQuaternion } from './TrackSampler.js';

interface BindingAccumulator {
  readonly binding: Animation3DBinding;
  readonly base: Float32Array;
  readonly result: Float32Array;
  readonly overrideSum: Float32Array;
  readonly additiveSum: Float32Array;
  readonly quaternionAnchor: Float32Array;
  readonly additiveQuaternion: Float32Array;
  references: number;
  active: boolean;
  overrideWeight: number;
  quaternionAnchorSet: boolean;
  additiveQuaternionUsed: boolean;
}

/**
 * Contract-compatible Animation3D mixer runtime.
 *
 * Clips remain caller-owned immutable values. The mixer caches only samplers,
 * blend accumulators, and resolver results; it never retains AssetHandles.
 */
export class Animation3DMixerRuntime implements Animation3DActionOwner {
  readonly resolver: Animation3DBindingResolver;

  private readonly _actions: Animation3DActionRuntime[] = [];
  private readonly _actionsById = new Map<string, Animation3DActionRuntime>();
  private readonly _accumulators = new Map<string, BindingAccumulator>();
  private readonly _accumulatorList: BindingAccumulator[] = [];
  private readonly _resolvedBindings = new Map<string, Animation3DResolvedBinding | null>();
  private _resolverRevision = Number.NaN;
  private _state: Animation3DMixerState = 'active';
  private _time = 0;
  private _timeScale = 1;
  private _nextActionId = 1;
  private _synchronizedFrameOut: Animation3DMutablePose | null = null;
  private _synchronizedPreviousTime = 0;

  constructor(resolver: Animation3DBindingResolver) {
    this.resolver = resolver;
  }

  get state(): Animation3DMixerState { return this._state; }
  get actions(): readonly Animation3DAction[] { return this._actions; }
  get liveBindingCount(): number { return this._accumulators.size; }
  get time(): number { return this._time; }
  get timeScale(): number { return this._timeScale; }
  set timeScale(value: number) {
    this.assertActive();
    if (!Number.isFinite(value)) {
      throw new RangeError(`Animation3DMixer.timeScale must be finite; received ${value}.`);
    }
    this._timeScale = value;
  }

  createAction(clip: Animation3DClip, options: Animation3DActionOptions = {}): Animation3DAction {
    this.assertActive();
    const clipId = typeof clip?.id === 'string' ? clip.id : '';
    const id = options.id ?? `${clipId}:${this._nextActionId++}`;
    if (!id) {
      throw new Animation3DError(
        'invalid-action',
        'Animation3D action id must not be empty.',
        { clipId },
      );
    }
    if (this._actionsById.has(id)) {
      throw new Animation3DError(
        'duplicate-action-id',
        `Animation3D action id "${id}" already exists in this mixer.`,
        { actionId: id },
      );
    }
    const action = new Animation3DActionRuntime(this, clip, id, options);
    for (let index = 0; index < action.runtimeTracks.length; index++) {
      this._retainBinding(action.runtimeTracks[index]!.track.binding);
    }
    this._actions.push(action);
    this._actionsById.set(id, action);
    return action;
  }

  getAction(actionId: string): Animation3DAction | null {
    this.assertActive();
    return this._actionsById.get(actionId) ?? null;
  }

  removeAction(action: Animation3DAction | string): boolean {
    this.assertActive();
    const runtime = typeof action === 'string'
      ? this._actionsById.get(action)
      : action instanceof Animation3DActionRuntime
        ? action
        : undefined;
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

  stopAllActions(): this {
    this.assertActive();
    for (let index = 0; index < this._actions.length; index++) this._actions[index]!.stop();
    return this;
  }

  update(deltaSeconds: number, out: Animation3DMutablePose): Animation3DPose {
    this.assertActive();
    this._requireIndependentClock();
    if (!Number.isFinite(deltaSeconds)) {
      throw new RangeError(`Animation3DMixer delta must be finite; received ${deltaSeconds}.`);
    }
    const previousTime = this._time;
    const mixerDelta = deltaSeconds * this._timeScale;
    this._time += mixerDelta;
    out.reset(this._time);
    this._advanceActions(mixerDelta, previousTime, this._time, out);
    this._evaluateInto(out);
    return out.seal();
  }

  evaluate(out: Animation3DMutablePose): Animation3DPose {
    this.assertActive();
    this._requireIndependentClock();
    out.reset(this._time);
    this._evaluateInto(out);
    return out.seal();
  }

  setTime(timeSeconds: number, out: Animation3DMutablePose): Animation3DPose {
    this.assertActive();
    this._requireIndependentClock();
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation3DMixer time must be finite; received ${timeSeconds}.`);
    }
    const previousTime = this._time;
    const mixerDelta = timeSeconds - previousTime;
    this._time = timeSeconds;
    out.reset(this._time);
    this._advanceActions(mixerDelta, previousTime, this._time, out);
    this._evaluateInto(out);
    return out.seal();
  }

  /**
   * Opens an externally-clocked evaluation frame. Ordinary update/evaluate/
   * setTime calls are rejected until the synchronized frame is closed.
   */
  beginSynchronizedFrame(timeSeconds: number, out: Animation3DMutablePose): void {
    this.assertActive();
    if (this._synchronizedFrameOut) {
      throw new Error('Animation3D mixer already has an active synchronized frame.');
    }
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation3D synchronized frame time must be finite; received ${timeSeconds}.`);
    }
    this._synchronizedPreviousTime = this._time;
    this._time = timeSeconds;
    this._synchronizedFrameOut = out;
    out.reset(timeSeconds);
  }

  endSynchronizedFrame(out: Animation3DMutablePose): Animation3DPose {
    this.assertActive();
    if (this._synchronizedFrameOut !== out) {
      throw new Error('Animation3D synchronized frame output does not match the active frame.');
    }
    try {
      this._evaluateInto(out);
      const pose = out.seal();
      this._synchronizedFrameOut = null;
      this._synchronizedPreviousTime = this._time;
      return pose;
    } catch (error) {
      this._time = this._synchronizedPreviousTime;
      this._synchronizedFrameOut = null;
      throw error;
    }
  }

  cancelSynchronizedFrame(out: Animation3DMutablePose): void {
    if (this._synchronizedFrameOut !== out) return;
    this._time = this._synchronizedPreviousTime;
    this._synchronizedFrameOut = null;
  }

  /** @internal Restores a completed frame when a sibling mixer in one controller transaction fails. */
  rollbackCompletedSynchronizedFrame(timeSeconds: number): void {
    this.assertActive();
    if (this._synchronizedFrameOut) {
      throw new Error('Animation3D mixer cannot roll back a completed frame while another frame is active.');
    }
    if (!Number.isFinite(timeSeconds)) {
      throw new RangeError(`Animation3D rollback time must be finite; received ${timeSeconds}.`);
    }
    this._time = timeSeconds;
    this._synchronizedPreviousTime = timeSeconds;
  }

  destroy(): void {
    if (this._state === 'destroyed') return;
    for (let index = 0; index < this._actions.length; index++) this._actions[index]!.invalidate();
    this._actions.length = 0;
    this._actionsById.clear();
    this._accumulatorList.length = 0;
    this._accumulators.clear();
    this._resolvedBindings.clear();
    this._synchronizedFrameOut = null;
    this._synchronizedPreviousTime = 0;
    this._state = 'destroyed';
  }

  assertActive(): void {
    if (this._state !== 'active') {
      throw new Animation3DError(
        'mixer-destroyed',
        'Animation3D mixer has been destroyed.',
      );
    }
  }

  private _requireIndependentClock(): void {
    if (this._synchronizedFrameOut) {
      throw new Error(
        'Animation3D mixer clock cannot advance during a controller-owned synchronized frame.',
      );
    }
  }

  private _advanceActions(
    mixerDelta: number,
    previousTime: number,
    currentTime: number,
    out: Animation3DMutablePose,
  ): void {
    for (let index = 0; index < this._actions.length; index++) {
      this._actions[index]!.advance(mixerDelta, previousTime, currentTime, out);
    }
  }

  private _evaluateInto(out: Animation3DMutablePose): void {
    this._invalidateResolvedBindingsIfNeeded();
    for (let index = 0; index < this._accumulatorList.length; index++) {
      resetAccumulator(this._accumulatorList[index]!);
    }

    for (let actionIndex = 0; actionIndex < this._actions.length; actionIndex++) {
      const action = this._actions[actionIndex]!;
      const weight = action.effectiveWeight;
      if (weight <= 0) continue;
      const tracks = action.runtimeTracks;
      for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
        const runtimeTrack = tracks[trackIndex]!;
        const binding = runtimeTrack.track.binding;
        if (!action.acceptsBinding(binding)) continue;
        const accumulator = this._accumulators.get(binding.id);
        if (!accumulator) continue;
        const sampled = runtimeTrack.sampler.sample(action.time);
        accumulator.active = true;
        if (action.blendMode === 'additive') {
          accumulateAdditive(accumulator, runtimeTrack, sampled, weight);
        } else {
          accumulateOverride(accumulator, sampled, weight);
        }
      }
    }

    for (let index = 0; index < this._accumulatorList.length; index++) {
      const accumulator = this._accumulatorList[index]!;
      if (!accumulator.active) continue;
      this._readBase(accumulator);
      finalizeAccumulator(accumulator);
      out.write(accumulator.binding, accumulator.result);
    }
  }

  private _retainBinding(binding: Animation3DBinding): void {
    const existing = this._accumulators.get(binding.id);
    if (existing) {
      if (existing.binding.valueSize !== binding.valueSize
        || existing.binding.valueType !== binding.valueType) {
        throw new RangeError(`Animation3D binding id "${binding.id}" has incompatible value contracts.`);
      }
      existing.references++;
      return;
    }
    const size = binding.valueSize;
    const accumulator: BindingAccumulator = {
      binding,
      base: new Float32Array(size),
      result: new Float32Array(size),
      overrideSum: new Float32Array(size),
      additiveSum: new Float32Array(size),
      quaternionAnchor: new Float32Array(4),
      additiveQuaternion: new Float32Array([0, 0, 0, 1]),
      references: 1,
      active: false,
      overrideWeight: 0,
      quaternionAnchorSet: false,
      additiveQuaternionUsed: false,
    };
    this._accumulators.set(binding.id, accumulator);
    this._accumulatorList.push(accumulator);
  }

  private _releaseBinding(binding: Animation3DBinding): void {
    const accumulator = this._accumulators.get(binding.id);
    if (!accumulator) return;
    accumulator.references--;
    if (accumulator.references > 0) return;
    this._accumulators.delete(binding.id);
    this._resolvedBindings.delete(binding.id);
    const index = this._accumulatorList.indexOf(accumulator);
    if (index >= 0) this._accumulatorList.splice(index, 1);
  }

  private _invalidateResolvedBindingsIfNeeded(): void {
    if (this._resolverRevision === this.resolver.revision) return;
    this._resolverRevision = this.resolver.revision;
    this._resolvedBindings.clear();
  }

  private _readBase(accumulator: BindingAccumulator): void {
    const id = accumulator.binding.id;
    let resolved = this._resolvedBindings.get(id);
    if (resolved === undefined && !this._resolvedBindings.has(id)) {
      resolved = this.resolver.resolve(accumulator.binding);
      this._resolvedBindings.set(id, resolved);
    }
    if (resolved) {
      resolved.read(accumulator.base);
      return;
    }
    throw new Animation3DError(
      'resolver-miss',
      `Animation3D binding resolver could not resolve "${id}".`,
      { resolver: 'binding', bindingId: id },
    );
  }
}

function resetAccumulator(accumulator: BindingAccumulator): void {
  accumulator.active = false;
  accumulator.overrideWeight = 0;
  accumulator.quaternionAnchorSet = false;
  accumulator.additiveQuaternionUsed = false;
  accumulator.overrideSum.fill(0);
  accumulator.additiveSum.fill(0);
  accumulator.additiveQuaternion[0] = 0;
  accumulator.additiveQuaternion[1] = 0;
  accumulator.additiveQuaternion[2] = 0;
  accumulator.additiveQuaternion[3] = 1;
}

function accumulateOverride(
  accumulator: BindingAccumulator,
  sampled: Float32Array,
  weight: number,
): void {
  if (accumulator.binding.valueType !== 'quaternion') {
    for (let index = 0; index < sampled.length; index++) {
      accumulator.overrideSum[index] = accumulator.overrideSum[index]! + sampled[index]! * weight;
    }
    accumulator.overrideWeight += weight;
    return;
  }

  let sign = 1;
  if (!accumulator.quaternionAnchorSet) {
    accumulator.quaternionAnchor.set(sampled);
    accumulator.quaternionAnchorSet = true;
  } else {
    const dot = accumulator.quaternionAnchor[0]! * sampled[0]!
      + accumulator.quaternionAnchor[1]! * sampled[1]!
      + accumulator.quaternionAnchor[2]! * sampled[2]!
      + accumulator.quaternionAnchor[3]! * sampled[3]!;
    if (dot < 0) sign = -1;
  }
  for (let index = 0; index < 4; index++) {
    accumulator.overrideSum[index] = accumulator.overrideSum[index]!
      + sampled[index]! * weight * sign;
  }
  accumulator.overrideWeight += weight;
}

function accumulateAdditive(
  accumulator: BindingAccumulator,
  runtimeTrack: Animation3DActionTrackRuntime,
  sampled: Float32Array,
  weight: number,
): void {
  if (accumulator.binding.valueType === 'quaternion') {
    accumulateAdditiveQuaternion(
      accumulator.additiveQuaternion,
      sampled,
      runtimeTrack.reference,
      weight,
    );
    accumulator.additiveQuaternionUsed = true;
    return;
  }
  for (let index = 0; index < sampled.length; index++) {
    accumulator.additiveSum[index] = accumulator.additiveSum[index]!
      + (sampled[index]! - runtimeTrack.reference[index]!) * weight;
  }
}

function finalizeAccumulator(accumulator: BindingAccumulator): void {
  const size = accumulator.binding.valueSize;
  const overrideWeight = accumulator.overrideWeight;
  if (accumulator.binding.valueType !== 'quaternion') {
    if (overrideWeight > 0) {
      if (overrideWeight < 1) {
        const baseWeight = 1 - overrideWeight;
        for (let index = 0; index < size; index++) {
          accumulator.result[index] = accumulator.overrideSum[index]!
            + accumulator.base[index]! * baseWeight;
        }
      } else {
        const inverseWeight = 1 / overrideWeight;
        for (let index = 0; index < size; index++) {
          accumulator.result[index] = accumulator.overrideSum[index]! * inverseWeight;
        }
      }
    } else {
      accumulator.result.set(accumulator.base);
    }
    for (let index = 0; index < size; index++) {
      accumulator.result[index] = accumulator.result[index]! + accumulator.additiveSum[index]!;
    }
    return;
  }

  if (overrideWeight > 0) {
    accumulator.result.set(accumulator.overrideSum);
    if (overrideWeight < 1) {
      let sign = 1;
      const anchorDot = accumulator.quaternionAnchor[0]! * accumulator.base[0]!
        + accumulator.quaternionAnchor[1]! * accumulator.base[1]!
        + accumulator.quaternionAnchor[2]! * accumulator.base[2]!
        + accumulator.quaternionAnchor[3]! * accumulator.base[3]!;
      if (anchorDot < 0) sign = -1;
      const baseWeight = 1 - overrideWeight;
      for (let index = 0; index < 4; index++) {
        accumulator.result[index] = accumulator.result[index]!
          + accumulator.base[index]! * baseWeight * sign;
      }
    }
    normalizeQuaternion(accumulator.result);
  } else {
    accumulator.result.set(accumulator.base);
    normalizeQuaternion(accumulator.result);
  }
  if (accumulator.additiveQuaternionUsed) {
    multiplyQuaternionInPlace(accumulator.result, accumulator.additiveQuaternion);
    normalizeQuaternion(accumulator.result);
  }
}

function accumulateAdditiveQuaternion(
  accumulated: Float32Array,
  sampled: Float32Array,
  reference: Float32Array,
  weight: number,
): void {
  const rx = reference[0]!;
  const ry = reference[1]!;
  const rz = reference[2]!;
  const rw = reference[3]!;
  const inverseLengthSquared = 1 / Math.max(
    Number.EPSILON,
    rx * rx + ry * ry + rz * rz + rw * rw,
  );
  const ix = -rx * inverseLengthSquared;
  const iy = -ry * inverseLengthSquared;
  const iz = -rz * inverseLengthSquared;
  const iw = rw * inverseLengthSquared;
  const sx = sampled[0]!;
  const sy = sampled[1]!;
  const sz = sampled[2]!;
  const sw = sampled[3]!;
  let dx = iw * sx + ix * sw + iy * sz - iz * sy;
  let dy = iw * sy - ix * sz + iy * sw + iz * sx;
  let dz = iw * sz + ix * sy - iy * sx + iz * sw;
  let dw = iw * sw - ix * sx - iy * sy - iz * sz;
  if (dw < 0) {
    dx = -dx;
    dy = -dy;
    dz = -dz;
    dw = -dw;
  }
  dw = Math.min(1, Math.max(-1, dw));

  let wx: number;
  let wy: number;
  let wz: number;
  let ww: number;
  if (dw > 0.9995) {
    wx = dx * weight;
    wy = dy * weight;
    wz = dz * weight;
    ww = 1 + (dw - 1) * weight;
    const inverseLength = 1 / Math.max(Number.EPSILON, Math.hypot(wx, wy, wz, ww));
    wx *= inverseLength;
    wy *= inverseLength;
    wz *= inverseLength;
    ww *= inverseLength;
  } else {
    const theta = Math.acos(dw);
    const scale = Math.sin(theta * weight) / Math.sin(theta);
    wx = dx * scale;
    wy = dy * scale;
    wz = dz * scale;
    ww = Math.cos(theta * weight);
  }

  const ax = accumulated[0]!;
  const ay = accumulated[1]!;
  const az = accumulated[2]!;
  const aw = accumulated[3]!;
  accumulated[0] = aw * wx + ax * ww + ay * wz - az * wy;
  accumulated[1] = aw * wy - ax * wz + ay * ww + az * wx;
  accumulated[2] = aw * wz + ax * wy - ay * wx + az * ww;
  accumulated[3] = aw * ww - ax * wx - ay * wy - az * wz;
  normalizeQuaternion(accumulated);
}

function multiplyQuaternionInPlace(target: Float32Array, right: Float32Array): void {
  const ax = target[0]!;
  const ay = target[1]!;
  const az = target[2]!;
  const aw = target[3]!;
  const bx = right[0]!;
  const by = right[1]!;
  const bz = right[2]!;
  const bw = right[3]!;
  target[0] = aw * bx + ax * bw + ay * bz - az * by;
  target[1] = aw * by - ax * bz + ay * bw + az * bx;
  target[2] = aw * bz + ax * by - ay * bx + az * bw;
  target[3] = aw * bw - ax * bx - ay * by - az * bz;
}
