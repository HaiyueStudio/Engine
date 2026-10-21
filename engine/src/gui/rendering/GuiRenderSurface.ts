import type {IEngine} from '../../core/IEngine';
import {isLinearColorTarget} from '../../postprocess/SceneColor';
export interface GuiRenderSurface {readonly width:number;readonly height:number;readonly format:GPUTextureFormat;readonly originX?:number;readonly originY?:number;}
export function guiLinearSurface(surface:GuiRenderSurface|null,engine:IEngine):boolean {return isLinearColorTarget(surface?.format??engine.format)||(surface?.format??engine.format).endsWith('-srgb');}
export function updateGuiViewport(values:Float32Array,surface:GuiRenderSurface|null,engine:IEngine,uploaded:boolean):boolean {
  const next=[surface?.width??engine.displayWidth,surface?.height??engine.displayHeight,surface?.originX??0,surface?.originY??0];
  if(uploaded&&next.every((n,i)=>values[i]===Math.fround(n)))return false;
  values.set(next);return true;
}
