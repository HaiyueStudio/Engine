import type {RenderViewSnapshot} from '../../core/RenderView';
import type {GuiRect} from '../GuiTypes';

export interface GuiInputProjection {
  readonly hostWidth: number; readonly hostHeight: number;
  readonly bounds: GuiRect; readonly clip: GuiRect;
  readonly logicalWidth: number; readonly logicalHeight: number;
}
const intersect = (a: GuiRect,b: GuiRect): GuiRect => {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
};
export function guiInputProjection(hostWidth:number,hostHeight:number,view?:RenderViewSnapshot,region?:Readonly<GuiRect>): GuiInputProjection | null {
  if (![hostWidth,hostHeight].every(n=>Number.isFinite(n)&&n>0)) return null;
  const host={x:0,y:0,width:hostWidth,height:hostHeight};
  if (region) return {hostWidth,hostHeight,bounds:{...region},clip:intersect(host,region),logicalWidth:region.width,logicalHeight:region.height};
  if (!view) return {hostWidth,hostHeight,bounds:host,clip:host,logicalWidth:hostWidth,logicalHeight:hostHeight};
  const sx=hostWidth/view.target.width,sy=hostHeight/view.target.height;
  const viewport=view.viewport??{x:0,y:0,width:view.target.width,height:view.target.height};
  const bounds={x:viewport.x*sx,y:viewport.y*sy,width:viewport.width*sx,height:viewport.height*sy};
  let clip=intersect(host,bounds);
  if (view.scissor) clip=intersect(clip,{x:view.scissor.x*sx,y:view.scissor.y*sy,width:view.scissor.width*sx,height:view.scissor.height*sy});
  return {hostWidth,hostHeight,bounds,clip,logicalWidth:view.displayWidth,logicalHeight:view.displayHeight};
}
export function guiInputPoint(clientX:number,clientY:number,canvas:Readonly<GuiRect>,projection:GuiInputProjection): {x:number;y:number;inside:boolean} | null {
  const {bounds,clip,logicalWidth,logicalHeight,hostWidth,hostHeight}=projection;
  if (![canvas.width,canvas.height,bounds.width,bounds.height,logicalWidth,logicalHeight].every(n=>Number.isFinite(n)&&n>0)) return null;
  const hostX=(clientX-canvas.x)*hostWidth/canvas.width,hostY=(clientY-canvas.y)*hostHeight/canvas.height;
  if (![hostX,hostY].every(Number.isFinite)) return null;
  return {x:(hostX-bounds.x)*logicalWidth/bounds.width,y:(hostY-bounds.y)*logicalHeight/bounds.height,
    inside:hostX>=clip.x&&hostY>=clip.y&&hostX<clip.x+clip.width&&hostY<clip.y+clip.height};
}
export function guiInputHostRect(rect:Readonly<GuiRect>,projection:GuiInputProjection): GuiRect {
  const sx=projection.bounds.width/projection.logicalWidth,sy=projection.bounds.height/projection.logicalHeight;
  return {x:projection.bounds.x+rect.x*sx,y:projection.bounds.y+rect.y*sy,width:rect.width*sx,height:rect.height*sy};
}
