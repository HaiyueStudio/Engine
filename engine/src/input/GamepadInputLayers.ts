import type {InputActionMap, InputActionBinding, StandardGamepadSnapshot} from './InputActionMap';

/** Readonly controls from the original sampler snapshot; claims survive until neutral. */
export interface GamepadControlSample {
  readonly index:number; readonly control:string; readonly value:number;
  readonly previousValue:number; readonly neutral:boolean;
  readonly phases:readonly ('down'|'up'|'change')[];
}
/** Preserve physical Web IDL button accessors when retaining the previous snapshot. */
/** Opaque tokens keep held claims independent of subscriber callbacks. */
type Owner = object|false;
interface RawLayer {owner:object; handle:(sample:GamepadControlSample)=>boolean; map?:never; capture?:never;}
interface ActionLayer {owner:object; map:InputActionMap; handle:(action:string,index:number)=>boolean; capture:((index:number)=>boolean)|undefined;}
type Layer = RawLayer|ActionLayer;
interface Claim {owner:Owner; neutral:number;}
// Button keys are nonnegative; axis keys use the bitwise complement of their index.
type Mask = Map<number,Claim>;

export class GamepadInputLayers {
  private readonly layers = new Set<Layer>();
  private readonly previous = new Map<number,StandardGamepadSnapshot>();
  private readonly masks = new Map<number,Mask>();
  private released?:boolean;
  private raw = 0;

  add(map:InputActionMap,handle:ActionLayer['handle'],capture?:ActionLayer['capture']):()=>void {
    return this.register({owner:{},map,handle,capture});
  }
  addRaw(handle:RawLayer['handle']):()=>void {
    if(typeof handle!=='function')throw new TypeError('Gamepad route requires a callback.');
    return this.register({owner:{},handle});
  }
  private register(layer:Layer):()=>void {
    this.layers.add(layer);if(!layer.map)this.raw++;
    return()=>{if(this.layers.delete(layer)&&!layer.map)this.raw--;};
  }
  clear():void {this.previous.clear();this.masks.clear();this.released=false;}
  release():void {this.released=true;}
  dispose():void {this.clear();this.layers.clear();this.raw=0;}

  private routeRaw(layer:RawLayer,pad:StandardGamepadSnapshot,before:StandardGamepadSnapshot|null,index:number,mask:Mask,oldMask:Mask,threshold:number,release=false):void {
    const buttons=Math.max(pad.buttons.length,before?.buttons.length??0),length=buttons+Math.max(pad.axes.length,before?.axes.length??0);
    for(let position=0;position<length;position++){
      const key=position<buttons?position:~(position-buttons);
      const value=release?0:read(pad,key),previousValue=read(before,key),owner=mask.get(key)?.owner,oldOwner=oldMask.get(key)?.owner;
      const neutral=Math.abs(value)<=(key<0?0.15:0.000_001);
      const heldOwner=owner??oldOwner;
      if(release?oldOwner!==layer.owner:heldOwner!==undefined&&heldOwner!==layer.owner&&!(neutral&&oldOwner===layer.owner))continue;
      if(value===0&&previousValue===0)continue;
      const phases:('down'|'up'|'change')[]=[],limit=key<0?0.15:threshold;
      const pressed=key<0?Math.abs(value)>limit:Math.abs(value)>=limit,wasPressed=key<0?Math.abs(previousValue)>limit:Math.abs(previousValue)>=limit;
      if(pressed!==wasPressed&&(pressed||owner===layer.owner||oldOwner===layer.owner))phases.push(pressed?'down':'up');
      if(value!==previousValue)phases.push('change');
      const sample=Object.freeze({index,control:key<0?'axis:'+~key:'button:'+key,value,previousValue,neutral,phases:Object.freeze(phases)});
      let consumed=true,claimedOwner:Owner=false;
      try{consumed=this.layers.has(layer)&&layer.handle(sample);claimedOwner=layer.owner;}
      finally{if(consumed&&Math.abs(value)>0.000_001)mask.set(key,{owner:claimedOwner,neutral:key<0?0.15:0.000_001});}
    }
  }

