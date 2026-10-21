import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent } from '../GuiTypes';

export interface GuiButtonOptions extends GuiElementOptions {
  text?: string;
  variant?: 'default' | 'primary' | 'danger' | 'outline';
  onClick?: (event: GuiPointerEvent) => void;
}

export class GuiButton extends GuiElement {
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  text: string;
  variant: 'default' | 'primary' | 'danger' | 'outline';

  constructor(options: GuiButtonOptions = {}) {
    super({ width: 96, height: 32, focus: {mode: 'all'}, ...options });
    this.text = options.text ?? 'Button';
    this.variant = options.variant ?? 'default';
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual);
  }
}
