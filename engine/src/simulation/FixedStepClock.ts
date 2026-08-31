export interface FixedStepClockOptions {
  /** Simulation frequency. Defaults to 60 Hz. */
  tickRateHz?: number;
  /** Maximum ticks executed by one advance call. Backlog is retained, never discarded. */
  maxSubSteps?: number;
  /** Maximum whole ticks retained after the current catch-up batch. Defaults to four seconds. */
  maxBacklogTicks?: number;
}

export interface FixedStepTick {
  readonly tick: number;
  readonly timeMs: number;
  readonly deltaMs: number;
}

export interface FixedStepAdvanceResult {
  readonly ticks: number;
  readonly firstTick: number | null;
  readonly lastTick: number | null;
  readonly accumulatorMs: number;
  readonly backlogTicks: number;
  /** Clamped interpolation factor. A value of 1 means simulation catch-up is still pending. */
  readonly renderAlpha: number;
  /** Wall-clock time discarded by this advance after the bounded backlog filled. */
  readonly droppedMs: number;
  /** Total wall-clock time discarded since construction or reset. */
  readonly totalDroppedMs: number;
}

export type FixedStepCallback = (step: FixedStepTick) => void;

/**
 * A wall-clock independent simulation clock. Callers provide display-frame deltas;
 * simulation time is derived exclusively from the integer tick counter.
 */
export class FixedStepClock {
  readonly tickRateHz: number;
  readonly fixedDeltaMs: number;
  readonly maxSubSteps: number;
  readonly maxBacklogTicks: number;

  private _tick = 0;
  private _accumulatorMs = 0;
  private _paused = false;
  private _totalDroppedMs = 0;
  private _lastDroppedMs = 0;

  constructor(options: FixedStepClockOptions = {}) {
    this.tickRateHz = finiteRange(options.tickRateHz ?? 60, 1, 1_000, 'tickRateHz');
    this.fixedDeltaMs = 1_000 / this.tickRateHz;
    this.maxSubSteps = integerRange(options.maxSubSteps ?? 1_000, 1, 100_000, 'maxSubSteps');
    this.maxBacklogTicks = integerRange(options.maxBacklogTicks ?? Math.ceil(this.tickRateHz * 4), 0, 1_000_000, 'maxBacklogTicks');
  }

  get tick(): number { return this._tick; }
  get timeMs(): number { return this._tick * this.fixedDeltaMs; }
  get accumulatorMs(): number { return this._accumulatorMs; }
  get paused(): boolean { return this._paused; }
  get totalDroppedMs(): number { return this._totalDroppedMs; }
  get renderAlpha(): number { return Math.min(1, this._accumulatorMs / this.fixedDeltaMs); }

  pause(): this { this._paused = true; return this; }
  resume(): this { this._paused = false; return this; }

  reset(tick = 0): this {
    this._tick = integerRange(tick, 0, Number.MAX_SAFE_INTEGER, 'tick');
    this._accumulatorMs = 0;
    this._paused = false;
    this._totalDroppedMs = 0;
    this._lastDroppedMs = 0;
    return this;
  }

  /** Advance from a display cadence without observing wall-clock time. */
  advance(frameDeltaMs: number, callback: FixedStepCallback): FixedStepAdvanceResult {
    const delta = finiteRange(frameDeltaMs, 0, Number.MAX_SAFE_INTEGER, 'frameDeltaMs');
    this._lastDroppedMs = 0;
    if (this._paused || delta === 0) return this._result(0, null);
    this._accumulatorMs += delta;
    const maximumAccumulatorMs = (this.maxSubSteps + this.maxBacklogTicks) * this.fixedDeltaMs;
    if (this._accumulatorMs > maximumAccumulatorMs) {
      this._lastDroppedMs = this._accumulatorMs - maximumAccumulatorMs;
      this._totalDroppedMs += this._lastDroppedMs;
      this._accumulatorMs = maximumAccumulatorMs;
    }
    const available = Math.floor((this._accumulatorMs + this.fixedDeltaMs * 1e-9) / this.fixedDeltaMs);
    const count = Math.min(available, this.maxSubSteps);
    const firstTick = count > 0 ? this._tick + 1 : null;
    this._run(count, callback);
    this._accumulatorMs = Math.max(0, this._accumulatorMs - count * this.fixedDeltaMs);
    return this._result(count, firstTick);
  }

  /** Execute an exact number of ticks, normally while the display loop is paused. */
  step(count: number, callback: FixedStepCallback): FixedStepAdvanceResult {
    const normalized = integerRange(count, 1, this.maxSubSteps, 'count');
    const firstTick = this._tick + 1;
    this._lastDroppedMs = 0;
    this._run(normalized, callback);
    return this._result(normalized, firstTick);
  }

  private _run(count: number, callback: FixedStepCallback): void {
    for (let index = 0; index < count; index += 1) {
      this._tick += 1;
      callback(Object.freeze({ tick: this._tick, timeMs: this.timeMs, deltaMs: this.fixedDeltaMs }));
    }
  }

  private _result(ticks: number, firstTick: number | null): FixedStepAdvanceResult {
    return Object.freeze({
      ticks,
      firstTick,
      lastTick: ticks > 0 ? this._tick : null,
      accumulatorMs: this._accumulatorMs,
      backlogTicks: Math.floor((this._accumulatorMs + this.fixedDeltaMs * 1e-9) / this.fixedDeltaMs),
      renderAlpha: this.renderAlpha,
      droppedMs: this._lastDroppedMs,
      totalDroppedMs: this._totalDroppedMs,
    });
  }
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be a finite number from ${minimum} to ${maximum}.`);
  return value;
}

function integerRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
