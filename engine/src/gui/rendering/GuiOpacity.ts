interface Colored {color: [number, number, number, number];}
/** Apply opacity only to commands owned by one control, without mutating shared colors. */
export function applyGuiOpacity(groups: readonly {commands: Colored[]; first: number}[], opacity: number): void {
  if (opacity === 1) return;
  for (const {commands, first} of groups) for (let i = commands.length - 1; i >= first; i--) {
    const command = commands[i]!, [r,g,b,a] = command.color;
    if (a * opacity <= 0) commands.splice(i, 1);
    else command.color = [r,g,b,a * opacity];
  }
}
