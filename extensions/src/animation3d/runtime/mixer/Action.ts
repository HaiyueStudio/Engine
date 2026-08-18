import type { Animation3DBinding, Animation3DBindingMask } from '../../Animation3DBinding.js';
import type {
  Animation3DAction,
  Animation3DActionOptions,
  Animation3DActionStatus,
  Animation3DBlendMode,
  Animation3DLoopMode,
} from '../../Animation3DAction.js';
import type { Animation3DClip, Animation3DEvent } from '../../Animation3DClip.js';
import { Animation3DError } from '../../Animation3DError.js';
import type { Animation3DMutablePose, Animation3DPoseEvent } from '../../Animation3DPose.js';
import type { Animation3DTrack } from '../../Animation3DTrack.js';
import {
  Animation3DTrackSampler,
  validateAnimation3DTrack,
} from './TrackSampler.js';

export interface Animation3DActionOwner {
  readonly time: number;
  assertActive(): void;
}

export interface Animation3DActionTrackRuntime {
  readonly track: Animation3DTrack;
  readonly sampler: Animation3DTrackSampler;
  readonly reference: Float32Array;
}

interface RuntimeClipEvent {
  readonly event: Animation3DEvent;
  readonly poseEvent: Animation3DPoseEvent;
}

/** @internal Reusable exact state used by controller-owned frame transactions. */
export interface Animation3DActionSynchronizedState {
  status: Animation3DActionStatus;
  enabled: boolean;
  paused: boolean;
  time: number;
  rawTime: number;
  timeScale: number;
  weight: number;
  loop: Animation3DLoopMode;
  repetitions: number;
  clampWhenFinished: boolean;
  blendMode: Animation3DBlendMode;
  mask: Animation3DBindingMask | null;
  startTime: number | null;
  eventsStarted: boolean;
  fadeActive: boolean;
  fadeStart: number;
  fadeEnd: number;
  fadeFrom: number;
  fadeTo: number;
  fadeValue: number;
  warpActive: boolean;
  warpStart: number;
  warpEnd: number;
  warpFrom: number;
  warpTo: number;
  warpValue: number;
}

/**
 * Mutable mixer-owned playback state for one immutable clip.
 */
export class Animation3DActionRuntime implements Animation3DAction {
  readonly id: string;
  readonly clip: Animation3DClip;
  readonly runtimeTracks: readonly Animation3DActionTrackRuntime[];

  private readonly _owner: Animation3DActionOwner;
  private readonly _runtimeEvents: readonly RuntimeClipEvent[];
  private _valid = true;
  private _status: Animation3DActionStatus = 'idle';
  private _enabled = true;
  private _paused = false;
  private _time = 0;
  private _rawTime = 0;
  private _timeScale: number;
  private _weight: number;
  private _loop: Animation3DLoopMode;
  private _repetitions: number;
  private _clampWhenFinished: boolean;
  private _blendMode: Animation3DBlendMode;
  private _mask: Animation3DBindingMask | null;
  private _startTime: number | null = null;
  private _eventsStarted = false;

  private _fadeActive = false;
  private _fadeStart = 0;
  private _fadeEnd = 0;
  private _fadeFrom = 1;
  private _fadeTo = 1;
  private _fadeValue = 1;

  private _warpActive = false;
  private _warpStart = 0;
  private _warpEnd = 0;
  private _warpFrom = 1;
  private _warpTo = 1;
  private _warpValue = 1;

