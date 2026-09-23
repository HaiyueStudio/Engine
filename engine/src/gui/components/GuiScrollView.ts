import { GuiElement } from './GuiElement';
import { GuiDirtyFlags, type GuiElementOptions, type GuiRect } from '../GuiTypes';

export interface GuiScrollViewOptions extends GuiElementOptions {
  contentHeight?: number;
  scrollY?: number;
  showScrollbar?: boolean;
  /** Continue touch/drag scrolling after release. Defaults to false. Wheel momentum is supplied by the OS. */
  inertia?: boolean;
  /** Momentum decay multiplier: 1 is a 325 ms time constant; 0 disables momentum. Clamped to 0–4. */
  inertiaStrength?: number;
}

/** Vertical viewport. Children use content-local coordinates; drawing and hits are clipped. */
export class GuiScrollView extends GuiElement {
  contentHeight: number;
  showScrollbar: boolean;
  inertia: boolean;
  inertiaStrength: number;
  private velocity = 0;
  private offset: number;
  constructor(options: GuiScrollViewOptions = {}) {
    super(options);
    this.contentHeight = Number.isFinite(options.contentHeight)
      ? Math.max(0, options.contentHeight!)
      : 0;
    this.offset = Number.isFinite(options.scrollY) ? Math.max(0, options.scrollY!) : 0;
    this.showScrollbar = options.showScrollbar ?? true;
    this.inertia = options.inertia ?? false;
    this.inertiaStrength = options.inertiaStrength ?? 1;
  }
  get scrollY(): number {
    return this.offset;
  }
  get maxScrollY(): number {
    return Math.max(0, this.contentHeight - this.rect.height);
  }
  setContentHeight(height: number): void {
    const value = Number.isFinite(height) ? Math.max(0, height) : 0;
    if (this.contentHeight === value) return;
    this.contentHeight = value;
    this.scrollTo(this.offset);
    this.layoutContent();
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }
  scrollTo(y: number): void {
    this.stopInertia();
    this.setOffset(y);
  }
  private setOffset(y: number): void {
    const value = Math.max(0, Math.min(this.maxScrollY, Number.isFinite(y) ? y : 0));
    if (this.offset === value) return;
    this.offset = value;
    this.layoutContent();
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }
  scrollBy(delta: number): void {
    this.scrollTo(this.offset + delta);
  }
  /** True while this viewport needs animation frames. */
  get animating(): boolean { return this.inertia && this.strength > 0 && this.velocity !== 0; }
  private get strength(): number { return Number.isFinite(this.inertiaStrength) ? Math.max(0, Math.min(4, this.inertiaStrength)) : 1; }
  /** Release velocity in logical pixels/second; normally supplied by GuiSystem. */
  fling(velocity: number): void {
    this.velocity = this.inertia && this.strength > 0 && Number.isFinite(velocity) && Math.abs(velocity) >= 30
      ? Math.max(-6000, Math.min(6000, velocity)) : 0;
    if ((this.offset <= 0 && this.velocity < 0) || (this.offset >= this.maxScrollY && this.velocity > 0)) this.stopInertia();
  }
  stopInertia(): void { this.velocity = 0; }
  /** Advance in milliseconds. Exact exponential integration is independent of frame rate. */
  advanceAnimation(deltaMs: number): void {
    if (!this.animating) { this.stopInertia(); return; }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const tau = 325 * this.strength, decay = Math.exp(-deltaMs / tau);
    const next = this.offset + this.velocity * tau / 1000 * (1 - decay);
    this.velocity *= decay;
    this.setOffset(next);
    if (Math.abs(this.velocity) < 12 || next <= 0 || next >= this.maxScrollY) this.stopInertia();
  }
  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    const clamped = Math.max(0, Math.min(this.offset, this.maxScrollY));
    if (clamped !== this.offset) this.stopInertia();
    this.offset = clamped;
    this.layoutContent();
  }
  private layoutContent(): void {
    const content = { ...this.rect, y: this.rect.y - this.offset, height: this.contentHeight };
    for (const child of this.children) child.layout(content);
  }
}
