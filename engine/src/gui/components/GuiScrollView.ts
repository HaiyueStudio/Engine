import {admitGuiControl} from '../GuiControlIdentity';
import { GuiElement } from './GuiElement';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, type GuiElementOptions, type GuiRect } from '../GuiTypes';
import {guiLayoutContentHeight, notifyGuiActivity, registerGuiScrollOffset} from '../GuiLayoutState';
import {guiScrollOcclusion} from '../input/GuiScrollViewportState';

export interface GuiScrollViewOptions extends GuiElementOptions {
  axis?: 'vertical' | 'horizontal';
  contentWidth?: number;
  scrollX?: number;
  contentHeight?: number;
  scrollY?: number;
  showScrollbar?: boolean;
  /** Continue touch/drag scrolling after release. Defaults to false. Wheel momentum is supplied by the OS. */
  inertia?: boolean;
  /** Momentum decay multiplier: 1 is a 325 ms time constant; 0 disables momentum. Clamped to 0–4. */
  inertiaStrength?: number;
}

/** Single-axis viewport. Children use content-local coordinates; drawing and hits are clipped. */
export class GuiScrollView extends GuiElement {
  private static readonly __controlIdentityGuiScrollView = /* @__PURE__ */ (() => admitGuiControl(GuiScrollView.prototype, 'GuiScrollView'))();
  static override readonly themeControlType: string = 'GuiScrollView';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    const backward = this.axis === 'horizontal' ? 'left' : 'up', forward = this.axis === 'horizontal' ? 'right' : 'down';
    if (event.consumed || (event.action !== backward && event.action !== forward)) return;
    const before = this.scrollOffset;
    this.scrollBy(event.action === backward ? -40 : 40);
    if (before !== this.scrollOffset) event.consume();
  }
  readonly axis: 'vertical' | 'horizontal';
  contentWidth: number;
  private manualContentHeight = 0;
  get contentHeight(): number {return guiLayoutContentHeight(this) ?? this.manualContentHeight;}
  set contentHeight(value: number) {this.manualContentHeight = value;}
  showScrollbar: boolean;
  inertia: boolean;
  inertiaStrength: number;
  private velocity = 0;
  private offset: number;
  constructor(options: GuiScrollViewOptions = {}) {
    super({focus: {mode: 'all'}, ...options});
    this.axis = options.axis ?? 'vertical';
    this.contentWidth = Number.isFinite(options.contentWidth) ? Math.max(0, options.contentWidth!) : 0;
    this.contentHeight = Number.isFinite(options.contentHeight)
      ? Math.max(0, options.contentHeight!)
      : 0;
    const initial = this.axis === 'horizontal' ? options.scrollX : options.scrollY;
    this.offset = Number.isFinite(initial) ? Math.max(0, initial!) : 0;
    registerGuiScrollOffset(this, () => this.offset, () => {
      const offset = this.offset, velocity = this.velocity, height = this.manualContentHeight, width = this.contentWidth;
      return () => {this.offset = offset; this.velocity = velocity; this.manualContentHeight = height; this.contentWidth = width;};
    }, () => this.axis);
    this.showScrollbar = options.showScrollbar ?? true;
    this.inertia = options.inertia ?? false;
    this.inertiaStrength = options.inertiaStrength ?? 1;
  }
  get scrollY(): number {
    return this.axis === 'vertical' ? this.offset : 0;
  }
  get scrollX(): number {return this.axis === 'horizontal' ? this.offset : 0;}
  get scrollOffset(): number {return this.offset;}
  get maxScrollX(): number {return this.axis === 'horizontal' ? Math.max(0, this.contentWidth - this.rect.width) : 0;}
  get maxScrollY(): number {
    return this.axis === 'vertical' ? Math.max(0, this.contentHeight - Math.max(0,this.rect.height-guiScrollOcclusion(this))) : 0;
  }
  get maxScrollOffset(): number {return this.axis === 'horizontal' ? this.maxScrollX : this.maxScrollY;}
  setContentWidth(width: number): void {
    const value = Number.isFinite(width) ? Math.max(0, width) : 0;
    if (this.contentWidth === value) return;
    this.contentWidth = value; this.scrollTo(this.offset); this.layoutContent(); this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
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
    const value = Math.max(0, Math.min(this.maxScrollOffset, Number.isFinite(y) ? y : 0));
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
    if ((this.offset <= 0 && this.velocity < 0) || (this.offset >= this.maxScrollOffset && this.velocity > 0)) this.stopInertia();
    notifyGuiActivity(this);
  }
  stopInertia(): void {if (this.velocity === 0) return; this.velocity = 0; notifyGuiActivity(this);}
  /** Advance in milliseconds. Exact exponential integration is independent of frame rate. */
  advanceAnimation(deltaMs: number): void {
    if (!this.animating) { this.stopInertia(); return; }
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const tau = 325 * this.strength, decay = Math.exp(-deltaMs / tau);
    const next = this.offset + this.velocity * tau / 1000 * (1 - decay);
    this.velocity *= decay;
    this.setOffset(next);
    if (Math.abs(this.velocity) < 12 || next <= 0 || next >= this.maxScrollOffset) this.stopInertia();
  }
  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    const clamped = Math.max(0, Math.min(this.offset, this.maxScrollOffset));
    if (clamped !== this.offset) this.stopInertia();
    this.offset = clamped;
    this.layoutContent();
  }
  private layoutContent(): void {
    const content = this.axis === 'horizontal' ? {...this.rect, x: this.rect.x - this.offset, width: this.contentWidth}
      : { ...this.rect, y: this.rect.y - this.offset, height: this.contentHeight };
    for (const child of this.children) child.layout(content);
  }
}
