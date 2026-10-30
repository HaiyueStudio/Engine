import {GuiDirtyFlags, type GuiTheme} from './GuiTypes';
import type {GuiElement} from './components/GuiElement';
import type {GuiSkin, GuiThemeResourceBinding} from './GuiThemeTypes';
import {bindGuiThemeRoot, resolveGuiSkin} from './GuiThemeResolve';

const identities = new WeakMap<object, number>();
let identity = 0;
function id(value: object | null | undefined): number {
  if (!value) return 0;
  let result = identities.get(value);
  if (result === undefined) {result = ++identity; identities.set(value, result);}
  return result;
}
function metrics(skin: GuiSkin): string {
  const icon = skin.icon, insets = skin.contentInsets ?? skin.nineSlice?.contentInsets;
  return JSON.stringify([skin.fontFamily, skin.fontSize, skin.padding, skin.iconSize, skin.iconGap, id(icon),
    icon && 'naturalWidth' in icon ? icon.naturalWidth : icon && 'width' in icon ? icon.width : 0,
    icon && 'naturalHeight' in icon ? icon.naturalHeight : icon && 'height' in icon ? icon.height : 0,
    insets, skin.nineSlice?.cuts, skin.nineSlice?.pixelRatio]);
}
function same(a: GuiSkin, b: GuiSkin): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => key === 'palette' ? JSON.stringify(a.palette) === JSON.stringify(b.palette) : Object.is(a[key as keyof GuiSkin], b[key as keyof GuiSkin]));
}

/** One root owns subscriptions; resources and user textures remain borrowed. */
export class GuiThemeOwner {
  private readonly subscriptions = new Map<GuiThemeResourceBinding, () => void>();
  private snapshots = new Map<GuiElement, {skin: GuiSkin; metrics: string}>();
  private readonly unbind: () => void;
  private readonly unobserve: () => void;
  private syncing = false;
  private active = false;
  private destroyed = false;
  private palette: string;

  constructor(private readonly root: GuiElement, private readonly theme: () => GuiTheme,
      observe: (changed: () => void) => () => void) {
    this.palette = this.paletteKey();
    this.unbind = bindGuiThemeRoot(root, theme, element => {if (this.active || hasTheme(element)) this.sync(true);}, () => this.active);
    this.unobserve = observe(() => {if (this.active) this.sync();});
    this.sync(true);
  }

  sync(force = false): void {
    if (this.destroyed || this.syncing) return;
    if (!this.active && !force) {
      const palette = this.paletteKey();
      if (palette !== this.palette) {this.palette = palette; this.root.markDirty(GuiDirtyFlags.Visual);}
      return;
    }
    this.syncing = true;
    try {
      const resources = new Set<GuiThemeResourceBinding>(), next = new Map<GuiElement, {skin: GuiSkin; metrics: string}>();
      const changes: {element: GuiElement; flags: GuiDirtyFlags}[] = [];
      const pending = [{element: this.root, depth: 1}];
      while (pending.length) {
        const {element, depth} = pending.pop()!;
        if (depth > 128 || next.size >= 10_000 || next.has(element)) throw new Error('GUI theme tree exceeds the shared bounds or contains a cycle.');
        if (element.themeResource) resources.add(element.themeResource);
        const skin = resolveGuiSkin(element), key = metrics(skin), previous = this.snapshots.get(element);
        next.set(element, {skin, metrics: key});
        if (previous && (key !== previous.metrics || !same(skin, previous.skin))) changes.push({element, flags: GuiDirtyFlags.Visual | (key !== previous.metrics ? GuiDirtyFlags.Layout | GuiDirtyFlags.Text : GuiDirtyFlags.None)});
        for (const child of [...element.children].reverse()) pending.push({element: child, depth: depth + 1});
      }
      for (const [resource, release] of this.subscriptions) if (!resources.has(resource)) {release(); this.subscriptions.delete(resource);}
      for (const resource of resources) if (!this.subscriptions.has(resource)) this.subscriptions.set(resource, resource.subscribe(() => this.sync()));
      this.snapshots = next;
      this.active = resources.size > 0 || [...next.keys()].some(hasLocalTheme);
      const palette = this.paletteKey();
      if (palette !== this.palette) {this.palette = palette; changes.push({element: this.root, flags: GuiDirtyFlags.Visual});}
      for (const {element, flags} of changes) element.markDirty(flags);
    } finally {this.syncing = false;}
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unobserve(); this.unbind();
    const errors: unknown[] = [];
    for (const release of this.subscriptions.values()) {try {release();} catch (error) {errors.push(error);}}
    this.subscriptions.clear(); this.snapshots.clear();
    if (errors.length) throw new AggregateError(errors, 'GUI theme subscription cleanup failed.');
  }

  private paletteKey(): string {const theme = this.theme(); return JSON.stringify([theme.radius, theme.colors]);}
}

function hasLocalTheme(element: GuiElement): boolean {
  return element.themeControlType === 'GuiNineSlice' || ['fontFamily', 'fontSize', 'icon', 'iconSize', 'contentInsets', 'nineSlice'].some(key => key in element.style);
}
function hasTheme(element: GuiElement): boolean {
  return !!element.themeResource || hasLocalTheme(element) || element.children.some(hasTheme);
}
