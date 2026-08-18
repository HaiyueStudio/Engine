import { containsPoint, GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiRect, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiSelectOption<T = string> {
  label: string;
  value: T;
  disabled?: boolean;
}

export interface GuiSelectOptions<T = string> extends GuiElementOptions {
  value?: T | null;
  options?: GuiSelectOption<T>[];
  placeholder?: string;
  optionHeight?: number;
  maxVisibleOptions?: number;
  onChange?: GuiValueChangeHandler<T>;
}

export class GuiSelect<T = string> extends GuiElement {
  value: T | null;
  options: GuiSelectOption<T>[];
  placeholder: string;
  optionHeight: number;
  maxVisibleOptions: number;
  open = false;
  onChange: GuiValueChangeHandler<T> | null;
  scrollY = 0;

  private pointerDownInPopup = false;
  private lastPointerY = 0;
  private dragDistance = 0;
  private selectedOptionCache: GuiSelectOption<T> | null = null;
  private selectedOptionCacheValue: T | null | undefined = undefined;
  private selectedOptionCacheOptions: GuiSelectOption<T>[] | null = null;

  constructor(options: GuiSelectOptions<T> = {}) {
    super({ width: 180, height: 32, ...options });
    this.value = options.value ?? null;
    this.options = options.options ?? [];
    this.placeholder = options.placeholder ?? 'Select';
    this.optionHeight = options.optionHeight ?? 28;
    this.maxVisibleOptions = options.maxVisibleOptions ?? 6;
    this.onChange = options.onChange ?? null;
  }

  get selectedOption(): GuiSelectOption<T> | null {
    if (
      this.selectedOptionCacheOptions === this.options &&
      this.selectedOptionCacheValue === this.value
    ) {
      return this.selectedOptionCache;
    }
    this.selectedOptionCacheOptions = this.options;
    this.selectedOptionCacheValue = this.value;
    this.selectedOptionCache = this.options.find((option) => option.value === this.value) ?? null;
    return this.selectedOptionCache;
  }

  get displayText(): string {
    return this.selectedOption?.label ?? this.placeholder;
  }

  get popupRect(): GuiRect {
    const visibleCount = Math.min(this.options.length, this.maxVisibleOptions);
    return {
      x: this.rect.x,
      y: this.rect.y + this.rect.height + 4,
      width: this.rect.width,
      height: Math.max(0, visibleCount * this.optionHeight),
    };
  }

  get maxScrollY(): number {
    return Math.max(0, this.options.length * this.optionHeight - this.popupRect.height);
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    if (open) this.scrollSelectedOptionIntoView();
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  setValue(value: T, emit = false): void {
    if (this.value === value) return;
    this.value = value;
    this.selectedOptionCacheValue = undefined;
    this.scrollSelectedOptionIntoView();
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Text | GuiDirtyFlags.Input);
    if (emit) this.onChange?.(value);
  }

  scrollBy(deltaY: number): void {
    const next = Math.max(0, Math.min(this.maxScrollY, this.scrollY + deltaY));
    if (next === this.scrollY) return;
    this.scrollY = next;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  containsPointIncludingPopup(x: number, y: number): boolean {
    return containsPoint(this.rect, x, y) || (this.open && containsPoint(this.popupRect, x, y));
  }

  override hitTest(x: number, y: number): GuiElement | null {
    if (!this.visible || this.disabled) return null;
    if (containsPoint(this.rect, x, y)) return this;
    if (this.open && containsPoint(this.popupRect, x, y)) return this;
    return null;
  }

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    if (this.dragDistance > 6) {
      this.dragDistance = 0;
      return;
    }
    if (containsPoint(this.rect, event.x, event.y)) {
      this.setOpen(!this.open);
      return;
    }
    if (!this.open || !containsPoint(this.popupRect, event.x, event.y)) return;
    const index = this.optionIndexAt(event.y);
    const option = this.options[index];
    if (!option || option.disabled) return;
    this.setValue(option.value, true);
    this.setOpen(false);
  }

  override handlePointerDown(event: GuiPointerEvent): void {
    super.handlePointerDown(event);
    this.pointerDownInPopup = this.open && containsPoint(this.popupRect, event.x, event.y);
    this.lastPointerY = event.y;
    this.dragDistance = 0;
  }

  override handlePointerMove(event: GuiPointerEvent): void {
    super.handlePointerMove(event);
    if (!this.pointerDownInPopup) return;
    const dy = event.y - this.lastPointerY;
    this.lastPointerY = event.y;
    this.dragDistance += Math.abs(dy);
    this.scrollBy(-dy);
  }

  override handlePointerUp(event: GuiPointerEvent): void {
    super.handlePointerUp(event);
    this.pointerDownInPopup = false;
  }

  optionIndexAt(y: number): number {
    return Math.floor((y - this.popupRect.y + this.scrollY) / this.optionHeight);
  }

  private scrollSelectedOptionIntoView(): void {
    const index = this.options.findIndex(option => option.value === this.value);
    if (index < 0) {
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY));
      return;
    }
    const top = index * this.optionHeight;
    const bottom = top + this.optionHeight;
    const visibleTop = this.scrollY;
    const visibleBottom = this.scrollY + this.popupRect.height;
    if (top < visibleTop) this.scrollY = top;
    else if (bottom > visibleBottom) this.scrollY = bottom - this.popupRect.height;
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY));
  }
}
