import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiSliderOptions extends GuiElementOptions {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: GuiValueChangeHandler<number>;
  onCommit?: GuiValueChangeHandler<number>;
}

export class GuiSlider extends GuiElement {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: GuiValueChangeHandler<number> | null;
  onCommit: GuiValueChangeHandler<number> | null;

  constructor(options: GuiSliderOptions = {}) {
    super({ width: 160, height: 28, ...options });
    this.value = options.value ?? 0;
    this.min = options.min ?? 0;
    this.max = options.max ?? 100;
    this.step = options.step ?? 1;
    this.onChange = options.onChange ?? null;
    this.onCommit = options.onCommit ?? null;
  }

  get ratio(): number {
    const range = this.max - this.min;
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, (this.value - this.min) / range));
  }

  setValue(value: number, emit = false): void {
    const stepped = this.step > 0 ? Math.round(value / this.step) * this.step : value;
    const next = Math.min(this.max, Math.max(this.min, stepped));
    if (this.value === next) return;
    this.value = next;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(next);
  }

  override handlePointerDown(event: GuiPointerEvent): void {
    super.handlePointerDown(event);
    this.updateFromPointer(event, true);
  }

  override handlePointerMove(event: GuiPointerEvent): void {
    super.handlePointerMove(event);
    if (this.pressed) this.updateFromPointer(event, true);
  }

  override handlePointerUp(event: GuiPointerEvent): void {
    super.handlePointerUp(event);
    this.onCommit?.(this.value);
  }

  private updateFromPointer(event: GuiPointerEvent, emit: boolean): void {
    const ratio = this.rect.width > 0 ? event.localX / this.rect.width : 0;
    this.setValue(this.min + (this.max - this.min) * ratio, emit);
  }
}
