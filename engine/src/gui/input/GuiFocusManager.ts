import { GuiElement } from '../components/GuiElement';

export class GuiFocusManager {
  focused: GuiElement | null = null;

  focus(element: GuiElement | null): void {
    if (this.focused === element) return;
    this.focused?.handleBlur();
    this.focused = element;
    this.focused?.handleFocus();
  }

  blur(): void {
    this.focus(null);
  }
}
