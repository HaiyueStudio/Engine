import type {GuiRect, GuiStyle} from '../GuiTypes';
import {parseGuiColor,withGuiAlpha} from '../GuiColor';
import type {GuiBatch} from './GuiBatch';
import type {GuiClipRect} from './GuiPaintParameters';

type Color = [number,number,number,number];
/** One six-vertex box covers fill, border and all four corners. Shadows are bounded extra quads. */
export function paintGuiBox(batch: GuiBatch, rect: GuiRect, style: Readonly<GuiStyle>, fill: Color, border: Color,
    clip?: GuiClipRect, radius = 6, effectOpacity = 1): void {
  const corners=style.cornerRadii, r=style.radius??radius, shadow=style.shadow;
  if(shadow){const spread=shadow.spread??0,color=withGuiAlpha(parseGuiColor(shadow.color,'transparent'),effectOpacity);batch.addShape({x:rect.x+(shadow.x??0)-spread,y:rect.y+(shadow.y??0)-spread,width:Math.max(0,rect.width+spread*2),height:Math.max(0,rect.height+spread*2),radius:Math.max(0,r+spread),color,appearance:{blur:shadow.blur,...(corners?{radii:corners.map(v=>Math.max(0,v+spread)) as [number,number,number,number]}:{})},clip});}
  const gradient=style.gradient;
  const from=gradient?withGuiAlpha(parseGuiColor(gradient.from,'transparent'),effectOpacity):fill,to=gradient?withGuiAlpha(parseGuiColor(gradient.to,'transparent'),effectOpacity):undefined;
  batch.addShape({...rect,radius:r,color:from,appearance:{
    borderWidth:style.borderWidth??1,borderColor:border,...(corners?{radii:corners}:{}),
    ...(gradient?{gradient:{color:to!,angle:gradient.angle??90}}:{}),
  },clip});
}

export function paintGuiLine(batch:GuiBatch,x1:number,y1:number,x2:number,y2:number,width:number,color:Color,clip?:GuiClipRect):void {
  const dx=x2-x1,dy=y2-y1,length=Math.hypot(dx,dy);
  batch.addShape({x:(x1+x2-length)/2,y:(y1+y2-width)/2,width:length,height:width,radius:width/2,rotation:Math.atan2(dy,dx)*180/Math.PI,color,appearance:{},clip});
}
export function paintGuiArc(batch:GuiBatch,rect:GuiRect,color:Color,start:number,end:number,thickness:number,clip?:GuiClipRect):void {
  batch.addShape({...rect,radius:Math.min(rect.width,rect.height)/2,color,appearance:{arc:{start,end,thickness}},clip});
}
