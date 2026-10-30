import * as GuiPaint from '../rendering/GuiControlPaintPrimitives';
import {admitGuiControl} from '../GuiControlIdentity';
import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';
import {activateGuiElement} from '../input/GuiActivation';
import type {GuiActionEvent} from '../GuiTypes';

export interface GuiRadioOptions<T = string> extends GuiElementOptions {
  checked?: boolean;
  label?: string;
  group?: string;
  value?: T;
  onChange?: GuiValueChangeHandler<T>;
}

export class GuiRadio<T = string> extends GuiElement {
  private static readonly __controlIdentityGuiRadio = /* @__PURE__ */ (() => admitGuiControl(GuiRadio.prototype, 'GuiRadio', {rebuild:GuiRadio.rebuildGroupRegistry,ensure:GuiRadio.ensureGroupRegistry}, paintGuiRadio))();
  static override readonly themeControlType: string = 'GuiRadio';
  override handleAction(event: GuiActionEvent): void {
    super.handleAction(event);
    if (!event.consumed && event.action === 'confirm') activateGuiElement(this, event);
  }
  private static readonly groupRegistries = new WeakMap<GuiElement, Map<string, Set<GuiRadio<unknown>>>>();

  checked: boolean;
  label: string;
  group: string;
  value: T;
  onChange: GuiValueChangeHandler<T> | null;

  constructor(options: GuiRadioOptions<T> = {}) {
    super({ width: 120, height: 28, focus: {mode: 'all'}, ...options });
    this.checked = options.checked ?? false;
    this.label = options.label ?? '';
    this.group = options.group ?? 'default';
    this.value = (options.value ?? this.label) as T;
    this.onChange = options.onChange ?? null;
  }

  static rebuildGroupRegistry(root: GuiElement): void {
    const registry = new Map<string, Set<GuiRadio<unknown>>>();
    GuiRadio.collectGroups(root, registry);
    GuiRadio.groupRegistries.set(root, registry);
  }

  static ensureGroupRegistry(root: GuiElement): Map<string, Set<GuiRadio<unknown>>> {
    let registry = GuiRadio.groupRegistries.get(root);
    if (!registry) {
      registry = new Map();
      GuiRadio.collectGroups(root, registry);
      GuiRadio.groupRegistries.set(root, registry);
    }
    return registry;
  }

  setChecked(checked: boolean, emit = false): void {
    if (this.checked === checked) return;
    this.checked = checked;
    this.markDirty(GuiDirtyFlags.Visual | GuiDirtyFlags.Input);
    if (emit && checked) this.onChange?.(this.value);
  }

  override handleClick(event: GuiPointerEvent): void {
    super.handleClick(event);
    if (this.checked) return;
    this.uncheckGroupPeers();
    this.setChecked(true, true);
  }

  private uncheckGroupPeers(): void {
    const root = this.findRoot();
    const peers = GuiRadio.ensureGroupRegistry(root).get(this.group);
    if (!peers) return;
    for (const element of peers) {
      if (element !== this) element.setChecked(false);
    }
  }

  private findRoot(): GuiElement {
    let current: GuiElement = this;
    while (current.parent) current = current.parent;
    return current;
  }

  private static collectGroups(element: GuiElement, registry: Map<string, Set<GuiRadio<unknown>>>): void {
    if (element instanceof GuiRadio) {
      let group = registry.get(element.group);
      if (!group) {
        group = new Set();
        registry.set(element.group, group);
      }
      group.add(element);
    }
    for (const child of element.children) GuiRadio.collectGroups(child, registry);
  }
}

/** Original built-in painter; retained with this control, not every GUI owner. */
function paintGuiRadio(context:GuiPaint.GuiControlPaintContext, radio: GuiRadio, theme: GuiPaint.GuiTheme): void {
    const skin = context.styleFor(radio), r = skin.contentInsets || skin.nineSlice || skin.icon ? GuiPaint.guiContentBox(radio, 0, theme.fontSize).text : radio.rect;
    const size = Math.max(0, Math.min(18, r.height - 6, r.width - 4));
    const x = r.x + 2;
    const y = r.y + (r.height - size) * 0.5;
    const radius = size * 0.5;
    const border = GuiPaint.colorToRgba(context.styleFor(radio).borderColor, radio.focused ? theme.colors.primary : theme.colors.border);
    const fill = radio.checked ? theme.colors.primary : theme.colors.surface;
    context.addRect(x, y, size, size, radius, border);
    context.addRect(x + 2, y + 2, size - 4, size - 4, Math.max(0, radius - 2), GuiPaint.withAlpha(GuiPaint.colorToRgba(context.styleFor(radio).backgroundColor, theme.colors.surface), radio.disabled ? 0.45 : 1));
    if (radio.checked) {
      context.addRect(x + 5, y + 5, size - 10, size - 10, Math.max(0, radius - 5), GuiPaint.withAlpha(GuiPaint.colorToRgba(theme.colors.primary, fill), radio.disabled ? 0.45 : 1));
    }
    if (radio.label) {
      context.addText(radio.label, x + size + 8, r.y, Math.max(0,r.width - size - 10), r.height, theme.fontSize, GuiPaint.colorToRgba(theme.colors.text, theme.colors.text), true);
    }
  }
