import type {
  Animation2DActionOptions,
  Animation2DActionStatus,
  Animation2DBinding,
  Animation2DBindingMask,
  Animation2DBlendMode,
  Animation2DClip,
  Animation2DEffectCue,
  Animation2DEffectEvent,
  Animation2DEffectLifecycle,
  Animation2DLoopMode,
  Animation2DMutablePose,
  Animation2DTrack,
} from './Types.js';
import { Animation2DSampler, isNumericBinding } from './Sampler.js';

export interface Animation2DActionOwner {
  readonly time: number;
  assertActive(): void;
}

export interface Animation2DActionTrackRuntime {
  readonly track: Animation2DTrack;
  readonly sampler: Animation2DSampler;
  readonly reference: Float32Array;
}

interface RuntimeEffect {
  readonly cue: Animation2DEffectCue;
  readonly start: number;
  readonly end: number;
  readonly fullSpan: boolean;
  readonly loopBehavior: 'continue' | 'restart';
  readonly enterEvent: Animation2DEffectEvent;
  readonly exitEvent: Animation2DEffectEvent;
  readonly restartEvent: Animation2DEffectEvent;
  readonly loopEvent: Animation2DEffectEvent;
  readonly seekEvent: Animation2DEffectEvent;
}

interface EffectOutput {
  emit(effect: Animation2DEffectEvent): void;
}

/** @internal Reusable exact state used by controller-owned transactions. */
export interface Animation2DActionSynchronizedState {
  status: Animation2DActionStatus;
  paused: boolean;
  time: number;
  rawTime: number;
  timeScale: number;
  weight: number;
  loop: Animation2DLoopMode;
  repetitions: number;
  clampWhenFinished: boolean;
  blendMode: Animation2DBlendMode;
  mask: Animation2DBindingMask | null;
  layer: number;
  effectsStarted: boolean;
  fadeActive: boolean;
  fadeStart: number;
  fadeEnd: number;
  fadeFrom: number;
  fadeTo: number;
  fadeValue: number;
  readonly effectActive: Uint8Array;
  readonly pendingEffects: Animation2DEffectEvent[];
}

/**
 * Mutable mixer-owned playback state. Effect lifecycle records and sampler
 * outputs are allocated at construction and reused on every frame.
 */
export class Animation2DActionRuntime {
  readonly id: string;
  readonly clip: Animation2DClip;
  readonly order: number;
  readonly runtimeTracks: readonly Animation2DActionTrackRuntime[];
  readonly runtimeEffects: readonly RuntimeEffect[];

  private readonly _owner: Animation2DActionOwner;
  private readonly _effectActive: Uint8Array;
  private readonly _pendingEffects: Animation2DEffectEvent[] = [];
  private readonly _pendingEffectOutput: EffectOutput = {
    emit: effect => { this._pendingEffects.push(effect); },
  };
  private _valid = true;
  private _status: Animation2DActionStatus = 'idle';
  private _paused = false;
  private _time = 0;
  private _rawTime = 0;
  private _timeScale: number;
  private _weight: number;
  private _loop: Animation2DLoopMode;
  private _repetitions: number;
  private _clampWhenFinished: boolean;
  private _blendMode: Animation2DBlendMode;
  private _mask: Animation2DBindingMask | null;
  private _layer: number;
  private _effectsStarted = false;

  private _fadeActive = false;
  private _fadeStart = 0;
  private _fadeEnd = 0;
  private _fadeFrom = 1;
  private _fadeTo = 1;
  private _fadeValue = 1;

