import {InputActionMap, type StandardGamepadSnapshot} from './InputActionMap';

interface Layer {id: number; map: InputActionMap; handle: (action: string, gamepadIndex: number) => boolean; capture: ((gamepadIndex: number) => boolean) | undefined;}
interface Mask {buttons: Map<number, number>; axes: Map<number, {owner: number; neutral: number}>;}

/** Routes the sampler's existing device snapshot. Never polls or owns a device listener. */
export class GamepadInputLayers {
  private readonly layers = new Set<Layer>();
  private readonly previous = new Map<number, StandardGamepadSnapshot>();
  private readonly masks = new Map<number, Mask>();
  private quiesce = false;
  private serial = 0;

  add(map: InputActionMap, handle: Layer['handle'], capture?: Layer['capture']): () => void {
    const layer = {id:++this.serial,map,handle,capture};this.layers.add(layer);
    // Physical masks intentionally outlive the subscriber until the control is neutral.
    return () => {this.layers.delete(layer);};
  }

  clear(): void {this.previous.clear();this.masks.clear();this.quiesce=false;}
  release(): void {this.quiesce=true;}
  dispose(): void {this.clear();this.layers.clear();}

  route(pads: ArrayLike<StandardGamepadSnapshot | null>, threshold: number): ArrayLike<StandardGamepadSnapshot | null> {
    const result: (StandardGamepadSnapshot | null)[] = [];
    for (const index of [...this.previous.keys()]) if (!pads[index]?.connected) {this.previous.delete(index);this.masks.delete(index);}
    for (let index=0;index<pads.length;index++) {
      const pad=pads[index];
      if (!pad?.connected) {result[index]=null;continue;}
      const mask=this.masks.get(index)??{buttons:new Map<number,number>(),axes:new Map<number,{owner:number;neutral:number}>()};
      for(const button of mask.buttons.keys())if((pad.buttons[button]?.value??0)<=0.000_001)mask.buttons.delete(button);
      for(const [axis,state] of mask.axes)if(Math.abs(pad.axes[axis]??0)<=state.neutral)mask.axes.delete(axis);
      if(this.quiesce) {
        pad.buttons.forEach((button,i)=>{if(button.value>0.000_001)mask.buttons.set(i,0);});
        pad.axes.forEach((value,i)=>{if(Math.abs(value)>0.15)mask.axes.set(i,{owner:0,neutral:0.15});});
      }
      for(const layer of [...this.layers].reverse()) {
        if(!this.layers.has(layer))continue;
        // An explicitly capturing UI scope reserves its mapped physical controls before
        // normalization. Different UI/gameplay dead zones must not expose a threshold gap.
        if(layer.capture?.(index))for(const binding of Object.values(layer.map.toJSON())) {
          for(const button of binding.gamepadButtons??[])if((pad.buttons[button]?.value??0)>0.000_001&&!mask.buttons.has(button))mask.buttons.set(button,layer.id);
          for(const axis of binding.gamepadAxes??[])if(Math.abs(pad.axes[axis.axis]??0)>0.000_001&&!mask.axes.has(axis.axis))mask.axes.set(axis.axis,{owner:layer.id,neutral:axis.deadZone??0.15});
        }
        const available=masked(pad,mask,layer.id),before=this.previous.get(index)??null;
        const claimedButtons=new Set<number>(),claimedAxes=new Set<number>();
        const unclaimed=(): StandardGamepadSnapshot => {
          const current=masked(pad,mask,layer.id);
          return {connected:current.connected,buttons:current.buttons.map((button,i)=>claimedButtons.has(i)?{pressed:false,value:0}:button),axes:current.axes.map((value,i)=>claimedAxes.has(i)?0:value)};
        };
        const oldValues=new Map(layer.map.sampleGamepad(before).map(value=>[value.action,value.value]));
        for(const {action,value} of layer.map.sampleGamepad(available)) {
          if(Math.abs(value)<threshold||Math.abs(oldValues.get(action)??0)>=threshold)continue;
          // A prior callback can remove this layer or claim an aliased control.
          const current=unclaimed();
          if(!this.layers.has(layer)||Math.abs(layer.map.sampleGamepad(current).find(v=>v.action===action)?.value??0)<threshold)continue;
          const binding=layer.map.toJSON()[action];
          if(!layer.handle(action,index))continue;
          for(const button of binding?.gamepadButtons??[])if((current.buttons[button]?.value??0)>=threshold){mask.buttons.set(button,layer.id);claimedButtons.add(button);}
          for(const axis of binding?.gamepadAxes??[]) {
            const raw=current.axes[axis.axis]??0;
            if(Math.abs(raw)>(axis.deadZone??0.15)&&(axis.direction==='both'||axis.direction===undefined||(axis.direction==='positive'?raw>0:raw<0))){mask.axes.set(axis.axis,{owner:layer.id,neutral:axis.deadZone??0.15});claimedAxes.add(axis.axis);}
          }
        }
      }
      this.masks.set(index,mask);result[index]=masked(pad,mask);
      // GamepadButton exposes Web IDL accessors on its prototype. Object spread
      // loses those values, making every held frame look like a new press.
      this.previous.set(index,{connected:true,buttons:pad.buttons.map(button=>({pressed:button.pressed,value:button.value})),axes:[...pad.axes]});
    }
    this.quiesce=false;return result;
  }
}

function masked(pad: StandardGamepadSnapshot, mask: Mask, except?: number): StandardGamepadSnapshot {
  return {connected:pad.connected,buttons:pad.buttons.map((button,index)=>mask.buttons.has(index)&&mask.buttons.get(index)!==except?{pressed:false,value:0}:button),axes:pad.axes.map((value,index)=>mask.axes.has(index)&&mask.axes.get(index)?.owner!==except?0:value)};
}
