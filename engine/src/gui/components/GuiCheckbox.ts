import { GuiElement } from './GuiElement';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';

export interface GuiCheckboxOptions extends GuiElementOptions {
  checked?: boolean;
  label?: string;
  onChange?: GuiValueChangeHandler<boolean>;
}

export class GuiCheckbox extends GuiElement {
  checked: boolean;
  label: string;
  onChange: GuiValueChangeHandler<boolean> | null;

  constructor(options: GuiCheckboxOptions = {}) {
    super({ width: 120, height: 28, ...options });
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
