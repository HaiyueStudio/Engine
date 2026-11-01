import type {GuiElement} from './components/GuiElement';

// Private coordination over the original emitter. These are not package exports.
export const collectionRetire = 'gui:collection-retire';
export const collectionFocus = 'gui:collection-focus';
export const collectionFocused = 'gui:collection-focused';
export function notifyGuiCollection(element:GuiElement,event:string):void {
  const path:GuiElement[]=[];
  for(let node:GuiElement|null=element;node;node=node.parent)path.unshift(node);
  element.emit(event,{target:element,path,bubbles:true});
}
