import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiInputOptions extends GuiElementOptions {
  value?: string;
  placeholder?: string;
  readOnly?: boolean;
  onChange?: GuiValueChangeHandler<string>;
  onSubmit?: GuiValueChangeHandler<string>;
}

export class GuiInput extends GuiElement {
  value: string;
  placeholder: string;
  readOnly: boolean;
  caretIndex: number;
  selectionAnchor: number;
  selectionFocus: number;
  selecting = false;
  onChange: GuiValueChangeHandler<string> | null;
  onSubmit: GuiValueChangeHandler<string> | null;

  constructor(options: GuiInputOptions = {}) {
    super({ width: 180, height: 32, ...options });
    this.value = options.value ?? '';
    this.placeholder = options.placeholder ?? '';
    this.readOnly = options.readOnly ?? false;
    this.caretIndex = this.value.length;
    this.selectionAnchor = this.caretIndex;
    this.selectionFocus = this.caretIndex;
    this.onChange = options.onChange ?? null;
    this.onSubmit = options.onSubmit ?? null;
  }

  get selectionStart(): number {
    return Math.min(this.selectionAnchor, this.selectionFocus);
  }

  get selectionEnd(): number {
    return Math.max(this.selectionAnchor, this.selectionFocus);
  }

  get hasSelection(): boolean {
    return this.selectionStart !== this.selectionEnd;
  }

  get selectedText(): string {
    return this.hasSelection ? this.value.slice(this.selectionStart, this.selectionEnd) : '';
  }

  setValue(value: string, emit = false): void {
    if (this.value === value) return;
    this.value = value;
    this.caretIndex = Math.min(this.caretIndex, this.value.length);
    this.setSelection(this.caretIndex, this.caretIndex, false);
    this.markDirty(GuiDirtyFlags.Text | GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(value);
  }

  insertText(text: string): void {
    if (this.disabled || this.readOnly || !text) return;
    const [start, end] = this.getEditRange();
    const next = this.value.slice(0, start) + text + this.value.slice(end);
    this.caretIndex = start + text.length;
    this.setValue(next, true);
  }

  deleteBackward(): void {
    if (this.disabled || this.readOnly) return;
    const [start, end] = this.hasSelection
      ? this.getEditRange()
      : [Math.max(0, this.caretIndex - 1), this.caretIndex];
    if (start === end) return;
    const next = this.value.slice(0, start) + this.value.slice(end);
    this.caretIndex = start;
    this.setValue(next, true);
  }

  deleteForward(): void {
    if (this.disabled || this.readOnly) return;
    const [start, end] = this.hasSelection
      ? this.getEditRange()
      : [this.caretIndex, Math.min(this.value.length, this.caretIndex + 1)];
    if (start === end) return;
    const next = this.value.slice(0, start) + this.value.slice(end);
    this.caretIndex = start;
    this.setValue(next, true);
  }

  moveCaret(delta: number, extendSelection = false): void {
    const next = Math.max(0, Math.min(this.value.length, this.caretIndex + delta));
    if (next === this.caretIndex && !extendSelection) return;
    this.caretIndex = next;
    if (extendSelection) {
      this.selectionFocus = next;
    } else {
      this.setSelection(next, next, false);
    }
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  setCaret(index: number, extendSelection = false): void {
    const next = Math.max(0, Math.min(this.value.length, index));
    if (next === this.caretIndex && !extendSelection) return;
    this.caretIndex = next;
    if (extendSelection) {
      this.selectionFocus = next;
    } else {
      this.setSelection(next, next, false);
    }
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  setSelection(anchor: number, focus: number, markDirty = true): void {
    const nextAnchor = Math.max(0, Math.min(this.value.length, anchor));
    const nextFocus = Math.max(0, Math.min(this.value.length, focus));
    const changed = this.selectionAnchor !== nextAnchor || this.selectionFocus !== nextFocus;
    this.selectionAnchor = nextAnchor;
    this.selectionFocus = nextFocus;
    this.caretIndex = nextFocus;
    if (changed && markDirty) this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  selectAll(): void {
    this.setSelection(0, this.value.length);
  }

  clearSelection(): void {
    this.setSelection(this.caretIndex, this.caretIndex);
  }

  getCaretIndexAt(localX: number, measureTextWidth: (text: string) => number, padding = this.style.padding ?? 8): number {
    const x = Math.max(0, localX - padding);
    if (x <= 0) return 0;
    for (let i = 1; i <= this.value.length; i++) {
      const prev = measureTextWidth(this.value.slice(0, i - 1));
      const next = measureTextWidth(this.value.slice(0, i));
      if (x < (prev + next) * 0.5) return i - 1;
    }
    return this.value.length;
  }

  submit(): void {
    this.onSubmit?.(this.value);
  }

  override handlePointerDown(event: GuiPointerEvent): void {
    super.handlePointerDown(event);
    this.selecting = true;
  }

  override handlePointerMove(event: GuiPointerEvent): void {
    super.handlePointerMove(event);
    if (!this.selecting || !(event.buttons & 1)) return;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  override handlePointerUp(event: GuiPointerEvent): void {
    super.handlePointerUp(event);
    this.selecting = false;
  }

  private getEditRange(): [number, number] {
    return this.hasSelection ? [this.selectionStart, this.selectionEnd] : [this.caretIndex, this.caretIndex];
  }
}