  constructor(
    owner: Animation3DActionOwner,
    clip: Animation3DClip,
    id: string,
    options: Animation3DActionOptions = {},
  ) {
    validateClip(clip);
    this._owner = owner;
    this.clip = clip;
    this.id = id;
    this._loop = options.loop ?? 'once';
    this._repetitions = validateRepetitions(
      options.repetitions ?? (this._loop === 'once' ? 1 : Infinity),
    );
    this._clampWhenFinished = options.clampWhenFinished ?? false;
    this._timeScale = finiteNumber(options.timeScale ?? 1, 'Animation3DAction.timeScale');
    this._weight = nonNegativeNumber(options.weight ?? 1, 'Animation3DAction.weight');
    this._blendMode = options.blendMode ?? 'override';
    this._mask = options.mask ?? null;

    const tracks: Animation3DActionTrackRuntime[] = [];
    for (let index = 0; index < clip.tracks.length; index++) {
      const track = clip.tracks[index]!;
      const sampler = new Animation3DTrackSampler(track);
      const reference = new Float32Array(track.binding.valueSize);
      sampler.sample(0, reference);
      tracks.push({ track, sampler, reference });
    }
    this.runtimeTracks = tracks;

    const sortedEvents = [...clip.events].sort((a, b) => a.time - b.time);
    const runtimeEvents: RuntimeClipEvent[] = [];
    for (let index = 0; index < sortedEvents.length; index++) {
      const event = sortedEvents[index]!;
      runtimeEvents.push({
        event,
        poseEvent: { actionId: id, clipId: clip.id, event },
      });
    }
    this._runtimeEvents = runtimeEvents;
  }

  get status(): Animation3DActionStatus { return this._status; }
  get enabled(): boolean { return this._enabled; }
  set enabled(value: boolean) {
    this._assertValid();
    this._enabled = Boolean(value);
  }
  get paused(): boolean { return this._paused; }
  set paused(value: boolean) {
    this._assertValid();
    const next = Boolean(value);
    if (this._paused === next) return;
    this._paused = next;
    if (next && (this._status === 'running' || this._status === 'scheduled')) {
      this._status = 'paused';
    } else if (!next && this._status === 'paused') {
      this._status = this._startTime !== null && this._owner.time < this._startTime
        ? 'scheduled'
        : 'running';
    }
  }
  get time(): number { return this._time; }
  set time(value: number) {
    this._assertValid();
    const duration = this.clip.duration;
    const next = Math.min(duration, Math.max(0, finiteNumber(value, 'Animation3DAction.time')));
    this._rawTime = next;
    this._time = next;
    this._eventsStarted = false;
    this._resetSamplerCursors();
  }
  get timeScale(): number { return this._timeScale; }
  set timeScale(value: number) {
    this._assertValid();
    this._timeScale = finiteNumber(value, 'Animation3DAction.timeScale');
  }
  get weight(): number { return this._weight; }
  set weight(value: number) {
    this._assertValid();
    this._weight = nonNegativeNumber(value, 'Animation3DAction.weight');
  }
  get loop(): Animation3DLoopMode { return this._loop; }
  set loop(value: Animation3DLoopMode) {
    this._assertValid();
    if (value !== 'once' && value !== 'repeat' && value !== 'ping-pong') {
      throw new RangeError(`Unsupported Animation3D loop mode "${String(value)}".`);
    }
    this._loop = value;
    this._setSampleTime(0);
  }
  get repetitions(): number { return this._repetitions; }
  set repetitions(value: number) {
    this._assertValid();
    this._repetitions = validateRepetitions(value);
  }
  get clampWhenFinished(): boolean { return this._clampWhenFinished; }
  set clampWhenFinished(value: boolean) {
    this._assertValid();
    this._clampWhenFinished = Boolean(value);
  }
  get blendMode(): Animation3DBlendMode { return this._blendMode; }
  set blendMode(value: Animation3DBlendMode) {
    this._assertValid();
    if (value !== 'override' && value !== 'additive') {
      throw new RangeError(`Unsupported Animation3D blend mode "${String(value)}".`);
    }
    this._blendMode = value;
  }
  get mask(): Animation3DBindingMask | null { return this._mask; }
  set mask(value: Animation3DBindingMask | null) {
    this._assertValid();
    this._mask = value;
  }

  get effectiveTimeScale(): number {
    if (!this._valid || this._paused || this._status !== 'running') return 0;
    return this._timeScale * this._warpFactor(this._owner.time);
  }

  get effectiveWeight(): number {
    if (!this._valid || !this._enabled || this._status === 'idle'
      || this._status === 'scheduled' || this._status === 'stopped'
      || (this._status === 'finished' && !this._clampWhenFinished)) return 0;
    return this._weight * this._fadeFactor(this._owner.time);
  }

  play(): this {
    this._assertValid();
    this._enabled = true;
    this._paused = false;
    this._status = this._startTime !== null && this._owner.time < this._startTime
      ? 'scheduled'
      : 'running';
    return this;
  }