  constructor(
    owner: Animation2DActionOwner,
    clip: Animation2DClip,
    id: string,
    order: number,
    options: Animation2DActionOptions = {},
  ) {
    validateClip(clip);
    this._owner = owner;
    this.clip = clip;
    this.id = id;
    this.order = order;
    this._loop = options.loop ?? 'once';
    this._repetitions = validateRepetitions(
      options.repetitions ?? (this._loop === 'once' ? 1 : Infinity),
    );
    this._clampWhenFinished = options.clampWhenFinished ?? false;
    this._timeScale = finiteNumber(options.timeScale ?? 1, 'Animation2DAction.timeScale');
    this._weight = nonNegativeNumber(options.weight ?? 1, 'Animation2DAction.weight');
    this._fadeValue = this._weight;
    this._layer = integerNumber(options.layer ?? 0, 'Animation2DAction.layer');
    this._blendMode = options.blendMode ?? 'override';
    this._mask = options.mask ?? null;

    const tracks: Animation2DActionTrackRuntime[] = [];
    for (let index = 0; index < clip.tracks.length; index++) {
      const track = clip.tracks[index]!;
      const sampler = new Animation2DSampler(track);
      const reference = isNumericBinding(track.binding)
        ? new Float32Array(track.binding.valueSize!)
        : new Float32Array(0);
      if (reference.length > 0) sampler.sample(0, reference);
      tracks.push({ track, sampler, reference });
    }
    this.runtimeTracks = tracks;

    const effects: RuntimeEffect[] = [];
    const sourceEffects = clip.effects ?? [];
    for (let index = 0; index < sourceEffects.length; index++) {
      const cue = sourceEffects[index]!;
      const start = cue.start;
      const end = cue.end ?? clip.duration;
      validateEffect(cue, start, end, clip.duration);
      effects.push({
        cue,
        start,
        end,
        fullSpan: start === 0 && end === clip.duration,
        loopBehavior: cue.loopBehavior ?? (cue.kind === 'particle' ? 'restart' : 'continue'),
        enterEvent: effectEvent(id, clip.id, cue, 'enter'),
        exitEvent: effectEvent(id, clip.id, cue, 'exit'),
        restartEvent: effectEvent(id, clip.id, cue, 'restart'),
        loopEvent: effectEvent(id, clip.id, cue, 'loop'),
        seekEvent: effectEvent(id, clip.id, cue, 'seek'),
      });
    }
    this.runtimeEffects = effects;
    this._effectActive = new Uint8Array(effects.length);
  }

