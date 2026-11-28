import {GuiDirtyFlags, type GuiTheme} from './GuiTypes';
import {GuiElement} from './components/GuiElement';
import type {GuiSkin, GuiThemeResourceBinding} from './GuiThemeTypes';
import {bindGuiThemeRoot, resolveGuiSkin, guiThemeState, guiThemeResourceVersion, guiPartOwner,guiDefaultSkinBinding} from './GuiThemeResolve';
import type {GuiInvalidation} from './GuiLayoutTypes';
import {guiStyleStateOrder, guiStyleLayer, sameGuiStyleValue} from './GuiStyleLayers';
import type {GuiThemeState} from './GuiThemeTypes';
import {guiPaintOnly,guiStateOnly,guiTextContentOnly,markGuiPaintDirty,sameGuiInputs} from './GuiInvalidationState';

const identities = new WeakMap<object, number>();
let identity = 0;
function id(value: object | null | undefined): number {
  if (!value) return 0;
  let result = identities.get(value);
  if (result === undefined) {result = ++identity; identities.set(value, result);}
  return result;
}
function metrics(skin: GuiSkin,state:GuiThemeState): string {
  const icon = skin.icon, insets = skin.contentInsets ?? skin.nineSlice?.contentInsets;
  const part=guiStyleLayer(skin.parts?.icon??{},state);
  return JSON.stringify([skin.fontFamily, skin.fontSize, skin.fontWeight, skin.lineHeight, skin.padding, skin.paddingY, skin.iconSize, skin.iconGap, skin.iconPosition, id(icon),
    icon && 'naturalWidth' in icon ? icon.naturalWidth : icon && 'width' in icon ? icon.width : 0,
    icon && 'naturalHeight' in icon ? icon.naturalHeight : icon && 'height' in icon ? icon.height : 0,
    insets, skin.nineSlice?.cuts, skin.nineSlice?.pixelRatio,part.iconSize,part.iconGap,part.iconPosition]);
}
function same(a: GuiSkin, b: GuiSkin): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(key => ['palette','parts','states','cornerRadii','shadow','gradient'].includes(key) ? sameGuiStyleValue(a[key as keyof GuiSkin],b[key as keyof GuiSkin]) : Object.is(a[key as keyof GuiSkin], b[key as keyof GuiSkin]));
}

/** One root owns subscriptions; resources and user textures remain borrowed. */
export class GuiThemeOwner {
  private readonly subscriptions = new Map<GuiThemeResourceBinding, () => void>();
  private snapshots = new Map<GuiElement, {skin: GuiSkin; metrics: string; inputs?: readonly unknown[]}>();
  private readonly unbind: () => void;
  private readonly unobserve: () => void;
  private syncing = false;
  private active = false;
  private destroyed = false;
  private palette: string;
  private themeMetrics: string;

  constructor(private readonly root: GuiElement, private readonly theme: () => GuiTheme,
      observe: (changed: (change:GuiInvalidation) => void) => () => void) {
    this.palette = this.paletteKey();
    this.themeMetrics = this.metricsKey();
    this.unbind = bindGuiThemeRoot(root, theme, element => {if (this.active || hasTheme(element)) this.sync(true);}, () => this.active, element => this.snapshots.get(element)?.skin);
    this.unobserve = observe(change => {if (this.active&&(guiStateOnly(change)||!guiPaintOnly(change)&&!guiTextContentOnly(change))) this.sync();});
    this.sync(true);
  }