  stop(): this {
    this._assertValid();
    this._enabled = false;
    this._paused = false;
    this._status = 'stopped';
    this._startTime = null;
    this._fadeActive = false;
    this._warpActive = false;
    return this;
  }

  reset(): this {
    this._assertValid();
    this._enabled = true;
    this._paused = false;
    this._status = 'idle';
    this._time = 0;
    this._rawTime = 0;
    this._startTime = null;
    this._eventsStarted = false;
    this._fadeActive = false;
    this._fadeValue = 1;
    this._warpActive = false;
    this._warpValue = 1;
    this._resetSamplerCursors();
    return this;
  }

  startAt(mixerTimeSeconds: number): this {
    this._assertValid();
    this._startTime = finiteNumber(mixerTimeSeconds, 'Animation3DAction.startAt');
    if (this._status === 'running' || this._status === 'scheduled') {
      this._status = this._owner.time < this._startTime ? 'scheduled' : 'running';
    }
    return this;
  }

  fadeIn(durationSeconds: number): this {
    this._assertValid();
    const duration = nonNegativeNumber(durationSeconds, 'Animation3DAction.fadeIn');
    this._fadeValue = 0;
    this._scheduleFade(0, 1, duration);
    return this;
  }

  fadeOut(durationSeconds: number): this {
    this._assertValid();
    const duration = nonNegativeNumber(durationSeconds, 'Animation3DAction.fadeOut');
    this._scheduleFade(this._fadeFactor(this._owner.time), 0, duration);
    return this;
  }

  crossFadeFrom(source: Animation3DAction, durationSeconds: number, warp = false): this {
    this._assertValid();
    const sourceRuntime = this._requireSibling(source);
    const duration = nonNegativeNumber(durationSeconds, 'Animation3DAction.crossFadeFrom');
    sourceRuntime.play().fadeOut(duration);
    this.play().fadeIn(duration);
    if (warp && sourceRuntime.clip.duration > 0 && this.clip.duration > 0) {
      sourceRuntime._scheduleWarp(1, sourceRuntime.clip.duration / this.clip.duration, duration);
      this._scheduleWarp(this.clip.duration / sourceRuntime.clip.duration, 1, duration);
    }
    return this;
  }

  crossFadeTo(destination: Animation3DAction, durationSeconds: number, warp = false): this {
    this._assertValid();
    const destinationRuntime = this._requireSibling(destination);
    destinationRuntime.crossFadeFrom(this, durationSeconds, warp);
    return this;
  }

  stopFading(): this {
    this._assertValid();
    if (this._fadeActive) this._fadeValue = this._fadeFactor(this._owner.time);
    this._fadeActive = false;
    return this;
  }

