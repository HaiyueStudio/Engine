import { EasingFunction, Easing } from './Easing';
import { interpolate } from './interpolators/index';
import { ColorSRGB } from '../color/ColorSRGB';

export type TweenRepeat = number | 'infinite';

export interface TweenOptions {
  duration?: number;
  delay?: number;
  easing?: EasingFunction;
  repeat?: TweenRepeat;
  yoyo?: boolean;
  group?: string;
  timeScale?: number;
  onStart?: () => void;
  onUpdate?: (target: Record<string, unknown>, progress: number) => void;
  onComplete?: () => void;
  onRepeat?: () => void;
}

export type TweenTarget = Record<string, unknown>;

export class Tween<T extends TweenTarget = TweenTarget> {
  target: T;
  duration: number;
  delay: number;
  easing: EasingFunction;
  repeat: TweenRepeat;
  yoyo: boolean;
  group: string;
  timeScale: number;

  onStart: (() => void) | undefined;
  onUpdate: ((target: T, progress: number) => void) | undefined;
  onComplete: (() => void) | undefined;
  onRepeat: (() => void) | undefined;

  private _fromValues: Partial<T> = {} as Partial<T>;
  private _toValues: Partial<T> = {} as Partial<T>;
  private _toValueKeys: Array<keyof T & string> = [];
  private _fromValueKeys: Array<keyof T & string> = [];
  private _interpolationScratch = new Map<string, unknown>();
  private _elapsed = 0;
  private _delayElapsed = 0;
  private _started = false;
  private _completed = false;
  private _paused = false;
  private _repeatCount = 0;
  private _reversed = false;

  constructor(target: T, options: TweenOptions = {}) {
    this.target = target;
    this.duration  = options.duration  ?? 1000;
    this.delay     = options.delay     ?? 0;
    this.easing    = options.easing    ?? Easing.linear;
    this.repeat    = options.repeat    ?? 0;
    this.yoyo      = options.yoyo      ?? false;
    this.group     = options.group     ?? 'default';
    this.timeScale = options.timeScale ?? 1;
    this.onStart   = options.onStart;
    this.onUpdate  = options.onUpdate;
    this.onComplete = options.onComplete;
    this.onRepeat  = options.onRepeat;
  }

  to(props: Partial<T>, duration?: number): this {
    this._toValues = { ...props };
    this._toValueKeys = Object.keys(this._toValues) as Array<keyof T & string>;
    this._interpolationScratch.clear();
    if (duration !== undefined) this.duration = duration;
    return this;
  }

  from(props: Partial<T>): this {
    this._fromValues = { ...props };
    this._fromValueKeys = Object.keys(this._fromValues) as Array<keyof T & string>;
    this._interpolationScratch.clear();
    return this;
  }

  setEasing(fn: EasingFunction): this {
    this.easing = fn;
    return this;
  }

  setGroup(group: string): this {
    this.group = group;
    return this;
  }

  setTimeScale(timeScale: number): this {
    this.timeScale = timeScale;
    return this;
  }

  pause(): this {
    this._paused = true;
    return this;
  }

  resume(): this {
    this._paused = false;
    return this;
  }

  stop(): this {
    this._completed = true;
    return this;
  }

  reset(): this {
    this._elapsed = 0;
    this._delayElapsed = 0;
    this._started = false;
    this._completed = false;
    this._repeatCount = 0;
    this._reversed = false;
    return this;
  }

  get isCompleted(): boolean {
    return this._completed;
  }

  get isPlaying(): boolean {
    return this._started && !this._paused && !this._completed;
  }

  /** Returns true while still active */
  update(delta: number): boolean {
    if (this._completed || this._paused) return !this._completed;
    delta *= this.timeScale;
    if (delta <= 0) return true;

    // Handle delay
    if (this._delayElapsed < this.delay) {
      this._delayElapsed += delta;
      return true;
    }

    // Capture start values on first real update
    if (!this._started) {
      this._started = true;
      for (const key of this._toValueKeys) {
        if (!(key in this._fromValues)) {
          (this._fromValues as Record<string, unknown>)[key] = this.target[key];
          this._fromValueKeys.push(key);
        }
      }
      // Apply from values to target
      for (const key of this._fromValueKeys) {
        this.target[key] = this._fromValues[key] as T[keyof T & string];
      }
      this.onStart?.();
    }

    this._elapsed += delta;
    const rawT = Math.min(this._elapsed / this.duration, 1);
    const easedT = this.easing(this._reversed ? 1 - rawT : rawT);

    for (const key of this._toValueKeys) {
      const from = this._fromValues[key];
      const to   = this._toValues[key];
      this.target[key] = interpolate(from, to, easedT, this._getInterpolationScratch(key, from, to)) as T[keyof T & string];
    }

    this.onUpdate?.(this.target, rawT);

    if (rawT >= 1) {
      // Completed one cycle
      const canRepeat =
        this.repeat === 'infinite' || this._repeatCount < (this.repeat as number);

      if (canRepeat) {
        this._repeatCount++;
        this._elapsed = 0;
        if (this.yoyo) this._reversed = !this._reversed;
        this.onRepeat?.();
      } else {
        this._completed = true;
        this.onComplete?.();
        return false;
      }
    }

    return true;
  }

  private _getInterpolationScratch(key: string, from: unknown, to: unknown): unknown {
    const cached = this._interpolationScratch.get(key);
    if (from instanceof Float32Array && to instanceof Float32Array) {
      if (cached instanceof Float32Array && cached.length === from.length) return cached;
      const next = new Float32Array(from.length);
      this._interpolationScratch.set(key, next);
      return next;
    }
    if (from instanceof ColorSRGB && to instanceof ColorSRGB) {
      if (cached instanceof ColorSRGB) return cached;
      const next = new ColorSRGB();
      this._interpolationScratch.set(key, next);
      return next;
    }
    return undefined;
  }
}
