import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { containsPoint, GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiRect, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import type {GuiActionEvent} from '../GuiTypes';

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
  private static readonly __controlIdentityGuiSelect = /* @__PURE__ */ (() => admitGuiControl(GuiSelect.prototype, 'GuiSelect', undefined, paintGuiSelect))();
  static override readonly themeControlType: string = 'GuiSelect';
  override handlePointerCancel(event: GuiPointerEvent): void {
    this.pointerDownInPopup = false;
    super.handlePointerCancel(event);
  }
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (event.consumed) return;
    if (event.action === 'cancel' && this.open) { this.setOpen(false); event.consume(); }
    else if (event.action === 'confirm') { this.setOpen(!this.open); event.consume(); }
    else if (event.action === 'up' || event.action === 'down') {
      const step = event.action === 'up' ? -1 : 1;
      let index = this.options.findIndex(option => option.value === this.value);
      if (index < 0) index = step > 0 ? -1 : this.options.length;
      for (index += step; index >= 0 && index < this.options.length; index += step) {
        const option = this.options[index]!;
        if (!option.disabled) { this.setValue(option.value, true); break; }
      }
      event.consume();
    }
  }
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
    super({ width: 180, height: 32, focus: {mode: 'all'}, ...options });
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
    if (!this.visible || this.disabled || this.pointerFilter === 'ignore') return null;
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

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiSelect(context:GuiPaint.GuiControlPaintContext, select: GuiSelect, theme: GuiPaint.GuiTheme): void {
    const style = context.styleFor(select), custom = !!(style.contentInsets || style.nineSlice || style.icon), box = GuiPaint.guiContentBox(select, 8, theme.fontSize).text;
    const radius = context.styleFor(select).radius ?? theme.radius;
    const border = GuiPaint.colorToRgba(context.styleFor(select).borderColor, select.focused || select.open ? theme.colors.primary : theme.colors.border);
    context.addRect(select.rect.x, select.rect.y, select.rect.width, select.rect.height, radius, border);
    context.addRect(select.rect.x + 1, select.rect.y + 1, select.rect.width - 2, select.rect.height - 2, Math.max(0, radius - 1), GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(select).backgroundColor, theme.colors.surface), select.disabled ? 0.45 : 1));
    const textColor = select.selectedOption
      ? GuiPaint.colorToRgba(theme.colors.text, theme.colors.text)
      : GuiPaint.colorToRgba(theme.colors.textMuted, theme.colors.textMuted);
    context.addText(select.displayText, custom ? box.x : select.rect.x + 8, custom ? box.y : select.rect.y,
      Math.max(0, custom ? box.width - 22 : select.rect.width - 30), custom ? box.height : select.rect.height, theme.fontSize, textColor, true);

    const arrowX = select.rect.x + select.rect.width - 18;
    const arrowY = select.rect.y + select.rect.height * 0.5;
    context.addRect(arrowX, arrowY - 1, 10, 2, 1, GuiPaint.colorToRgba(theme.colors.textMuted, theme.colors.textMuted));
    context.addRect(arrowX + 2, arrowY + 3, 6, 2, 1, GuiPaint.colorToRgba(theme.colors.textMuted, theme.colors.textMuted));

    if (!select.open) return;
    const popup = select.popupRect;
    context.addPopupRect(popup.x, popup.y, popup.width, popup.height, radius, GuiPaint.colorToRgba(theme.colors.border, theme.colors.border));
    context.addPopupRect(popup.x + 1, popup.y + 1, popup.width - 2, popup.height - 2, Math.max(0, radius - 1), GuiPaint.colorToRgba(theme.colors.surface, theme.colors.surface));

    const firstIndex = Math.max(0, Math.floor(select.scrollY / select.optionHeight));
    const localOffset = select.scrollY - firstIndex * select.optionHeight;
    const visibleCount = Math.min(
      select.options.length - firstIndex,
      select.maxVisibleOptions + (localOffset > 0 ? 1 : 0),
    );
    for (let i = 0; i < visibleCount; i++) {
      const optionIndex = firstIndex + i;
      const option = GuiPaint.requiredItemAt(select.options, optionIndex, 'GUI select options');
      const y = popup.y + i * select.optionHeight - localOffset;
      const selected = option.value === select.value;
      if (selected) {
        context.addPopupRect(popup.x + 2, y + 2, popup.width - 4, select.optionHeight - 4, Math.max(0, radius - 2), GuiPaint.withAlpha(GuiPaint.colorToRgba(theme.colors.primary, theme.colors.primary), 0.32), popup);
      }
      context.addPopupText(option.label, popup.x + 8, y, popup.width - 18, select.optionHeight, theme.fontSize, GuiPaint.withAlpha(GuiPaint.colorToRgba(option.disabled ? theme.colors.textMuted : theme.colors.text, theme.colors.text), option.disabled ? 0.55 : 1), popup, true);
    }
    if (select.maxScrollY > 0) {
      const trackH = popup.height - 8;
      const thumbH = Math.max(18, trackH * (popup.height / (select.options.length * select.optionHeight)));
      const thumbY = popup.y + 4 + (trackH - thumbH) * (select.scrollY / select.maxScrollY);
      context.addPopupRect(popup.x + popup.width - 7, popup.y + 4, 3, trackH, 1.5, GuiPaint.withAlpha(GuiPaint.colorToRgba(theme.colors.border, theme.colors.border), 0.55), popup);
      context.addPopupRect(popup.x + popup.width - 8, thumbY, 5, thumbH, 2.5, GuiPaint.withAlpha(GuiPaint.colorToRgba(theme.colors.textMuted, theme.colors.textMuted), 0.75), popup);
    }
  }
