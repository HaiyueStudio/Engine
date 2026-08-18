import { GuiElement } from './GuiElement';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent } from '../GuiTypes';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  variant?: 'default' | 'primary' | 'danger';
  onClick?: (event: GuiPointerEvent) => void;
}

export class GuiButton extends GuiElement {
  text: string;
  variant: 'default' | 'primary' | 'danger';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, ...options });
    this.text = options.text ?? 'Button';
    this.variant = options.variant ?? 'default';
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }
}
