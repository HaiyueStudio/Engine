import { GuiDirtyFlags, GuiElementOptions } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiProgressOptions extends GuiElementOptions {
  value?: number;
  min?: number;
  max?: number;
  showText?: boolean;
}

export class GuiProgress extends GuiElement {
  value: number;
  min: number;
  max: number;
  showText: boolean;

  constructor(options: GuiProgressOptions = {}) {
    super({ width: 160, height: 12, ...options });
    this.value = options.value ?? 0;
    this.min = options.min ?? 0;
    this.max = options.max ?? 100;
    this.showText = options.showText ?? false;
  }

  get ratio(): number {
    const range = this.max - this.min;
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, (this.value - this.min) / range));
  }

  setValue(value: number): void {
    const next = Math.min(this.max, Math.max(this.min, value));
    if (this.value === next) return;
    this.value = next;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Text);
  }
}