  get duration(): number { return this.clip.duration; }
  get status(): Animation2DActionStatus { return this._status; }
  get paused(): boolean { return this._paused; }
  set paused(value: boolean) {
    this._assertValid();
    this._paused = Boolean(value);
    if (this._paused && this._status === 'running') this._status = 'paused';
    else if (!this._paused && this._status === 'paused') this._status = 'running';
  }
  get time(): number { return this._time; }
  set time(value: number) { this.seek(value); }
  get timeScale(): number { return this._timeScale; }
  set timeScale(value: number) {
    this._assertValid();
    this._timeScale = finiteNumber(value, 'Animation2DAction.timeScale');
  }
  get weight(): number { return this._weight; }
  set weight(value: number) {
    this._assertValid();
    this._weight = nonNegativeNumber(value, 'Animation2DAction.weight');
    this._fadeActive = false;
    this._fadeValue = this._weight;
  }
  get layer(): number { return this._layer; }
  set layer(value: number) {
    this._assertValid();
    this._layer = integerNumber(value, 'Animation2DAction.layer');
  }
  get loop(): Animation2DLoopMode { return this._loop; }
  set loop(value: Animation2DLoopMode) {
    this._assertValid();
    if (value !== 'once' && value !== 'repeat' && value !== 'ping-pong') {
      throw new RangeError(`Unsupported Animation2D loop mode "${String(value)}".`);
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
  get blendMode(): Animation2DBlendMode { return this._blendMode; }
  set blendMode(value: Animation2DBlendMode) {
    this._assertValid();
    if (value !== 'override' && value !== 'additive') {
      throw new RangeError(`Unsupported Animation2D blend mode "${String(value)}".`);
    }
    this._blendMode = value;
  }
  get mask(): Animation2DBindingMask | null { return this._mask; }
  set mask(value: Animation2DBindingMask | null) {
    this._assertValid();
    this._mask = value;
  }
  get effectiveWeight(): number {
    if (!this._valid || this._paused || (this._status !== 'running'
      && !(this._status === 'finished' && this._clampWhenFinished))) return 0;
    return this._fadeFactor(this._owner.time);
  }

  play(): this {
    this._assertValid();
    if (this._status === 'finished' && !this._clampWhenFinished) {
      this._rawTime = this._timeScale < 0 ? this.clip.duration : 0;
      this._setSampleTime(0);
      this._effectsStarted = false;
    }
    this._paused = false;
    this._status = 'running';
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  stop(): this {
    this._assertValid();
    this._queueActiveExits();
    this._paused = false;
    this._status = 'stopped';
    this._effectsStarted = false;
    return this;
  }

  reset(): this {
    this._assertValid();
    this._queueActiveExits();
    this._paused = false;
    this._status = 'idle';
    this._rawTime = 0;
    this._time = 0;
    this._effectsStarted = false;
    this._fadeActive = false;
    this._fadeValue = this._weight;
    this._resetSamplerCursors();
    return this;
  }

  seek(timeSeconds: number): this {
    this._assertValid();
    const next = Math.min(
      this.clip.duration,
      Math.max(0, finiteNumber(timeSeconds, 'Animation2DAction.time')),
    );
    for (let index = 0; index < this.runtimeEffects.length; index++) {
      const wasActive = this._effectActive[index] !== 0;
      const active = effectActiveAt(this.runtimeEffects[index]!, next, this.clip.duration);
      const effect = this.runtimeEffects[index]!;
      if (wasActive && !active) this._pendingEffects.push(effect.exitEvent);
      this._pendingEffects.push(effect.seekEvent);
      if (!wasActive && active) this._pendingEffects.push(effect.enterEvent);
      this._effectActive[index] = active ? 1 : 0;
    }
    this._rawTime = next;
    this._time = next;
    this._effectsStarted = true;
    this._resetSamplerCursors();
    return this;
  }

  /**
   * Advances a controller-owned absolute playhead without classifying the
   * move as a seek. Crossed side-effect boundaries are queued exactly once.
   */
  synchronizeTime(timeSeconds: number): this {
    this._assertValid();
    const after = this._clampSynchronizedTime(timeSeconds);
    const terminalDirection = this._terminalDirection(after);
    if (!this._effectsStarted) {
      this._emitInitialEffects(this._pendingEffectOutput);
      this._effectsStarted = true;
    }
    this._emitEffectCrossings(
      this._rawTime,
      after,
      this._pendingEffectOutput,
      terminalDirection,
    );
    this._rawTime = after;
    this._setSampleTime(terminalDirection);
    this._syncEffectActivity(terminalDirection);
    this._resetSamplerCursors();
    return this;
  }

  reverse(): this {
    this._assertValid();
    this._timeScale = -Math.max(Number.EPSILON, Math.abs(this._timeScale));
    return this;
  }

  fadeTo(targetWeight: number, durationSeconds: number): this {
    this._assertValid();
    const target = nonNegativeNumber(targetWeight, 'Animation2DAction.fade target');
    const duration = nonNegativeNumber(durationSeconds, 'Animation2DAction.fade duration');
    this._scheduleFade(this._fadeFactor(this._owner.time), target, duration);
    return this;
  }

  fadeIn(durationSeconds: number): this {
    this._assertValid();
    const duration = nonNegativeNumber(durationSeconds, 'Animation2DAction.fade duration');
    this._scheduleFade(0, this._weight > 0 ? this._weight : 1, duration);
    return this;
  }

  fadeOut(durationSeconds: number): this {
    return this.fadeTo(0, durationSeconds);
  }

  crossFadeFrom(source: Animation2DActionRuntime, durationSeconds: number): this {
    this._assertSibling(source);
    source.play().fadeOut(durationSeconds);
    this.play().fadeIn(durationSeconds);
    return this;
  }

  crossFadeTo(destination: Animation2DActionRuntime, durationSeconds: number): this {
    this._assertSibling(destination);
    destination.crossFadeFrom(this, durationSeconds);
    return this;
  }

  acceptsBinding(binding: Animation2DBinding): boolean {
    const include = this._mask?.include;
    if (include && include.length > 0) {
      let accepted = false;
      for (let index = 0; index < include.length; index++) {
        if (include[index] === binding.id) {
          accepted = true;
          break;
        }
      }
      if (!accepted) return false;
    }
    const exclude = this._mask?.exclude;
    if (exclude) {
      for (let index = 0; index < exclude.length; index++) {
        if (exclude[index] === binding.id) return false;
      }
    }
    return true;
  }

  flushPendingEffects(out: Animation2DMutablePose): void {
    for (let index = 0; index < this._pendingEffects.length; index++) {
      out.emit(this._pendingEffects[index]!);
    }
    this._pendingEffects.length = 0;
  }

  advance(mixerDelta: number, out: Animation2DMutablePose): void {
    if (!this._valid) return;
    this._finishFade(this._owner.time);
    this.flushPendingEffects(out);
    if (this._paused || this._status !== 'running') return;
    if (!this._effectsStarted) {
      this._emitInitialEffects(out);
      this._effectsStarted = true;
    }
    const actionDelta = mixerDelta * this._timeScale;
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
      if (actionDelta > 0 && after >= totalDuration) {
        after = totalDuration;
        terminalDirection = 1;
      } else if (actionDelta < 0 && after <= 0) {
        after = 0;
        terminalDirection = -1;
      }
    }

    this._emitEffectCrossings(before, after, out, terminalDirection);
    this._rawTime = after;
    this._setSampleTime(terminalDirection);
    this._syncEffectActivity(terminalDirection);
    if (terminalDirection !== 0) {
      this._status = 'finished';
      if (!this._clampWhenFinished) this._queueActiveExits();
    }
  }

  /** @internal Allocates one checkpoint that can be reused for every update. */
  createSynchronizedState(): Animation2DActionSynchronizedState {
    return {
      status: this._status,
      paused: this._paused,
      time: this._time,
      rawTime: this._rawTime,
      timeScale: this._timeScale,
      weight: this._weight,
      loop: this._loop,
      repetitions: this._repetitions,
      clampWhenFinished: this._clampWhenFinished,
      blendMode: this._blendMode,
      mask: this._mask,
      layer: this._layer,
      effectsStarted: this._effectsStarted,
      fadeActive: this._fadeActive,
      fadeStart: this._fadeStart,
      fadeEnd: this._fadeEnd,
      fadeFrom: this._fadeFrom,
      fadeTo: this._fadeTo,
      fadeValue: this._fadeValue,
      effectActive: new Uint8Array(this._effectActive.length),
      pendingEffects: [],
    };
  }

  /** @internal Captures playhead, fade, and effect-cursor state without sampling. */
  captureSynchronizedState(state: Animation2DActionSynchronizedState): void {
    this._assertValid();
    if (state.effectActive.length !== this._effectActive.length) {
      throw new RangeError('Animation2D action checkpoint has an incompatible effect count.');
    }
    state.status = this._status;
    state.paused = this._paused;
    state.time = this._time;
    state.rawTime = this._rawTime;
    state.timeScale = this._timeScale;
    state.weight = this._weight;
    state.loop = this._loop;
    state.repetitions = this._repetitions;
    state.clampWhenFinished = this._clampWhenFinished;
    state.blendMode = this._blendMode;
    state.mask = this._mask;
    state.layer = this._layer;
    state.effectsStarted = this._effectsStarted;
    state.fadeActive = this._fadeActive;
    state.fadeStart = this._fadeStart;
    state.fadeEnd = this._fadeEnd;
    state.fadeFrom = this._fadeFrom;
    state.fadeTo = this._fadeTo;
    state.fadeValue = this._fadeValue;
    state.effectActive.set(this._effectActive);
    state.pendingEffects.length = 0;
    for (const effect of this._pendingEffects) state.pendingEffects.push(effect);
  }

  /** @internal Restores an exact controller transaction checkpoint. */
  restoreSynchronizedState(state: Animation2DActionSynchronizedState): void {
    this._assertValid();
    if (state.effectActive.length !== this._effectActive.length) {
      throw new RangeError('Animation2D action checkpoint has an incompatible effect count.');
    }
    this._status = state.status;
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
    this._layer = state.layer;
    this._effectsStarted = state.effectsStarted;
    this._fadeActive = state.fadeActive;
    this._fadeStart = state.fadeStart;
    this._fadeEnd = state.fadeEnd;
    this._fadeFrom = state.fadeFrom;
    this._fadeTo = state.fadeTo;
    this._fadeValue = state.fadeValue;
    this._effectActive.set(state.effectActive);
    this._pendingEffects.length = 0;
    for (const effect of state.pendingEffects) this._pendingEffects.push(effect);
    this._resetSamplerCursors();
  }

  invalidate(): void {
    if (!this._valid) return;
    this._valid = false;
    this._status = 'stopped';
    this._paused = false;
    this._fadeActive = false;
    this._pendingEffects.length = 0;
    this._effectActive.fill(0);
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
    } else {
      this._time = isEven(traversal) ? phase : duration - phase;
    }
  }

  private _emitInitialEffects(out: EffectOutput): void {
    for (let index = 0; index < this.runtimeEffects.length; index++) {
      const active = effectActiveAt(this.runtimeEffects[index]!, this._time, this.clip.duration);
      this._effectActive[index] = active ? 1 : 0;
      if (active) out.emit(this.runtimeEffects[index]!.enterEvent);
    }
  }

  private _emitEffectCrossings(
    before: number,
    after: number,
    out: EffectOutput,
    terminalDirection = 0,
  ): void {
    if (before === after || this.runtimeEffects.length === 0) return;
    if (this._loop === 'repeat') {
      this._emitRepeatEffectCrossings(before, after, out, terminalDirection);
      return;
    }
    if (this._loop === 'once') {
      this._emitOnceEffectCrossings(before, after, out);
      return;
    }
    this._emitPingPongEffectCrossings(before, after, out, terminalDirection);
  }

  private _emitOnceEffectCrossings(
    before: number,
    after: number,
    out: EffectOutput,
  ): void {
    for (let index = 0; index < this.runtimeEffects.length; index++) {
      const effect = this.runtimeEffects[index]!;
      if (after > before) {
        if (effect.start > before && effect.start <= after) out.emit(effect.enterEvent);
        if (effect.end > before && effect.end <= after) out.emit(effect.exitEvent);
      } else {
        if (effect.end < before && effect.end >= after) out.emit(effect.enterEvent);
        if (effect.start < before && effect.start >= after) out.emit(effect.exitEvent);
      }
    }
  }

  private _emitRepeatEffectCrossings(
    before: number,
    after: number,
    out: EffectOutput,
    terminalDirection: number,
  ): void {
    const duration = this.clip.duration;
    const minimum = Math.min(before, after);
    const maximum = Math.max(before, after);
    const firstCycle = Math.floor(minimum / duration) - 1;
    const lastCycle = Math.floor(maximum / duration) + 1;
    for (let effectIndex = 0; effectIndex < this.runtimeEffects.length; effectIndex++) {
      const effect = this.runtimeEffects[effectIndex]!;
      if (effect.fullSpan) {
        if (after > before) {
          for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
            const boundary = cycle * duration;
            if (boundary > before && boundary <= after) {
              if (terminalDirection > 0 && boundary === after) out.emit(effect.exitEvent);
              else this._emitLoopEffect(effect, out);
            }
          }
        } else {
          for (let cycle = lastCycle; cycle >= firstCycle; cycle--) {
            const boundary = cycle * duration;
            if (boundary < before && boundary >= after) {
              if (terminalDirection < 0 && boundary === after) out.emit(effect.exitEvent);
              else this._emitLoopEffect(effect, out);
            }
          }
        }
        continue;
      }
      if (after > before) {
        for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
          const cycleStart = cycle * duration;
          const enter = cycleStart + effect.start;
          const exit = cycleStart + effect.end;
          if (enter > before && enter <= after
            && !(terminalDirection > 0 && enter === after)) out.emit(effect.enterEvent);
          if (exit > before && exit <= after) out.emit(effect.exitEvent);
        }
      } else {
        for (let cycle = lastCycle; cycle >= firstCycle; cycle--) {
          const cycleStart = cycle * duration;
          const enter = cycleStart + effect.end;
          const exit = cycleStart + effect.start;
          if (enter < before && enter >= after
            && !(terminalDirection < 0 && enter === after)) out.emit(effect.enterEvent);
          if (exit < before && exit >= after) out.emit(effect.exitEvent);
        }
      }
    }
  }

  private _emitPingPongEffectCrossings(
    before: number,
    after: number,
    out: EffectOutput,
    terminalDirection: number,
  ): void {
    const duration = this.clip.duration;
    const minimum = Math.min(before, after);
    const maximum = Math.max(before, after);
    const firstTraversal = Math.floor(minimum / duration) - 1;
    const lastTraversal = Math.floor(maximum / duration) + 1;
    for (let effectIndex = 0; effectIndex < this.runtimeEffects.length; effectIndex++) {
      const effect = this.runtimeEffects[effectIndex]!;
      if (effect.fullSpan) {
        if (after > before) {
          for (let traversal = firstTraversal; traversal <= lastTraversal; traversal++) {
            const boundary = traversal * duration;
            if (boundary <= before || boundary > after) continue;
            if (terminalDirection > 0 && boundary === after) out.emit(effect.exitEvent);
            else this._emitLoopEffect(effect, out);
          }
        } else {
          for (let traversal = lastTraversal; traversal >= firstTraversal; traversal--) {
            const boundary = traversal * duration;
            if (boundary >= before || boundary < after) continue;
            if (terminalDirection < 0 && boundary === after) out.emit(effect.exitEvent);
            else this._emitLoopEffect(effect, out);
          }
        }
        continue;
      }

      if (after > before) {
        for (let traversal = firstTraversal; traversal <= lastTraversal; traversal++) {
          const traversalStart = traversal * duration;
          const forward = isEven(traversal);
          const enter = traversalStart + (forward ? effect.start : duration - effect.end);
          const exit = traversalStart + (forward ? effect.end : duration - effect.start);
          if (enter > before && enter <= after
            && !(terminalDirection > 0 && enter === after)) out.emit(effect.enterEvent);
          if (exit > before && exit <= after) out.emit(effect.exitEvent);
        }
      } else {
        for (let traversal = lastTraversal; traversal >= firstTraversal; traversal--) {
          const traversalStart = traversal * duration;
          const forward = isEven(traversal);
          const forwardEnter = traversalStart
            + (forward ? effect.start : duration - effect.end);
          const forwardExit = traversalStart
            + (forward ? effect.end : duration - effect.start);
          if (forwardExit < before && forwardExit >= after
            && !(terminalDirection < 0 && forwardExit === after)) out.emit(effect.enterEvent);
          if (forwardEnter < before && forwardEnter >= after) out.emit(effect.exitEvent);
        }
      }
    }
  }

  private _emitLoopEffect(effect: RuntimeEffect, out: EffectOutput): void {
    out.emit(effect.loopBehavior === 'restart' ? effect.restartEvent : effect.loopEvent);
  }

  private _syncEffectActivity(terminalDirection = 0): void {
    for (let index = 0; index < this.runtimeEffects.length; index++) {
      const effect = this.runtimeEffects[index]!;
      const active = effect.fullSpan && this._loop === 'ping-pong'
        ? terminalDirection === 0
        : effectActiveAt(effect, this._time, this.clip.duration);
      this._effectActive[index] = active ? 1 : 0;
    }
  }

  private _queueActiveExits(): void {
    for (let index = 0; index < this._effectActive.length; index++) {
      if (this._effectActive[index] === 0) continue;
      this._pendingEffects.push(this.runtimeEffects[index]!.exitEvent);
      this._effectActive[index] = 0;
    }
  }

  private _scheduleFade(from: number, to: number, duration: number): void {
    this._fadeFrom = from;
    this._fadeTo = to;
    this._fadeStart = this._owner.time;
    this._fadeEnd = this._fadeStart + duration;
    if (duration === 0) {
      this._weight = to;
      this._fadeValue = to;
      this._fadeActive = false;
    } else {
      this._fadeValue = from;
      this._fadeActive = true;
    }
  }

  private _fadeFactor(time: number): number {
    if (!this._fadeActive) return this._fadeValue;
    if (time <= this._fadeStart) return this._fadeFrom;
    if (time >= this._fadeEnd) return this._fadeTo;
    const alpha = (time - this._fadeStart) / (this._fadeEnd - this._fadeStart);
    return this._fadeFrom + (this._fadeTo - this._fadeFrom) * alpha;
  }

  private _finishFade(time: number): void {
    if (!this._fadeActive || time < this._fadeEnd) return;
    this._weight = this._fadeTo;
    this._fadeValue = this._fadeTo;
    this._fadeActive = false;
  }

  private _assertSibling(action: Animation2DActionRuntime): void {
    this._assertValid();
    if (action._owner !== this._owner || !action._valid) {
      throw new RangeError('Animation2D cross-fade actions must belong to the same active mixer.');
    }
  }

  private _clampSynchronizedTime(timeSeconds: number): number {
    const next = finiteNumber(timeSeconds, 'Animation2DAction synchronized time');
    if (this._loop === 'once') return Math.min(this.clip.duration, Math.max(0, next));
    if (this._repetitions === Infinity) return next;
    return Math.min(this.clip.duration * this._repetitions, Math.max(0, next));
  }

  private _terminalDirection(time: number): number {
    if (this._loop === 'once') {
      if (time === this.clip.duration && this._rawTime < time) return 1;
      if (time === 0 && this._rawTime > time) return -1;
      return 0;
    }
    if (this._repetitions === Infinity) return 0;
    const totalDuration = this.clip.duration * this._repetitions;
    if (time === totalDuration && this._rawTime < time) return 1;
    if (time === 0 && this._rawTime > time) return -1;
    return 0;
  }

  private _resetSamplerCursors(): void {
    for (let index = 0; index < this.runtimeTracks.length; index++) {
      this.runtimeTracks[index]!.sampler.resetCursor();
    }
  }

  private _assertValid(): void {
    this._owner.assertActive();
    if (!this._valid) throw new Error(`Animation2D action "${this.id}" is no longer valid.`);
  }
}

