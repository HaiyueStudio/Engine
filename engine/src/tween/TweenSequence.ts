import { Tween, type TweenOptions, type TweenTarget } from './Tween';
import { requiredItemAt } from '../math/arrayAccess';

export interface TweenSequenceOptions {
  group?: string;
  timeScale?: number;
  onComplete?: () => void;
}

export interface TweenSequenceStep {
  reset(): unknown;
  update(delta: number): boolean;
}

export class TweenSequence {
  group: string;
  timeScale: number;
  onComplete: (() => void) | undefined;

  private readonly _steps: TweenSequenceStep[] = [];
  private _cursor = 0;
  private _completed = false;
  private _paused = false;

  constructor(steps: readonly TweenSequenceStep[] = [], options: TweenSequenceOptions = {}) {
    this.group = options.group ?? 'default';
    this.timeScale = options.timeScale ?? 1;
    this.onComplete = options.onComplete;
    for (const step of steps) this.add(step);
  }

  add(step: TweenSequenceStep): this {
    this._steps.push(step);
    return this;
  }

  create<T extends TweenTarget>(target: T, options?: TweenOptions): Tween<T> {
    const tween = new Tween<T>(target, {
      group: this.group,
      ...options,
    });
    this.add(tween);
    return tween;
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
    this._cursor = 0;
    this._completed = false;
    this._paused = false;
    for (const step of this._steps) step.reset();
    return this;
  }

  get isCompleted(): boolean {
    return this._completed;
  }

  get isPlaying(): boolean {
    return !this._completed && !this._paused && this._cursor < this._steps.length;
  }

  get length(): number {
    return this._steps.length;
  }

  get currentIndex(): number {
    return this._cursor;
  }

  update(delta: number): boolean {
    if (this._completed || this._paused) return !this._completed;
    delta *= this.timeScale;
    if (delta <= 0) return true;

    while (this._cursor < this._steps.length) {
      const step = requiredItemAt(this._steps, this._cursor, 'TweenSequence steps');
      if (step.update(delta)) return true;
      this._cursor++;
      delta = 0;
    }

    this._completed = true;
    this.onComplete?.();
    return false;
  }
}
