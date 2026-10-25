import type {GuiTooltip} from '../components/GuiTooltip';
import {GuiDirtyFlags} from '../GuiTypes';

const displayed=new WeakMap<GuiTooltip,boolean>();
/** A delayed tooltip needs frames until its visible state has been painted. */
export function guiTooltipPending(tooltip:GuiTooltip):boolean {
  return tooltip.visible&&(tooltip.target.hovered||tooltip.target.focused)&&(!tooltip.active||displayed.get(tooltip)!==true);
}
export function advanceGuiTooltip(tooltip:GuiTooltip,visible:boolean):void {
  const next=visible&&tooltip.active;
  if(next===(displayed.get(tooltip)??false))return;
  displayed.set(tooltip,next);tooltip.markDirty(GuiDirtyFlags.Visual);
}
