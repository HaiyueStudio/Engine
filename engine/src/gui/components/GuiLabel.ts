import { GuiDirtyFlags, type GuiElementOptions, type GuiRect } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiLabelTextAlign = 'left' | 'center' | 'right';

export interface GuiLabelOptions extends GuiElementOptions {
  text?: string;
  fontSize?: number;
  textAlign?: GuiLabelTextAlign;
  /** Sizes the label width to the measured text plus horizontal padding. */
  autoWidth?: boolean;
}

const measuredTextWidths = new WeakMap<GuiLabel, number>();

/** Non-interactive text intended for headings, status text, and HUD values. */
export class GuiLabel extends GuiElement {
  text: string;
  fontSize: number | undefined;
  textAlign: GuiLabelTextAlign;
  autoWidth: boolean;

  constructor(options: GuiLabelOptions = {}) {
    super({ width: 96, height: 24, disabled: true, ...options });
    this.text = options.text ?? '';
    this.fontSize = options.fontSize;
    this.textAlign = options.textAlign ?? 'left';
    this.autoWidth = options.autoWidth ?? false;
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }

  setFontSize(fontSize: number | undefined): void {
    if (this.fontSize === fontSize) return;
    this.fontSize = fontSize;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }

  setTextAlign(textAlign: GuiLabelTextAlign): void {
    if (this.textAlign === textAlign) return;
    this.textAlign = textAlign;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }

  setAutoWidth(autoWidth: boolean): void {
    if (this.autoWidth === autoWidth) return;
    this.autoWidth = autoWidth;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  override layout(parentRect: GuiRect): void {
    super.layout(parentRect);
    if (!this.autoWidth) return;
    const measuredWidth = measuredTextWidths.get(this);
    if (measuredWidth === undefined) return;
    const padding = this.style.padding ?? 0;
    const width = Math.ceil(measuredWidth + padding * 2);
    if (this.rect.width === width) return;
    this.rect.width = width;
    for (const child of this.children) child.layout(this.rect);
  }
}

/** @internal Supplies font metrics before the normal GUI layout pass. */
export function setGuiLabelMeasuredTextWidth(label: GuiLabel, width: number): void {
  if (measuredTextWidths.get(label) === width) return;
  measuredTextWidths.set(label, width);
  label.markDirty(GuiDirtyFlags.Layout);
}
