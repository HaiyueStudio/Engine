import type {GuiTheme} from './GuiTypes';
import type {GuiElement} from './components/GuiElement';
import type {GuiSkin, GuiThemeResourceBinding, GuiThemeState} from './GuiThemeTypes';
import {guiStyleLayer, mergeGuiStyle} from './GuiStyleLayers';
import {guiControlDefaultSkin,type GuiDefaultSkinCache} from './GuiControlIdentity';
import {DEFAULT_GUI_THEME} from './GuiTypes';

const visualStates = new WeakMap<GuiElement, Partial<GuiThemeState>>();
const defaultSkins = new WeakMap<GuiElement, {resolve:(theme:Readonly<GuiTheme>,state:GuiThemeState)=>GuiSkin}>();
export function guiDefaultSkinBinding(element:GuiElement):object|undefined {return defaultSkins.get(element);}
/** An extension's defaults occupy the same layer as stock skins, below resources and local overrides. */
export function bindGuiDefaultSkin(element:GuiElement,resolve:((theme:Readonly<GuiTheme>,state:GuiThemeState)=>GuiSkin)|null):()=>void {
  if(resolve!==null&&typeof resolve!=='function')throw new TypeError('Invalid GUI default skin provider.');
  const binding=resolve?{resolve}:undefined;
  if(binding)defaultSkins.set(element,binding);else defaultSkins.delete(element);
  notifyGuiThemeTree(element);
  return()=>{if(binding&&defaultSkins.get(element)===binding){defaultSkins.delete(element);notifyGuiThemeTree(element);}};
}
const partOwners = new WeakMap<GuiElement, {owner: GuiElement; name: string}>();
export function guiPartOwner(element: GuiElement): {owner: GuiElement; name: string} | undefined {return partOwners.get(element);}
export function releaseDetachedGuiParts(element:GuiElement):void {
  const pending=[element],seen=new Set<GuiElement>();while(pending.length){const node=pending.pop()!;if(seen.has(node)||seen.size>=10000)throw new TypeError('Invalid GUI part subtree.');seen.add(node);const part=partOwners.get(node);if(part){let attached=false;for(let parent=node.parent;parent;parent=parent.parent)if(parent===part.owner){attached=true;break;}if(!attached)partOwners.delete(node);}pending.push(...node.children);}
}
export function setGuiVisualState(element: GuiElement, state: Partial<GuiThemeState>): boolean {
  if (Object.entries(state).some(([key,value]) => !['checked','selected','invalid','loading','readOnly','open'].includes(key) || typeof value !== 'boolean')) throw new TypeError('Invalid GUI visual state.');
  const previous=visualStates.get(element);
  if(Object.entries(state).every(([key,value])=>previous?.[key as keyof GuiThemeState]===value))return false;
  visualStates.set(element, {...previous, ...state});return true;
}
export function bindGuiPart(owner: GuiElement, name: string, child: GuiElement): () => void {
  if (!name || ['__proto__','constructor','prototype'].includes(name) || owner === child) throw new TypeError('Invalid GUI part binding.');
  for (let node: GuiElement | null = owner; node; node = node.parent) if (node === child) throw new TypeError('A GUI part must be a descendant.');
  const binding = {owner, name}; partOwners.set(child, binding); notifyGuiThemeTree(owner);
  return () => {if (partOwners.get(child) === binding) {partOwners.delete(child); notifyGuiThemeTree(child);}};
}
export function resolveGuiPart(element: GuiElement, name: string, overrides: Partial<GuiThemeState> = {}): GuiSkin {
  return guiStyleLayer(resolveGuiSkin(element).parts?.[name] ?? {}, {...guiThemeState(element), ...overrides});
}

