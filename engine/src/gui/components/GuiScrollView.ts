import { GuiElement } from './GuiElement';
import { GuiDirtyFlags, type GuiElementOptions, type GuiRect } from '../GuiTypes';

export interface GuiScrollViewOptions extends GuiElementOptions {
  contentHeight?: number;
  scrollY?: number;
  showScrollbar?: boolean;
}

/** Vertical viewport. Children use content-local coordinates; drawing and hits are clipped. */
export class GuiScrollView extends GuiElement {
  contentHeight: number;
  showScrollbar: boolean;
  private offset: number;
  constructor(options: GuiScrollViewOptions = {}) {
    super(options);
    this.contentHeight = Number.isFinite(options.contentHeight)
      ? Math.max(0, options.contentHeight!)
      : 0;
    this.offset = Number.isFinite(options.scrollY) ? Math.max(0, options.scrollY!) : 0;
    this.showScrollbar = options.showScrollbar ?? true;
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
    const value = Math.max(0, Math.min(this.maxScrollY, Number.isFinite(y) ? y : 0));
    if (this.offset === value) return;
    this.offset = value;
    this.layoutContent();
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }
  scrollBy(delta: number): void {
    this.scrollTo(this.offset + delta);
  }
  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    this.offset = Math.max(0, Math.min(this.offset, this.maxScrollY));
    this.layoutContent();
  }
  private layoutContent(): void {
    const content = { ...this.rect, y: this.rect.y - this.offset, height: this.contentHeight };
    for (const child of this.children) child.layout(content);
  }
}
