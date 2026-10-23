import type {GuiButton} from '../components/GuiButton';
import {GuiDirtyFlags} from '../GuiTypes';

interface Motion {from:number;target:number;elapsed:number;}
const motions=new WeakMap<GuiButton,Motion>();
const target=(button:GuiButton)=>button.hovered&&!button.disabled?1:0;
const duration=(button:GuiButton)=>button.hoverTransition&&Number.isFinite(button.hoverTransitionMs)?Math.max(0,button.hoverTransitionMs):0;
function state(button:GuiButton):Motion {
  let motion=motions.get(button);
  if(!motion){motion={from:target(button),target:target(button),elapsed:0};motions.set(button,motion);}
  return motion;
}
function sample(button:GuiButton,motion:Motion):number {
  const ms=duration(button);
  if(ms===0||motion.elapsed>=ms)return motion.target;
  const t=1-Math.pow(1-motion.elapsed/ms,3);
  return motion.from+(motion.target-motion.from)*t;
}
export function retargetGuiButtonHover(button:GuiButton):boolean {
  const motion=state(button),next=target(button);
  if(next===motion.target)return false;
  motion.from=sample(button,motion);motion.target=next;motion.elapsed=0;return true;
}
export function guiButtonHoverProgress(button:GuiButton):number {retargetGuiButtonHover(button);return sample(button,state(button));}
export function guiButtonHoverAnimating(button:GuiButton):boolean {return duration(button)>0&&sample(button,state(button))!==target(button);}
export function advanceGuiButtonHover(button:GuiButton,deltaMs:number):void {
  const changed=retargetGuiButtonHover(button);
  if(!guiButtonHoverAnimating(button))return;
  if(!changed&&Number.isFinite(deltaMs))state(button).elapsed+=Math.max(0,deltaMs);
  button.markDirty(GuiDirtyFlags.Visual);
}
export function finishGuiButtonHover(button:GuiButton):void {
  const next=target(button),old=motions.get(button);
  if(old&&old.from===next&&old.target===next)return;
  motions.set(button,{from:next,target:next,elapsed:0});
  if(old)button.markDirty(GuiDirtyFlags.Visual);
}