const roots = new WeakMap<GuiElement, {theme: () => GuiTheme; changed: (element: GuiElement) => void; active: () => boolean; snapshot?: (element:GuiElement)=>GuiSkin|undefined}>();
interface ThemeProof {readonly prototype:object;readonly resolve:GuiThemeResourceBinding['resolve'];readonly version:(()=>unknown)|undefined;}
const builtins=new WeakMap<GuiThemeResourceBinding,ThemeProof>();
/** Built-in instances register themselves; default GUI consumers need no resource-class import. */
export function registerGuiThemeResource(resource:GuiThemeResourceBinding,proof:ThemeProof):void {builtins.set(resource,proof);}
export function guiThemeResourceVersion(resource:GuiThemeResourceBinding):number|undefined {
  const proof=builtins.get(resource);
  if(!proof||Object.getPrototypeOf(resource)!==proof.prototype||resource.resolve!==proof.resolve||Object.hasOwn(resource,'version')||Object.getOwnPropertyDescriptor(proof.prototype,'version')?.get!==proof.version)return;
  return resource.version;
}
export function bindGuiThemeRoot(root: GuiElement, theme: () => GuiTheme, changed: (element: GuiElement) => void, active: () => boolean, snapshot?: (element:GuiElement)=>GuiSkin|undefined): () => void {
  const binding = {theme, changed, active, ...(snapshot ? {snapshot} : {})}; roots.set(root, binding);
  return () => {if (roots.get(root) === binding) roots.delete(root);};
}
export function guiThemeTreeActive(root: GuiElement): boolean {return roots.get(root)?.active() ?? false;}
export function guiElementTheme(element:GuiElement):GuiTheme|undefined {let root=element;while(root.parent)root=root.parent;return roots.get(root)?.theme();}
/** Retained paint reads only the theme owner's synchronized snapshot; public resolution stays live. */
export function guiThemePaintSnapshot(element:GuiElement):GuiSkin|undefined {let root=element;while(root.parent)root=root.parent;return roots.get(root)?.snapshot?.(element);}
export function notifyGuiThemeTree(parent: GuiElement, changed = parent): void {
  let root = parent;
  while (root.parent) root = root.parent;
  roots.get(root)?.changed(changed);
}

export function guiThemeState(element: GuiElement): GuiThemeState {
  const result={hover: element.hovered, focus: element.focused, pressed: element.pressed, disabled: element.disabled,...visualStates.get(element)};
  for(const key of ['checked','readOnly','loading','open'] as const)if(Object.hasOwn(element,key)){const field=Object.getOwnPropertyDescriptor(element,key);if(field&&'value'in field&&typeof field.value==='boolean')result[key]=field.value;}
  return result;
}

function assign(target: GuiSkin, source: GuiSkin): void {
  mergeGuiStyle(target, source);
}

/** Resolve inheritance without projecting into the caller's mutable local style object. */
export function resolveGuiSkin(element: GuiElement, state: GuiThemeState = guiThemeState(element), defaults?:GuiDefaultSkinCache): GuiSkin {
  const inherited: GuiThemeResourceBinding[] = [];
  let root = element;
  for (let parent = element.parent; parent; parent = parent.parent) {
    root = parent;
    if (parent.themeResource) inherited.unshift(parent.themeResource);
  }
  const parent = element.parent && guiThemeTreeActive(root) ? element.parent.getResolvedStyle() : undefined;
  const result: GuiSkin = {...(parent?.fontFamily !== undefined ? {fontFamily: parent.fontFamily} : {}), ...(parent?.fontSize !== undefined ? {fontSize: parent.fontSize} : {}), ...(parent?.fontWeight !== undefined ? {fontWeight: parent.fontWeight} : {}), ...(parent?.lineHeight !== undefined ? {lineHeight: parent.lineHeight} : {})};
  const apply=(skin:GuiSkin)=>assign(result,guiStyleLayer(skin,state));
  const type = element.themeControlType;
  apply(guiControlDefaultSkin(element, roots.get(root)?.theme() ?? DEFAULT_GUI_THEME, state,defaults));
  const extension=defaultSkins.get(element);
  if(extension)apply(extension.resolve(roots.get(root)?.theme()??DEFAULT_GUI_THEME,state));
  for (const resource of inherited) apply(resource.resolve('*', state));
  for (const resource of inherited) apply(resource.resolve(type, state));
  if (element.themeResource) {
    apply(element.themeResource.resolve('*', state));
    apply(element.themeResource.resolve(type, state));
  }
  const part = partOwners.get(element);
  if (part) {for (let node = element.parent; node; node = node.parent) if (node === part.owner) {assign(result, resolveGuiPart(part.owner, part.name)); break;}}
  assign(result, guiStyleLayer(element.style, state));
  const label=guiStyleLayer(result.parts?.label??{},state);
  for(const key of ['fontFamily','fontSize','fontWeight','lineHeight','textOverflow'] as const)if(label[key]!==undefined&&element.style[key]===undefined)(result as Record<string,unknown>)[key]=label[key];
  return result;
}

export function resolveGuiTheme(element: GuiElement, base: GuiTheme): GuiTheme {
  const skin = resolveGuiSkin(element);
  return {...base, fontFamily: skin.fontFamily ?? base.fontFamily, fontSize: skin.fontSize ?? base.fontSize,
    ...(skin.fontWeight !== undefined ? {fontWeight: skin.fontWeight} : {}), ...(skin.lineHeight !== undefined ? {lineHeight: skin.lineHeight} : {})};
}
