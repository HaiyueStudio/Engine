import type {GuiShapeCommand} from './GuiDrawCommand';
interface Colored {color: [number, number, number, number];appearance?:GuiShapeCommand['appearance'];}
/** Apply opacity only to commands owned by one control, without mutating shared colors. */
export function applyGuiOpacity(groups: readonly {commands: Colored[]; first: number}[], opacity: number): void {
  if (opacity === 1) return;
  for (const {commands, first} of groups) for (let i = commands.length - 1; i >= first; i--) {
    const command = commands[i]!, [r,g,b,a] = command.color;
    if (opacity <= 0 || a<=0&&!command.appearance?.borderColor?.[3]) commands.splice(i, 1);
    else {command.color = [r,g,b,a * opacity];const effect=command.appearance;
      if(effect){const alpha=(c:readonly [number,number,number,number]):[number,number,number,number]=>[c[0],c[1],c[2],c[3]*opacity];command.appearance={...effect,...(effect.borderColor?{borderColor:alpha(effect.borderColor)}:{}),...(effect.gradient?{gradient:{...effect.gradient,color:alpha(effect.gradient.color)}}:{})};}}
  }
}