  sync(force = false): void {
    if (this.destroyed || this.syncing) return;
    if (this.paletteKey() !== this.palette && this.active) force = true;
    if (!this.active && !force) {
      const palette = this.paletteKey();
      if (palette !== this.palette) {const metrics=this.metricsKey(),changed=metrics!==this.themeMetrics;this.palette = palette;this.themeMetrics=metrics;this.root.markDirty(GuiDirtyFlags.Visual|(changed?GuiDirtyFlags.Layout|GuiDirtyFlags.Text:GuiDirtyFlags.None));}
      return;
    }
    if (!this.active && force) this.active = hasTheme(this.root);
    this.syncing = true;
    try {
      const resources = new Set<GuiThemeResourceBinding>(), next = new Map<GuiElement, {skin: GuiSkin; metrics: string; inputs?: readonly unknown[]}>();
      const changes: {element: GuiElement; flags: GuiDirtyFlags; paintOnly?: boolean}[] = [];
      const pending = [{element: this.root, depth: 1}];
      while (pending.length) {
        const {element, depth} = pending.pop()!;
        if (depth > 128 || next.size >= 10_000 || next.has(element)) throw new Error('GUI theme tree exceeds the shared bounds or contains a cycle.');
        if (element.themeResource) resources.add(element.themeResource);
        const previous = this.snapshots.get(element), inputs = themeInputs(element, element.parent ? next.get(element.parent)?.skin : undefined);
        if (!force && previous && sameGuiInputs(previous.inputs,inputs)) next.set(element,previous);
        else {
          const skin = this.resolveSkin(element), key = metrics(skin,guiThemeState(element)), changed = !previous || !same(skin,previous.skin), cacheable = inputs && plainSkin(skin);
          next.set(element, {skin: changed ? skin : previous.skin, metrics: key, ...(cacheable ? {inputs} : {})});
          if (previous && (key !== previous.metrics || changed)) changes.push({element, flags: GuiDirtyFlags.Visual | (key !== previous.metrics ? GuiDirtyFlags.Layout | GuiDirtyFlags.Text : GuiDirtyFlags.None), paintOnly: !force && !!previous.inputs && !!cacheable});
        }
        for (const child of [...element.children].reverse()) pending.push({element: child, depth: depth + 1});
      }
      for (const [resource, release] of this.subscriptions) if (!resources.has(resource)) {release(); this.subscriptions.delete(resource);}
      for (const resource of resources) if (!this.subscriptions.has(resource)) this.subscriptions.set(resource, resource.subscribe(() => this.sync(true)));
      this.snapshots = next;
      this.active = resources.size > 0 || [...next.keys()].some(hasLocalTheme);
      const palette = this.paletteKey();
      if (palette !== this.palette) {const metrics=this.metricsKey(),changed=metrics!==this.themeMetrics;this.palette = palette;this.themeMetrics=metrics; changes.push({element: this.root, flags: GuiDirtyFlags.Visual|(changed?GuiDirtyFlags.Layout|GuiDirtyFlags.Text:GuiDirtyFlags.None)});}
      for (const {element, flags, paintOnly} of changes) if(flags===GuiDirtyFlags.Visual&&paintOnly)markGuiPaintDirty(element);else element.markDirty(flags);
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

  private paletteKey(): string {return JSON.stringify(this.theme());}
  private metricsKey():string {const theme=this.theme();return JSON.stringify([theme.fontFamily,theme.fontSize,theme.fontWeight,theme.lineHeight,theme.density,theme.spacing]);}
  private resolveSkin(element:GuiElement):GuiSkin {return resolveGuiSkin(element);}
}

function hasLocalTheme(element: GuiElement): boolean {
  return !!guiDefaultSkinBinding(element)||!!guiPartOwner(element) || element.themeControlType === 'GuiNineSlice' || ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'states', 'parts', 'icon', 'iconSize', 'iconGap', 'iconPosition', 'contentInsets', 'nineSlice'].some(key => key in element.style);
}
function hasTheme(element: GuiElement): boolean {
  const pending=[{element,depth:1}],seen=new Set<GuiElement>();
  while(pending.length){const {element:node,depth}=pending.pop()!;if(depth>128||seen.size>=10000||seen.has(node))throw new Error('GUI theme tree exceeds the shared bounds or contains a cycle.');seen.add(node);if(node.themeResource||hasLocalTheme(node))return true;for(const child of node.children)pending.push({element:child,depth:depth+1});}
  return false;
}

// Only ordinary data can be fingerprinted. Borrowed skins and custom live getters retain full resolution.
function plainValues(value:object,depth=0,seen=new Set<object>()):unknown[]|undefined {
  if(depth>16||seen.has(value))return;seen.add(value);
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null&&!Array.isArray(value))return;
  const result:unknown[]=[];
  for(const [key,d]of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!('value'in d))return;const v:unknown=d.value;
    if(v&&typeof v==='object'){const nested=plainValues(v,depth+1,seen);if(!nested)return;result.push(key,...nested,'/');}
    else {if(v!==undefined&&typeof v!=='string'&&typeof v!=='number'&&typeof v!=='boolean')return;result.push(key,v);}
  }
  seen.delete(value);return result;
}
function plainSkin(skin:GuiSkin):boolean{return !skin.icon&&!skin.nineSlice&&!skin.contentInsets;}
function themeInputs(element:GuiElement,parent:GuiSkin|undefined):readonly unknown[]|undefined {
  const style=plainValues(element.style);if(!style)return;
  const state=guiThemeState(element),part=guiPartOwner(element),result:unknown[]=[...style,guiDefaultSkinBinding(element),parent?.fontFamily,parent?.fontSize,parent?.fontWeight,parent?.lineHeight,...guiStyleStateOrder.map(key=>state[key])];
  if(part){const values=plainValues(part.owner.getPartStyle(part.name));if(!values)return;result.push(part.owner,part.name,...values);}
  for(let node:GuiElement|null=element;node;node=node.parent){
    const style=Object.getOwnPropertyDescriptor(node,'style');
    if(node.getResolvedStyle!==GuiElement.prototype.getResolvedStyle||style&&!('value'in style)||node!==element&&!plainValues(node.style))return;
    if(node.themeResource){const r=node.themeResource,version=guiThemeResourceVersion(r);if(version===undefined)return;result.push(r,version);}
  }
  return result;
}
