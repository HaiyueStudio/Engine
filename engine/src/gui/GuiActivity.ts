import type {GuiElement} from './components/GuiElement';
import {GuiDirtyFlags} from './GuiTypes';
import {guiElementTheme} from './GuiThemeResolve';
import {guiControlPrototype} from './GuiControlIdentity';
import {isGuiLayoutHidden} from './GuiLayoutState';
const activities = new WeakMap<GuiElement,{tick:(deltaMs:number)=>boolean|void;motion:boolean}>();
/** One callback lease on the original GUI frame clock. Hidden ancestors pause it. */
export function setGuiActivity(element:GuiElement,tick:((deltaMs:number)=>boolean|void)|null,options:Readonly<{motion?:boolean}>={}):()=>void {
  if(tick!==null&&typeof tick!=='function')throw new TypeError('Invalid GUI activity callback.');
  if(options.motion!==undefined&&typeof options.motion!=='boolean')throw new TypeError('Invalid GUI activity policy.');
  const lease=tick?{tick,motion:options.motion??true}:undefined;if(lease)activities.set(element,lease);else activities.delete(element);
  element.markDirty(GuiDirtyFlags.Visual);
  return ()=>{if(lease&&activities.get(element)===lease){activities.delete(element);element.markDirty(GuiDirtyFlags.Visual);}};
}
export function guiHasActivity(element:GuiElement):boolean{
  const lease=activities.get(element);if(!lease||lease.motion&&guiElementTheme(element)?.motionScale===0)return false;
  return guiElementVisible(element);
}
/** Shared visibility predicate; it does not install an activity or another observer. */
export function guiElementVisible(element:GuiElement):boolean{
  const r=element.rect;
  for(let node:GuiElement|null=element;node;node=node.parent){if(!node.visible||node.disabled||isGuiLayoutHidden(node))return false;
    if(node!==element&&(!node.parent||guiControlPrototype(Object.getPrototypeOf(node) as object)==='GuiScrollView'||node.style.clipRadius!==undefined)){const clip=node.rect;if(clip.width>0&&clip.height>0&&(r.x+r.width<=clip.x||r.y+r.height<=clip.y||r.x>=clip.x+clip.width||r.y>=clip.y+clip.height))return false;}}
  return true;
}
export function advanceGuiActivity(element:GuiElement,deltaMs:number):void {
  const lease=activities.get(element);if(!lease||!guiHasActivity(element))return;
  let keep:boolean|void;
  try{keep=lease.tick(Number.isFinite(deltaMs)?Math.min(100,Math.max(0,deltaMs))*(lease.motion?guiElementTheme(element)?.motionScale??1:1):0);}catch(error){if(activities.get(element)===lease)activities.delete(element);throw error;}
  if(keep===false&&activities.get(element)===lease)activities.delete(element);
}
