import { GuiDirtyFlags, GuiElementOptions, GuiPointerEvent, GuiValueChangeHandler } from '../GuiTypes';
import { GuiElement } from './GuiElement';

export interface GuiRadioOptions<T = string> extends GuiElementOptions {
  checked?: boolean;
  label?: string;
  group?: string;
  value?: T;
  onChange?: GuiValueChangeHandler<T>;
}

export class GuiRadio<T = string> extends GuiElement {
  private static readonly groupRegistries = new WeakMap<GuiElement, Map<string, Set<GuiRadio<unknown>>>>();

  checked: boolean;
  label: string;
  group: string;
  value: T;
  onChange: GuiValueChangeHandler<T> | null;

  constructor(options: GuiRadioOptions<T> = {}) {
    super({ width: 120, height: 28, ...options });
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
