import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiCheckbox, GuiCheckboxOptions } from './GuiCheckbox';
import { GuiDirtyFlags } from '../GuiTypes';

export interface GuiSwitchOptions extends GuiCheckboxOptions {
  /** Thumb movement duration in milliseconds. Defaults to 0 (instant). */
  thumbTransitionMs?: number;
  /** Track color transition duration in milliseconds. Defaults to 0 (instant). */
  colorTransitionMs?: number;
}

export class GuiSwitch extends GuiCheckbox {
  private static readonly __controlIdentityGuiSwitch = /* @__PURE__ */ (() => admitGuiControl(GuiSwitch.prototype, 'GuiSwitch', undefined, paintGuiSwitch))();
  static override readonly themeControlType: string = 'GuiSwitch';
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
    const next = this.checked ? 1 : 0;
    return (Number.isFinite(this.thumbTransitionMs) && this.thumbTransitionMs > 0 && this.sample(this.thumbFrom, this.thumbTransitionMs) !== next) ||
      (Number.isFinite(this.colorTransitionMs) && this.colorTransitionMs > 0 && this.sample(this.colorFrom, this.colorTransitionMs) !== next);
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

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiSwitch(context:GuiPaint.GuiControlPaintContext, control: GuiSwitch, theme: GuiPaint.GuiTheme): void {
    const off = GuiPaint.colorToRgba(context.styleFor(control).backgroundColor, theme.colors.border);
    const on = GuiPaint.colorToRgba(context.styleFor(control).backgroundColor, theme.colors.primary);
    const amount = control.colorProgress;
    const track = GuiPaint.withAlpha(off.map((value, i) => value + (on[i]! - value) * amount) as [number, number, number, number], control.disabled ? 0.45 : 1);
    const thumb = GuiPaint.colorToRgba(theme.colors.text, theme.colors.text);
    const radius = control.rect.height * 0.5;
    context.currentBatch.addShape({ ...control.rect, radius, color: track, roundedMesh: true, clip: context.currentClip });
    const thumbSize = Math.max(4, control.rect.height - 6);
    const thumbX = control.rect.x + 3 + Math.max(0, control.rect.width - thumbSize - 6) * control.thumbProgress;
    context.currentBatch.addShape({ x: thumbX, y: control.rect.y + 3, width: thumbSize, height: thumbSize, radius: thumbSize * 0.5, color: GuiPaint.withAlpha(thumb, control.disabled ? 0.45 : 1), roundedMesh: true, clip: context.currentClip });
  }
