import {
  containsPoint,
  GuiDirtyFlags,
  GuiElementOptions,
  GuiLength,
  GuiPointerHandler,
  GuiPointerEvent,
  GuiRect,
  GuiStyle,
  resolveGuiLength,
} from '../GuiTypes';
import { EventEmitter } from '../../core/EventEmitter';
import { requiredItemAt } from '../../math/arrayAccess';

let guiElementId = 0;

export class GuiElement extends EventEmitter<Record<string, GuiPointerEvent>> {
  readonly id: string;
  parent: GuiElement | null = null;
  children: GuiElement[] = [];
  rect: GuiRect = { x: 0, y: 0, width: 0, height: 0 };
  hovered = false;
  pressed = false;
  focused = false;
  visible: boolean;
  disabled: boolean;
  style: GuiStyle;

  protected x: GuiLength;
  protected y: GuiLength;
  protected width: GuiLength;
  protected height: GuiLength;
  protected dirtyFlags = GuiDirtyFlags.All;
  protected onPointerEnter: GuiPointerHandler | null;
  protected onPointerLeave: GuiPointerHandler | null;
  protected onPointerDown: GuiPointerHandler | null;
  protected onPointerMove: GuiPointerHandler | null;
  protected onPointerUp: GuiPointerHandler | null;
  protected onClick: GuiPointerHandler | null;

  constructor(options: GuiElementOptions = {}) {
    super();
    this.id = options.id ?? `gui-${++guiElementId}`;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.width = options.width ?? 0;
    this.height = options.height ?? 0;
    this.visible = options.visible ?? true;
    this.disabled = options.disabled ?? false;
    this.style = options.style ?? {};
    this.onPointerEnter = options.onPointerEnter ?? null;
    this.onPointerLeave = options.onPointerLeave ?? null;
    this.onPointerDown = options.onPointerDown ?? null;
    this.onPointerMove = options.onPointerMove ?? null;
    this.onPointerUp = options.onPointerUp ?? null;
    this.onClick = options.onClick ?? null;
  }

  get dirty(): boolean {
    if (this.dirtyFlags !== GuiDirtyFlags.None) return true;
    return this.children.some((child) => child.dirty);
  }

  getDirtyFlags(): GuiDirtyFlags {
    return this.dirtyFlags;
  }

  getLayoutOptions(): Pick<GuiElementOptions, 'x' | 'y' | 'width' | 'height'> {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
    };
  }

  markDirty(flags = GuiDirtyFlags.Visual): void {
    this.dirtyFlags |= flags;
    if (flags & (GuiDirtyFlags.Layout | GuiDirtyFlags.Children)) {
      this.parent?.markDirty(GuiDirtyFlags.Children);
    }
  }

  clearDirty(): void {
    this.dirtyFlags = GuiDirtyFlags.None;
    for (const child of this.children) child.clearDirty();
  }

  add<T extends GuiElement>(child: T): T {
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    this.markDirty(GuiDirtyFlags.Children | GuiDirtyFlags.Layout);
    return child;
  }

  remove(child: GuiElement): boolean {
    const index = this.children.indexOf(child);
    if (index < 0) return false;
    this.children.splice(index, 1);
    child.parent = null;
    this.markDirty(GuiDirtyFlags.Children | GuiDirtyFlags.Layout);
    return true;
  }

  findById(id: string): GuiElement | null {
    if (this.id === id) return this;
    for (const child of this.children) {
      const match = child.findById(id);
      if (match) return match;
    }
    return null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.markDirty(GuiDirtyFlags.Layout | GuiDirtyFlags.Visual);
  }

  setDisabled(disabled: boolean): void {
    if (this.disabled === disabled) return;
    this.disabled = disabled;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  setStyle(style: GuiStyle): void {
    this.style = { ...this.style, ...style };
    this.markDirty(GuiDirtyFlags.Visual);
  }

  layout(parentRect: GuiRect): void {
    const width = resolveGuiLength(this.width, parentRect.width, this.rect.width);
    const height = resolveGuiLength(this.height, parentRect.height, this.rect.height);
    const x = parentRect.x + resolveGuiLength(this.x, parentRect.width, 0);
    const y = parentRect.y + resolveGuiLength(this.y, parentRect.height, 0);
    this.rect = { x, y, width, height };
    for (const child of this.children) child.layout(this.rect);
  }

  hitTest(x: number, y: number): GuiElement | null {
    if (!this.visible || this.disabled || !containsPoint(this.rect, x, y)) return null;
    for (let i = this.children.length - 1; i >= 0; i--) {
      const hit = requiredItemAt(this.children, i, 'GUI child elements').hitTest(x, y);
      if (hit) return hit;
    }
    return this;
  }

  handlePointerEnter(event: GuiPointerEvent): void {
    this.hovered = true;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    this.onPointerEnter?.(event);
    this.emitGuiPointerEvent(event, false);
  }

  handlePointerLeave(event: GuiPointerEvent): void {
    this.hovered = false;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    this.onPointerLeave?.(event);
    this.emitGuiPointerEvent(event, false);
  }

  handlePointerDown(event: GuiPointerEvent): void {
    this.pressed = true;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    this.onPointerDown?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handlePointerMove(event: GuiPointerEvent): void {
    this.onPointerMove?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handlePointerUp(event: GuiPointerEvent): void {
    if (this.pressed) {
      this.pressed = false;
      this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    }
    this.onPointerUp?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handleClick(event: GuiPointerEvent): void {
    this.onClick?.(event);
    this.emitGuiPointerEvent(event, true);
  }

  handleFocus(): void {
    if (this.focused) return;
    this.focused = true;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  handleBlur(): void {
    if (!this.focused) return;
    this.focused = false;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
  }

  private emitGuiPointerEvent(event: GuiPointerEvent, bubbles: boolean): void {
    if (event.stopped) return;
    const path: GuiElement[] = [];
    let current: GuiElement | null = this;
    while (current) {
      path.unshift(current);
      current = current.parent;
    }
    const engineEvent = this.emit(event.type, {
      target: this,
      detail: event,
      path,
      bubbles,
    });
    if (engineEvent.defaultPrevented && !event.defaultPrevented) event.preventDefault();
    if (engineEvent.stopped && !event.stopped) event.stopPropagation();
  }
}
