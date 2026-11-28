import type {GuiElement} from '@haiyue/engine/gui';

/** Read the existing per-hit hover state without changing routing or owning another input domain. */
export function hoveredWithin(element:GuiElement):boolean {
  if(!element.isEffectivelyVisible())return false;
  const pending=[element];
  while(pending.length){const node=pending.pop()!;if(!node.visible)continue;if(node.hovered&&node.isEffectivelyVisible())return true;pending.push(...node.children);}
  return false;
}