  route(pads:ArrayLike<StandardGamepadSnapshot|null>,threshold:number):ArrayLike<StandardGamepadSnapshot|null> {
    const result:(StandardGamepadSnapshot|null)[]=[];
    let length=pads.length;for(const index of this.previous.keys())length=Math.max(length,index+1);
    for(let index=0;index<length;index++){
      const actual=pads[index],before=this.previous.get(index)??null,connected=actual?.connected===true;
      if(!connected&&(!before||!this.raw)){this.previous.delete(index);this.masks.delete(index);result[index]=null;continue;}
      const pad:StandardGamepadSnapshot=connected?actual!:{connected:false,buttons:[],axes:[]};
      const mask=this.masks.get(index)??new Map<number,Claim>();this.masks.set(index,mask);
      const oldMask=this.raw?new Map(mask):mask;
      for(const[key,claim]of mask)if(key<0?Math.abs(read(pad,key))<=claim.neutral:read(pad,key)<=claim.neutral)mask.delete(key);
      if(this.released){
        for(const layer of [...this.layers].reverse())if(!layer.map)this.routeRaw(layer,pad,before,index,mask,oldMask,threshold,true);
        for(let key=-pad.axes.length;key<pad.buttons.length;key++)if((key<0?Math.abs(read(pad,key)):read(pad,key))>(key<0?0.15:0.000_001))mask.set(key,{owner:false,neutral:key<0?0.15:0.000_001});
      }
      for(const layer of [...this.layers].reverse()){
        if(!this.layers.has(layer))continue;
        if(!layer.map){if(!this.released)this.routeRaw(layer,pad,before,index,mask,oldMask,threshold);continue;}
        if(!connected)continue;
        if(layer.capture?.(index))for(const binding of Object.values(layer.map.toJSON()))claim(pad,mask,binding,layer.owner,threshold);
        const available=masked(pad,mask,layer.owner),claimed=new Set<number>();
        const oldValues=new Map(layer.map.sampleGamepad(before).map(v=>[v.action,v.value]));
        for(const{action,value}of layer.map.sampleGamepad(available)){
          if(Math.abs(value)<threshold||Math.abs(oldValues.get(action)??0)>=threshold)continue;
          const current=masked(pad,mask,layer.owner,claimed);
          if(!this.layers.has(layer)||Math.abs(layer.map.sampleGamepad(current).find(v=>v.action===action)?.value??0)<threshold)continue;
          const binding=layer.map.toJSON()[action];
          if(layer.handle(action,index))claim(current,mask,binding,layer.owner,threshold,claimed);
        }
      }
      if(!connected){this.previous.delete(index);this.masks.delete(index);result[index]=null;continue;}
      this.masks.set(index,mask);result[index]=masked(pad,mask);
      this.previous.set(index,{connected:true,buttons:pad.buttons.map(b=>({pressed:b.pressed,value:b.value})),axes:[...pad.axes]});
    }
    this.released=false;return result;
  }
}

function read(pad:StandardGamepadSnapshot|null,key:number):number {
  return key<0?pad?.axes[~key]??0:pad?.buttons[key]?.value??0;
}
function masked(pad:StandardGamepadSnapshot,mask:Mask,owner?:object,claimed?:Set<number>):StandardGamepadSnapshot {
  const hidden=(key:number)=>claimed?.has(key)||(mask.get(key)?.owner??owner)!==owner;
  return {connected:pad.connected,buttons:pad.buttons.map((b,i)=>hidden(i)?{pressed:false,value:0}:b),axes:pad.axes.map((v,i)=>hidden(~i)?0:v)};
}
function claim(pad:StandardGamepadSnapshot,mask:Mask,binding:InputActionBinding|undefined,owner:object,threshold:number,claimed?:Set<number>):void {
  const capture=!claimed;
  const reserve=(key:number,neutral:number)=>{if(!capture||!mask.has(key)){mask.set(key,{owner,neutral});claimed?.add(key);}};
  for(const button of binding?.gamepadButtons??[])if(capture?read(pad,button)>0.000_001:read(pad,button)>=threshold)reserve(button,0.000_001);
  for(const axis of binding?.gamepadAxes??[]){
    const value=read(pad,~axis.axis),neutral=axis.deadZone??0.15;
    if(capture?Math.abs(value)>0.000_001:Math.abs(value)>neutral&&(axis.direction==='both'||axis.direction===undefined||(axis.direction==='positive'?value>0:value<0)))reserve(~axis.axis,neutral);
  }
}