  acceptsBinding(binding: Animation3DBinding): boolean {
    const include = this._mask?.include;
    if (include && include.length > 0) {
      let found = false;
      for (let index = 0; index < include.length; index++) {
        if (include[index] === binding.id) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    const exclude = this._mask?.exclude;
    if (exclude) {
      for (let index = 0; index < exclude.length; index++) {
        if (exclude[index] === binding.id) return false;
      }
    }
    return true;
  }

  canContribute(): boolean {
    return this.effectiveWeight > 0;
  }

  /** @internal Allocated once by an integration handle and reused every frame. */
  createSynchronizedState(): Animation3DActionSynchronizedState {
    const state = {} as Animation3DActionSynchronizedState;
    this.captureSynchronizedState(state);
    return state;
  }

  /** @internal Captures every field changed by controller synchronization. */
  captureSynchronizedState(out: Animation3DActionSynchronizedState): void {
    this._assertValid();
    out.status = this._status;
    out.enabled = this._enabled;
    out.paused = this._paused;
    out.time = this._time;
    out.rawTime = this._rawTime;
    out.timeScale = this._timeScale;
    out.weight = this._weight;
    out.loop = this._loop;
    out.repetitions = this._repetitions;
    out.clampWhenFinished = this._clampWhenFinished;
    out.blendMode = this._blendMode;
    out.mask = this._mask;
    out.startTime = this._startTime;
    out.eventsStarted = this._eventsStarted;
    out.fadeActive = this._fadeActive;
    out.fadeStart = this._fadeStart;
    out.fadeEnd = this._fadeEnd;
    out.fadeFrom = this._fadeFrom;
    out.fadeTo = this._fadeTo;
    out.fadeValue = this._fadeValue;
    out.warpActive = this._warpActive;
    out.warpStart = this._warpStart;
    out.warpEnd = this._warpEnd;
    out.warpFrom = this._warpFrom;
    out.warpTo = this._warpTo;
    out.warpValue = this._warpValue;
  }

  /** @internal Restores event cursors as well as the sampled playhead. */
  restoreSynchronizedState(state: Animation3DActionSynchronizedState): void {
    this._assertValid();
    this._status = state.status;
    this._enabled = state.enabled;
    this._paused = state.paused;
    this._time = state.time;
    this._rawTime = state.rawTime;
    this._timeScale = state.timeScale;
    this._weight = state.weight;
    this._loop = state.loop;
    this._repetitions = state.repetitions;
    this._clampWhenFinished = state.clampWhenFinished;
    this._blendMode = state.blendMode;
    this._mask = state.mask;
    this._startTime = state.startTime;
    this._eventsStarted = state.eventsStarted;
    this._fadeActive = state.fadeActive;
    this._fadeStart = state.fadeStart;
    this._fadeEnd = state.fadeEnd;
    this._fadeFrom = state.fadeFrom;
    this._fadeTo = state.fadeTo;
    this._fadeValue = state.fadeValue;
    this._warpActive = state.warpActive;
    this._warpStart = state.warpStart;
    this._warpEnd = state.warpEnd;
    this._warpFrom = state.warpFrom;
    this._warpTo = state.warpTo;
    this._warpValue = state.warpValue;
    this._resetSamplerCursors();
  }

  /**
   * Sets an unwrapped controller-owned playhead without emitting events.
   * Integration adapters use this for initial destination offsets before play.
   */
  seekSynchronizedTime(timeSeconds: number): void {
    this._assertValid();
    this._rawTime = this._clampSynchronizedTime(timeSeconds);
    this._setSampleTime(0);
    this._eventsStarted = false;
    this._resetSamplerCursors();
  }

  /**
   * Moves to an absolute controller-owned playhead and emits every crossed
   * clip event exactly once. This does not advance the mixer clock.
   */
  synchronizeTime(timeSeconds: number, out: Animation3DMutablePose): void {
    this._assertValid();
    const after = this._clampSynchronizedTime(timeSeconds);
    const before = this._rawTime;
    const direction = after === before ? this._timeScale : after - before;
    if (!this._eventsStarted) {
      this._emitStartingEvents(direction, out);
      this._eventsStarted = true;
    }
    this._emitCrossedEvents(before, after, out);
    this._rawTime = after;
    this._setSampleTime(0);
  }

  advance(
    mixerDelta: number,
    previousMixerTime: number,
    currentMixerTime: number,
    out: Animation3DMutablePose,
  ): void {
    if (!this._valid) return;
    this._finishTransitions(currentMixerTime);
    if (!this._enabled || this._paused) return;

    let activeMixerDelta = mixerDelta;
    if (this._status === 'scheduled') {
      const startTime = this._startTime;
      if (startTime === null) {
        this._status = 'running';
      } else if (mixerDelta >= 0) {
        if (currentMixerTime < startTime) return;
        activeMixerDelta = currentMixerTime - Math.max(previousMixerTime, startTime);
        this._status = 'running';
        this._startTime = null;
      } else {
        if (currentMixerTime > startTime) return;
        activeMixerDelta = currentMixerTime - Math.min(previousMixerTime, startTime);
        this._status = 'running';
        this._startTime = null;
      }
    }
    if (this._status !== 'running') return;

    const actionDelta = activeMixerDelta * this._timeScale * this._warpFactor(currentMixerTime);
    if (actionDelta === 0 || this.clip.duration === 0) return;
    const before = this._rawTime;
    let after = before + actionDelta;
    let terminalDirection = 0;
    const totalDuration = this._loop === 'once'
      ? this.clip.duration
      : this._repetitions === Infinity
        ? Infinity
        : this.clip.duration * this._repetitions;

    if (totalDuration !== Infinity) {
      if (after >= totalDuration && actionDelta > 0) {
        after = totalDuration;
        terminalDirection = 1;
      } else if (after <= 0 && actionDelta < 0) {
        after = 0;
        terminalDirection = -1;
      }
    }

    if (!this._eventsStarted) {
      this._emitStartingEvents(actionDelta, out);
      this._eventsStarted = true;
    }
    this._emitCrossedEvents(before, after, out);
    this._rawTime = after;
    this._setSampleTime(terminalDirection);
    if (terminalDirection !== 0) {
      this._status = 'finished';
      if (!this._clampWhenFinished) this._enabled = false;
    }
  }

  invalidate(): void {
    if (!this._valid) return;
    this._valid = false;
    this._enabled = false;
    this._paused = false;
    this._status = 'stopped';
    this._startTime = null;
    this._fadeActive = false;
    this._warpActive = false;
  }

  private _clampSynchronizedTime(timeSeconds: number): number {
    const next = finiteNumber(timeSeconds, 'Animation3DAction synchronized time');
    if (this._loop === 'once') {
      return Math.min(this.clip.duration, Math.max(0, next));
    }
    if (this._repetitions === Infinity) return next;
    return Math.min(this.clip.duration * this._repetitions, Math.max(0, next));
  }

  private _setSampleTime(terminalDirection: number): void {
    const duration = this.clip.duration;
    if (duration === 0) {
      this._time = 0;
      return;
    }
    if (this._loop === 'once') {
      this._time = Math.min(duration, Math.max(0, this._rawTime));
      return;
    }
    if (terminalDirection > 0 && this._loop === 'repeat') {
      this._time = duration;
      return;
    }

    const traversal = Math.floor(this._rawTime / duration);
    let phase = this._rawTime - traversal * duration;
    if (phase < 0) phase += duration;
    if (this._loop === 'repeat') {
      this._time = phase;
      return;
    }
    this._time = isEven(traversal) ? phase : duration - phase;
  }

  private _emitCrossedEvents(
    before: number,
    after: number,
    out: Animation3DMutablePose,
  ): void {
    if (before === after || this._runtimeEvents.length === 0) return;
    if (this._loop === 'once') {
      this._emitOnceEvents(before, after, out);
    } else if (this._loop === 'repeat') {
      this._emitRepeatEvents(before, after, out);
    } else {
      this._emitPingPongEvents(before, after, out);
    }
  }

  private _emitStartingEvents(direction: number, out: Animation3DMutablePose): void {
    if (direction >= 0) {
      for (let index = 0; index < this._runtimeEvents.length; index++) {
        const runtimeEvent = this._runtimeEvents[index]!;
        if (runtimeEvent.event.time === this._time) out.emit(runtimeEvent.poseEvent);
      }
    } else {
      for (let index = this._runtimeEvents.length - 1; index >= 0; index--) {
        const runtimeEvent = this._runtimeEvents[index]!;
        if (runtimeEvent.event.time === this._time) out.emit(runtimeEvent.poseEvent);
      }
    }
  }

  private _emitOnceEvents(before: number, after: number, out: Animation3DMutablePose): void {
    if (after > before) {
      for (let index = 0; index < this._runtimeEvents.length; index++) {
        const runtimeEvent = this._runtimeEvents[index]!;
        if (runtimeEvent.event.time > before && runtimeEvent.event.time <= after) {
          out.emit(runtimeEvent.poseEvent);
        }
      }
    } else {
      for (let index = this._runtimeEvents.length - 1; index >= 0; index--) {
        const runtimeEvent = this._runtimeEvents[index]!;
        if (runtimeEvent.event.time < before && runtimeEvent.event.time >= after) {
          out.emit(runtimeEvent.poseEvent);
        }
      }
    }
  }

  private _emitRepeatEvents(before: number, after: number, out: Animation3DMutablePose): void {
    const duration = this.clip.duration;
    const minimum = Math.min(before, after);
    const maximum = Math.max(before, after);
    const firstCycle = Math.floor(minimum / duration) - 1;
    const lastCycle = Math.floor(maximum / duration) + 1;
    if (after > before) {
      for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
        const cycleStart = cycle * duration;
        for (let index = 0; index < this._runtimeEvents.length; index++) {
          const runtimeEvent = this._runtimeEvents[index]!;
          const occurrence = cycleStart + runtimeEvent.event.time;
          if (occurrence > before && occurrence <= after) out.emit(runtimeEvent.poseEvent);
        }
      }
    } else {
      for (let cycle = lastCycle; cycle >= firstCycle; cycle--) {
        const cycleStart = cycle * duration;
        for (let index = this._runtimeEvents.length - 1; index >= 0; index--) {
          const runtimeEvent = this._runtimeEvents[index]!;
          const occurrence = cycleStart + runtimeEvent.event.time;
          if (occurrence < before && occurrence >= after) out.emit(runtimeEvent.poseEvent);
        }
      }
    }
  }

  private _emitPingPongEvents(before: number, after: number, out: Animation3DMutablePose): void {
    const duration = this.clip.duration;
    const minimum = Math.min(before, after);
    const maximum = Math.max(before, after);
    const firstTraversal = Math.floor(minimum / duration) - 1;
    const lastTraversal = Math.floor(maximum / duration) + 1;
    if (after > before) {
      for (let traversal = firstTraversal; traversal <= lastTraversal; traversal++) {
        if (isEven(traversal)) {
          this._emitPingPongTraversal(traversal, before, after, true, true, out);
        } else {
          this._emitPingPongTraversal(traversal, before, after, false, true, out);
        }
      }
    } else {
      for (let traversal = lastTraversal; traversal >= firstTraversal; traversal--) {
        if (isEven(traversal)) {
          this._emitPingPongTraversal(traversal, before, after, false, false, out);
        } else {
          this._emitPingPongTraversal(traversal, before, after, true, false, out);
        }
      }
    }
  }

  private _emitPingPongTraversal(
    traversal: number,
    before: number,
    after: number,
    ascendingEvents: boolean,
    forwardRaw: boolean,
    out: Animation3DMutablePose,
  ): void {
    const duration = this.clip.duration;
    const even = isEven(traversal);
    let index = ascendingEvents ? 0 : this._runtimeEvents.length - 1;
    const end = ascendingEvents ? this._runtimeEvents.length : -1;
    const step = ascendingEvents ? 1 : -1;
    for (; index !== end; index += step) {
      const runtimeEvent = this._runtimeEvents[index]!;
      const eventTime = runtimeEvent.event.time;
      if ((even && eventTime === 0) || (!even && eventTime === duration)) continue;
      const occurrence = traversal * duration + (even ? eventTime : duration - eventTime);
      const crossed = forwardRaw
        ? occurrence > before && occurrence <= after
        : occurrence < before && occurrence >= after;
      if (crossed) out.emit(runtimeEvent.poseEvent);
    }
  }

  private _scheduleFade(from: number, to: number, duration: number): void {
    this._fadeFrom = from;
    this._fadeTo = to;
    this._fadeStart = this._owner.time;
    this._fadeEnd = this._fadeStart + duration;
    if (duration === 0) {
      this._fadeValue = to;
      this._fadeActive = false;
    } else {
      this._fadeValue = from;
      this._fadeActive = true;
    }
  }

  private _scheduleWarp(from: number, to: number, duration: number): void {
    this._warpFrom = from;
    this._warpTo = to;
    this._warpStart = this._owner.time;
    this._warpEnd = this._warpStart + duration;
    if (duration === 0) {
      this._warpValue = to;
      this._warpActive = false;
    } else {
      this._warpValue = from;
      this._warpActive = true;
    }
  }

  private _fadeFactor(time: number): number {
    if (!this._fadeActive) return this._fadeValue;
    if (time <= this._fadeStart) return this._fadeFrom;
    if (time >= this._fadeEnd) return this._fadeTo;
    const alpha = (time - this._fadeStart) / (this._fadeEnd - this._fadeStart);
    return this._fadeFrom + (this._fadeTo - this._fadeFrom) * alpha;
  }

  private _warpFactor(time: number): number {
    if (!this._warpActive) return this._warpValue;
    if (time <= this._warpStart) return this._warpFrom;
    if (time >= this._warpEnd) return this._warpTo;
    const alpha = (time - this._warpStart) / (this._warpEnd - this._warpStart);
    return this._warpFrom + (this._warpTo - this._warpFrom) * alpha;
  }

  private _finishTransitions(time: number): void {
    if (this._fadeActive && time >= this._fadeEnd) {
      this._fadeValue = this._fadeTo;
      this._fadeActive = false;
    }
    if (this._warpActive && time >= this._warpEnd) {
      this._warpValue = this._warpTo;
      this._warpActive = false;
    }
  }

  private _requireSibling(action: Animation3DAction): Animation3DActionRuntime {
    if (!(action instanceof Animation3DActionRuntime) || action._owner !== this._owner) {
      throw new RangeError('Animation3D cross-fade actions must belong to the same mixer.');
    }
    action._assertValid();
    return action;
  }

  private _resetSamplerCursors(): void {
    for (let index = 0; index < this.runtimeTracks.length; index++) {
      this.runtimeTracks[index]!.sampler.resetCursor();
    }
  }

  private _assertValid(): void {
    this._owner.assertActive();
    if (!this._valid) {
      throw new Animation3DError(
        'invalid-action',
        `Animation3D action "${this.id}" is no longer valid.`,
        { actionId: this.id },
      );
    }
  }
}

function validateClip(clip: Animation3DClip): void {
  const clipId = typeof clip?.id === 'string' ? clip.id : '';
  const fail = (message: string): never => {
    throw new Animation3DError('invalid-clip', message, { clipId });
  };
  if (!clip || typeof clip !== 'object') {
    fail('Animation3D clip must be an object.');
  }
  if (clip.format !== 'haiyue-animation3d-clip@1') {
    fail(`Unsupported Animation3D clip format "${String(clip.format)}".`);
  }
  if (clipId.trim().length === 0) {
    fail('Animation3D clip id must not be empty.');
  }
  if (typeof clip.name !== 'string') {
    fail(`Animation3D clip "${clipId}" name must be a string.`);
  }
  if (!Number.isFinite(clip.duration) || clip.duration < 0) {
    fail(`Animation3D clip duration must be finite and non-negative; received ${clip.duration}.`);
  }
  if (!Array.isArray(clip.tracks)) {
    fail(`Animation3D clip "${clipId}" tracks must be an array.`);
  }
  if (!Array.isArray(clip.events)) {
    fail(`Animation3D clip "${clipId}" events must be an array.`);
  }
  const trackIds = new Set<string>();
  for (let index = 0; index < clip.tracks.length; index++) {
    const track = clip.tracks[index]!;
    validateAnimation3DTrack(track, clip.duration);
    if (trackIds.has(track.id)) {
      fail(`Animation3D clip "${clipId}" contains duplicate track id "${track.id}".`);
    }
    trackIds.add(track.id);
  }
  const eventIds = new Set<string>();
  for (let index = 0; index < clip.events.length; index++) {
    const event = clip.events[index]!;
    if (!event || typeof event.id !== 'string' || event.id.trim().length === 0) {
      fail(`Animation3D clip "${clipId}" event ids must not be empty.`);
    }
    if (eventIds.has(event.id)) {
      fail(`Animation3D clip "${clipId}" contains duplicate event id "${event.id}".`);
    }
    eventIds.add(event.id);
    if (typeof event.name !== 'string') {
      fail(`Animation3D event "${event.id}" name must be a string.`);
    }
    if (!Number.isFinite(event.time) || event.time < 0 || event.time > clip.duration) {
      fail(`Animation3D event "${event.id}" must lie within its clip duration.`);
    }
  }
}

function validateRepetitions(value: number): number {
  if (value === Infinity) return value;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`Animation3DAction.repetitions must be a positive integer or Infinity; received ${value}.`);
  }
  return value;
}

function finiteNumber(value: number, property: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${property} must be finite; received ${value}.`);
  return value;
}

function nonNegativeNumber(value: number, property: string): number {
  const result = finiteNumber(value, property);
  if (result < 0) throw new RangeError(`${property} must be non-negative; received ${value}.`);
  return result;
}

function isEven(value: number): boolean {
  return Math.abs(value % 2) === 0;
}
