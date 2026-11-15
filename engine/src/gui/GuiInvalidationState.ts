import type {GuiElement} from './components/GuiElement';
import type {GuiInvalidation} from './GuiLayoutTypes';
import {GuiDirtyFlags} from './GuiTypes';

const enum Change {Unknown=0,Paint=1,TextContent=2,LayoutStyle=3}
const current=new WeakMap<GuiElement,Change>(),manualStable=new WeakSet<GuiElement>(),metricsDirty=new WeakSet<GuiElement>();
const structureChanges=new WeakMap<GuiElement,number>();
const notifications=new WeakMap<GuiInvalidation,Change>();
export const GUI_TEXT_LAYOUT_POLICY=/* @__PURE__ */ Symbol.for('haiyue.gui.text-layout-policy.v1');
export const GUI_LAYOUT_STYLE_MUTATION=/* @__PURE__ */ Symbol.for('haiyue.gui.layout-style-mutation.v1');
export function consumeGuiChange(element:GuiElement):number {const kind=current.get(element)??Change.Unknown;current.delete(element);return kind;}
export function consumeGuiStructureChange(element:GuiElement):number|undefined {const version=structureChanges.get(element);structureChanges.delete(element);return version;}
export function markGuiStructureDirty(element:GuiElement,version:number):void {
  const before=structureChanges.get(element);structureChanges.set(element,version);
  try{element.markDirty(GuiDirtyFlags.Children|GuiDirtyFlags.Layout);}finally{if(before===undefined)structureChanges.delete(element);else structureChanges.set(element,before);}
}
export function guiTextContentChange(kind:number):boolean {return kind===Change.TextContent;}
export function guiLocalChange(kind:number):boolean {return kind===Change.Paint||kind===Change.TextContent;}
export function rememberGuiInvalidation(change:GuiInvalidation,kind:number):void {notifications.set(change,kind);}
export function guiPaintOnly(change:GuiInvalidation):boolean {return notifications.get(change)===Change.Paint;}
export function guiTextContentOnly(change:GuiInvalidation):boolean {return notifications.get(change)===Change.TextContent;}
export function guiLayoutStyleOnly(change:GuiInvalidation):boolean {return notifications.get(change)===Change.LayoutStyle;}
export function guiLayoutStyleChange():number {return Change.LayoutStyle;}
export function noteGuiTextDirty(element:GuiElement,flags:GuiDirtyFlags,kind:number):void {
  if(flags&GuiDirtyFlags.Text&&kind!==Change.TextContent)metricsDirty.add(element);
}
export function clearGuiTextDirty(element:GuiElement):void {manualStable.delete(element);metricsDirty.delete(element);}
export function guiTextNeedsCoordinates(element:GuiElement):boolean {return metricsDirty.has(element)||!manualStable.has(element);}
function mark(element:GuiElement,flags:GuiDirtyFlags,kind:Change):void {
  const before=current.get(element);current.set(element,kind);
  try{element.markDirty(flags);}finally{if(before===undefined)current.delete(element);else current.set(element,before);}
}
export function markGuiPaintDirty(element:GuiElement):void {mark(element,GuiDirtyFlags.Visual,Change.Paint);}
/** Only stock leaf painters opt in; custom layout/skin code keeps conservative invalidation. */
export function guiStockTextControl(element:GuiElement,prototype:GuiElement,base:GuiElement):boolean {
  if(Object.getPrototypeOf(element)!==prototype||element.markDirty!==base.markDirty||element.layout!==prototype.layout||element.getResolvedStyle!==base.getResolvedStyle||element.getContentRect!==base.getContentRect||element.getLayoutOptions!==base.getLayoutOptions)return false;
  for(const key of ['style','width','height','text','value']){const descriptor=Object.getOwnPropertyDescriptor(element,key);if(descriptor&&!('value' in descriptor))return false;}
  const style=element.style,stylePrototype=Object.getPrototypeOf(style);
  return (stylePrototype===Object.prototype||stylePrototype===null)&&Object.values(Object.getOwnPropertyDescriptors(style)).every(descriptor=>'value' in descriptor);
}
export function markGuiTextContentDirty(element:GuiElement,base:GuiElement,ownSizeStable:boolean):void {
  let stable=ownSizeStable&&element.children.length===0;
  for(let parent=element.parent;stable&&parent;parent=parent.parent)stable=Object.getPrototypeOf(parent)===base&&parent.layout===base.layout&&parent.getContentRect===base.getContentRect&&parent.getResolvedStyle===base.getResolvedStyle;
  if(stable)manualStable.add(element);else manualStable.delete(element);
  mark(element,GuiDirtyFlags.Text|GuiDirtyFlags.Visual,Change.TextContent);
}
