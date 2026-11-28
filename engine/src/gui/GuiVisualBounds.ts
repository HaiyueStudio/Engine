import type {GuiRect,GuiStyle} from './GuiTypes';
import {GuiElement} from './components/GuiElement';
import {guiThemePaintSnapshot} from './GuiThemeResolve';
interface Bounds {bounds:GuiRect;inputs:readonly unknown[];simple:boolean;snapshot:unknown;}
const previous = new WeakMap<GuiElement,Bounds>();
function shadowOutsets(style:Readonly<GuiStyle>,floor=0):{left:number;right:number;top:number;bottom:number}{const shadow=style.shadow,reach=shadow?Math.max(0,shadow.blur+(shadow.spread??0)):0;return{left:Math.max(floor,reach-(shadow?.x??0)),right:Math.max(floor,reach+(shadow?.x??0)),top:Math.max(floor,reach-(shadow?.y??0)),bottom:Math.max(floor,reach+(shadow?.y??0))};}
function popupRects(element:GuiElement):readonly GuiRect[]{const rects='tooltipRects'in element?element.tooltipRects as readonly GuiRect[]:[];if(!rects.length)return rects;const {left,right,top,bottom}=shadowOutsets(element.getPartStyle('tooltip'),12);return rects.map(rect=>({x:rect.x-left,y:rect.y-top,width:rect.width+left+right,height:rect.height+top+bottom}));}
function inputs(element:GuiElement):readonly unknown[] {const r=element.rect,s=element.style,shadow=s.shadow;return [r.x,r.y,r.width,r.height,element.focused,element.disabled,s.focusWidth,shadow?.blur,shadow?.spread,shadow?.x,shadow?.y,s.iconRotation,s.icon,'helpText'in element?element.helpText:undefined,guiThemePaintSnapshot(element),...popupRects(element).flatMap(p=>[p.x,p.y,p.width,p.height])];}
export function guiVisualBounds(element:GuiElement,style:Readonly<GuiStyle>=element.getResolvedStyle(),rect:GuiRect=element.rect):GuiRect {
  const focus=element.focused&&!element.disabled?Math.max(0,style.focusWidth??0)+2:0,{left,right,top,bottom:shadowBottom}=shadowOutsets(style,focus),bottom=Math.max(shadowBottom,('helpText'in element&&element.helpText)?22:0);
  let x=rect.x-left,y=rect.y-top,endX=rect.x+rect.width+right,endY=rect.y+rect.height+bottom;
  if(style.iconRotation&&style.icon){const extent=Math.hypot(rect.width,rect.height);x-=extent;y-=extent;endX+=extent;endY+=extent;}
  for(const popup of popupRects(element)){x=Math.min(x,popup.x);y=Math.min(y,popup.y);endX=Math.max(endX,popup.x+popup.width);endY=Math.max(endY,popup.y+popup.height);}
  return {x,y,width:endX-x,height:endY-y};
}
export function rememberGuiVisualBounds(element:GuiElement,style:Readonly<GuiStyle>):void {
  const simple=!style.shadow&&!element.focused&&!style.iconRotation&&!('tooltipRects'in element)&&!('helpText'in element&&element.helpText),snapshot=guiThemePaintSnapshot(element);
  previous.set(element,{bounds:simple?{...element.rect}:guiVisualBounds(element,style),inputs:simple?[]:inputs(element),simple,snapshot});
}
export function guiVisualDamage(element:GuiElement):{before:GuiRect;after:GuiRect} {
  const cached=previous.get(element),plain=element.getResolvedStyle===GuiElement.prototype.getResolvedStyle,s=element.style;
  if(cached?.simple&&plain&&!element.focused&&!s.shadow&&!s.iconRotation&&!s.states&&!s.parts&&!('tooltipRects'in element)&&!('helpText'in element&&element.helpText)&&guiThemePaintSnapshot(element)===cached.snapshot){
    const r=element.rect,before=cached.bounds;if(r.x===before.x&&r.y===before.y&&r.width===before.width&&r.height===before.height)return {before,after:before};
    const after={...r};previous.set(element,{...cached,bounds:after});return {before,after};
  }
  const next=inputs(element);
  if(cached&&!cached.simple&&plain&&next.length===cached.inputs.length&&next.every((value,i)=>value===cached.inputs[i]))return {before:cached.bounds,after:cached.bounds};
  const after=guiVisualBounds(element),before=cached?.bounds??after;previous.set(element,{bounds:after,inputs:next,simple:false,snapshot:guiThemePaintSnapshot(element)});return {before,after};
}
