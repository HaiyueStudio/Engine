import { GuiDirtyFlags, type GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export type GuiLabelTextAlign = 'left' | 'center' | 'right';

export interface GuiLabelOptions extends GuiElementOptions {
  text?: string;
  fontSize?: number;
  textAlign?: GuiLabelTextAlign;
}

/** Non-interactive text intended for headings, status text, and HUD values. */
export class GuiLabel extends GuiElement {
  text: string;
  fontSize: number | undefined;
  textAlign: GuiLabelTextAlign;

  constructor(options: GuiLabelOptions = {}) {
    super({ width: 96, height: 24, disabled: true, ...options });
    this.text = options.text ?? '';
    this.fontSize = options.fontSize;
    this.textAlign = options.textAlign ?? 'left';
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
}
