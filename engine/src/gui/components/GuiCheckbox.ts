import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';

export interface GuiCheckboxOptions extends GuiElementOptions {
  checked?: boolean;
  label?: string;
  onChange?: GuiValueChangeHandler<boolean>;
}

export class GuiCheckbox extends GuiElement {
  static override readonly themeControlType: string = 'GuiCheckbox';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  checked: boolean;
  label: string;
  onChange: GuiValueChangeHandler<boolean> | null;

  constructor(options: GuiCheckboxOptions = {}) {
    super({ width: 120, height: 28, focus: {mode: 'all'}, ...options });
    this.checked = options.checked ?? false;
    this.label = options.label ?? '';
    this.onChange = options.onChange ?? null;
  }

  setChecked(checked: boolean, emit = false): void {
    if (this.checked === checked) return;
    this.checked = checked;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(checked);
  }

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    this.setChecked(!this.checked, true);
  }
}
