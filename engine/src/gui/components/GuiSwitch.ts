import { GuiCheckbox, GuiCheckboxOptions } from './GuiCheckbox';

export interface GuiSwitchOptions extends GuiCheckboxOptions {}

export class GuiSwitch extends GuiCheckbox {
  constructor(options: GuiSwitchOptions = {}) {
    super({ width: 48, height: 28, ...options });
  }
}
