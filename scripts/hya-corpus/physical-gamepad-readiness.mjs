/** A GUI-consumption assertion requires its original focus owner and a neutral start. */
export function physicalGamepadReadiness(previous, {focused, foreground, connected, buttons, axes}) {
  if(!focused||!foreground)return 'waiting-focus';
  if(!connected)return 'waiting-controller';
  if(previous==='ready')return 'ready';
  if(buttons.some(value=>value>0.000001)||axes.some(value=>Math.abs(value)>.15))return 'waiting-neutral';
  return 'ready';
}
