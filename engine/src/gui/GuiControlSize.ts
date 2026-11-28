import type {GuiElement} from './components/GuiElement';
import type {GuiElementOptions,GuiLength} from './GuiTypes';
import {guiElementTheme} from './GuiThemeResolve';
const sizes=new WeakMap<GuiElement, {height:number; density:GuiElementOptions['density']}>();
export function registerGuiControlSize(element:GuiElement,options:GuiElementOptions,defaultHeight:number):void {
  if(options.height===undefined)sizes.set(element,{height:defaultHeight,density:options.density});
}
export function guiControlHeight(element:GuiElement,height:GuiLength):GuiLength {
  const size=sizes.get(element);if(!size||height!==size.height)return height;
  const density=size.density??guiElementTheme(element)?.density;
  if(!density)return height;
  return Math.max(20,size.height+(density==='compact'?-6:density==='touch'?10:0));
}
