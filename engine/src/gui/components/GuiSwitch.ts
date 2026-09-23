import { GuiCheckbox, GuiCheckboxOptions } from './GuiCheckbox';
import { GuiDirtyFlags } from '../GuiTypes';

export interface GuiSwitchOptions extends GuiCheckboxOptions {
  /** Thumb movement duration in milliseconds. Defaults to 0 (instant). */
  thumbTransitionMs?: number;
  /** Track color transition duration in milliseconds. Defaults to 0 (instant). */
  colorTransitionMs?: number;
}

export class GuiSwitch extends GuiCheckbox {
  thumbTransitionMs: number;
  colorTransitionMs: number;
  private target: number;
  private thumbFrom: number;
  private colorFrom: number;
  private elapsed = 0;
  constructor(options: GuiSwitchOptions = {}) {
    super({ width: 48, height: 28, ...options });
    this.thumbTransitionMs = options.thumbTransitionMs ?? 0;
    this.colorTransitionMs = options.colorTransitionMs ?? 0;
    this.target = this.thumbFrom = this.colorFrom = this.checked ? 1 : 0;
  }
  get thumbProgress(): number {
    this.syncTarget();
    return this.sample(this.thumbFrom, this.thumbTransitionMs);
  }
  get colorProgress(): number {
    this.syncTarget();
    return this.sample(this.colorFrom, this.colorTransitionMs);
  }
  get animating(): boolean {
    return this.thumbProgress !== this.target || this.colorProgress !== this.target;
  }
  advanceAnimation(deltaMs: number): void {
    const changed = this.syncTarget();
    if (!this.animating) return;
    // A newly observed change starts now, not at the previous (possibly idle) frame.
    if (!changed && Number.isFinite(deltaMs)) this.elapsed += Math.max(0, deltaMs);
    this.markDirty(GuiDirtyFlags.Visual);
  }
  finishAnimation(): void {
    this.target = this.thumbFrom = this.colorFrom = this.checked ? 1 : 0;
    this.elapsed = 0;
    this.markDirty(GuiDirtyFlags.Visual);
  }
  private syncTarget(): boolean {
    const next = this.checked ? 1 : 0;
    if (next === this.target) return false;
    this.thumbFrom = this.sample(this.thumbFrom, this.thumbTransitionMs);
    this.colorFrom = this.sample(this.colorFrom, this.colorTransitionMs);
    this.target = next;
    this.elapsed = 0;
    return true;
  }
  private sample(from: number, duration: number): number {
    if (!Number.isFinite(duration) || duration <= 0 || this.elapsed >= duration) return this.target;
    const t = 1 - Math.pow(1 - this.elapsed / duration, 3);
    return from + (this.target - from) * t;
  }
}