function effectEvent(
  actionId: string,
  clipId: string,
  cue: Animation2DEffectCue,
  lifecycle: Animation2DEffectLifecycle,
): Animation2DEffectEvent {
  return { actionId, clipId, cue, lifecycle };
}

function effectActiveAt(effect: RuntimeEffect, time: number, duration: number): boolean {
  if (effect.fullSpan) return time >= 0 && time < duration;
  return time >= effect.start && time < effect.end;
}

function samplePingPongTime(rawTime: number, duration: number): number {
  if (duration <= 0) return 0;
  const traversal = Math.floor(rawTime / duration);
  let phase = rawTime - traversal * duration;
  if (phase < 0) phase += duration;
  return isEven(traversal) ? phase : duration - phase;
}

function validateClip(clip: Animation2DClip): void {
  if (clip.format !== 'haiyue-animation2d-clip@1') {
    throw new RangeError(`Unsupported Animation2D clip format "${String(clip.format)}".`);
  }
  if (!clip.id) throw new RangeError('Animation2D clip id must not be empty.');
  if (!Number.isFinite(clip.duration) || clip.duration < 0) {
    throw new RangeError(`Animation2D clip duration must be finite and non-negative; received ${clip.duration}.`);
  }
  for (let index = 0; index < clip.tracks.length; index++) {
    const track = clip.tracks[index]!;
    const first = track.times[0];
    const last = track.times[track.times.length - 1];
    if (first !== undefined && (first < 0 || last! > clip.duration)) {
      throw new RangeError(`Animation2D track "${track.id}" keys must lie within its clip.`);
    }
  }
}

function validateEffect(
  cue: Animation2DEffectCue,
  start: number,
  end: number,
  duration: number,
): void {
  if (!cue.id) throw new RangeError('Animation2D effect cue id must not be empty.');
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || start < 0 || end < start || end > duration) {
    throw new RangeError(`Animation2D effect "${cue.id}" interval must lie within its clip.`);
  }
}

function validateRepetitions(value: number): number {
  if (value === Infinity) return value;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`Animation2D repetitions must be a positive integer or Infinity; received ${value}.`);
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

function integerNumber(value: number, property: string): number {
  if (!Number.isInteger(value)) throw new RangeError(`${property} must be an integer; received ${value}.`);
  return value;
}

function isEven(value: number): boolean {
  return Math.abs(value % 2) === 0;
}
