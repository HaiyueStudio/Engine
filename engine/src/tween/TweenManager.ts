import { Tween, TweenOptions, TweenTarget } from './Tween';
import { TweenSequence, type TweenSequenceOptions, type TweenSequenceStep } from './TweenSequence';

export interface TweenRuntimeItem {
  group?: string;
  update(delta: number): boolean;
  pause?(): unknown;
  resume?(): unknown;
  stop?(): unknown;
}

export interface TweenGroupState {
  timeScale: number;
  paused: boolean;
}

/**
 * Manages tweens and tween sequences. Add `TweenSystem` to a World to update
 * the manager automatically, or call `update(time, delta)` manually.
 */
export class TweenManager {
  timeScale = 1;
  paused = false;

  private _items: Set<TweenRuntimeItem> = new Set();
  private _groups = new Map<string, TweenGroupState>();

  /** Create and register a new tween for the given target. */
  create<T extends TweenTarget>(target: T, options?: TweenOptions): Tween<T> {
    const tween = new Tween<T>(target, options);
    this._items.add(tween);
    return tween;
  }

  sequence(steps: readonly TweenSequenceStep[] = [], options?: TweenSequenceOptions): TweenSequence {
    const sequence = new TweenSequence(steps, options);
    this._items.add(sequence);
    return sequence;
  }

  /** Add an externally created Tween to this manager. */
  add(item: TweenRuntimeItem): this {
    this._items.add(item);
    return this;
  }

  remove(item: TweenRuntimeItem): this {
    this._items.delete(item);
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  setTimeScale(timeScale: number): this {
    this.timeScale = timeScale;
    return this;
  }

  setGroupTimeScale(group: string, timeScale: number): this {
    this._getGroupState(group).timeScale = timeScale;
    return this;
  }

  pauseGroup(group: string): this {
    this._getGroupState(group).paused = true;
    return this;
  }

  resumeGroup(group: string): this {
    this._getGroupState(group).paused = false;
    return this;
  }

  getGroupState(group: string): TweenGroupState {
    const state = this._getGroupState(group);
    return { timeScale: state.timeScale, paused: state.paused };
  }

  update(_time: number, delta: number): void {
    if (this.paused || delta <= 0 || this.timeScale <= 0) return;
    const managerDelta = delta * this.timeScale;
    for (const item of this._items) {
      const groupState = this._groups.get(item.group ?? 'default');
      if (groupState?.paused || groupState?.timeScale === 0) continue;
      const groupDelta = managerDelta * (groupState?.timeScale ?? 1);
      const alive = item.update(groupDelta);
      if (!alive) this._items.delete(item);
    }
  }

  clear(): void {
    this._items.clear();
  }

  get count(): number {
    return this._items.size;
  }

  private _getGroupState(group: string): TweenGroupState {
    let state = this._groups.get(group);
    if (!state) {
      state = { timeScale: 1, paused: false };
      this._groups.set(group, state);
    }
    return state;
  }
}
