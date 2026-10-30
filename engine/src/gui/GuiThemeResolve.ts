import type {GuiTheme} from './GuiTypes';
import type {GuiElement} from './components/GuiElement';
import type {GuiSkin, GuiThemeResourceBinding, GuiThemeState} from './GuiThemeTypes';

const roots = new WeakMap<GuiElement, {theme: () => GuiTheme; changed: (element: GuiElement) => void; active: () => boolean}>();
export function bindGuiThemeRoot(root: GuiElement, theme: () => GuiTheme, changed: (element: GuiElement) => void, active: () => boolean): () => void {
  const binding = {theme, changed, active}; roots.set(root, binding);
  return () => {if (roots.get(root) === binding) roots.delete(root);};
}
export function guiThemeTreeActive(root: GuiElement): boolean {return roots.get(root)?.active() ?? false;}
export function notifyGuiThemeTree(parent: GuiElement, changed = parent): void {
  let root = parent;
  while (root.parent) root = root.parent;
  roots.get(root)?.changed(changed);
}

export function guiThemeState(element: GuiElement): GuiThemeState {
  return {hover: element.hovered, focus: element.focused, pressed: element.pressed, disabled: element.disabled};
}

function assign(target: GuiSkin, source: GuiSkin): void {
  for (const [key, value] of Object.entries(source)) if (value !== undefined) Object.assign(target, {[key]: key === 'palette' ? {...target.palette, ...source.palette} : value});
}

/** Resolve inheritance without projecting into the caller's mutable local style object. */
export function resolveGuiSkin(element: GuiElement, state: GuiThemeState = guiThemeState(element)): GuiSkin {
  const inherited: GuiThemeResourceBinding[] = [];
  let root = element;
  for (let parent = element.parent; parent; parent = parent.parent) {
    root = parent;
    if (parent.themeResource) inherited.unshift(parent.themeResource);
  }
  const parent = element.parent && guiThemeTreeActive(root) ? element.parent.getResolvedStyle() : undefined;
  const result: GuiSkin = {...(parent?.fontFamily !== undefined ? {fontFamily: parent.fontFamily} : {}), ...(parent?.fontSize !== undefined ? {fontSize: parent.fontSize} : {})};
  const type = element.themeControlType;
  for (const resource of inherited) assign(result, resource.resolve('*', state));
  for (const resource of inherited) assign(result, resource.resolve(type, state));
  if (element.themeResource) {
    assign(result, element.themeResource.resolve('*', state));
    assign(result, element.themeResource.resolve(type, state));
  }
  assign(result, element.style);
  return result;
}

export function resolveGuiTheme(element: GuiElement, base: GuiTheme): GuiTheme {
  const skin = resolveGuiSkin(element);
  return {...base, fontFamily: skin.fontFamily ?? base.fontFamily, fontSize: skin.fontSize ?? base.fontSize};
}
