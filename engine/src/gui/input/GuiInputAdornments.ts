import type {GuiInput} from '../components/GuiInput';
import type {GuiRect} from '../GuiTypes';
import {guiContentBox} from '../GuiContent';

function frame(input:GuiInput,fontSize=14):GuiRect {
  const skin=input.getResolvedStyle();return skin.contentInsets||skin.nineSlice||skin.icon?guiContentBox(input,0,fontSize).rect:input.rect;
}

// Transient presentation state: never serialized and never changes the secure host/clipboard type.
const revealed=new WeakSet<GuiInput>(),pressed=new WeakSet<GuiInput>();
export function guiPasswordRevealed(input:GuiInput):boolean{return input.inputType==='password'&&revealed.has(input);}
export function guiPasswordMasked(input:GuiInput):boolean{return input.inputType==='password'&&!revealed.has(input);}
export function guiPasswordEye(input:GuiInput):GuiRect|null {
  if(input.inputType!=='password')return null;
  const r=frame(input),size=Math.max(0,Math.min(32,r.height-4,r.width-4));
  if(size===0)return null;
  return {x:r.x+r.width-size-2,y:r.y+(r.height-size)/2,width:size,height:size};
}
export function guiPasswordEyeHit(input:GuiInput,x:number,y:number):boolean {
  const r=guiPasswordEye(input);return !input.disabled&&!!r&&x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height;
}
export function guiPasswordPress(input:GuiInput,x:number,y:number):boolean {const hit=guiPasswordEyeHit(input,x,y);if(hit)pressed.add(input);else pressed.delete(input);return hit;}
export function guiPasswordRelease(input:GuiInput,x:number,y:number):boolean {
  const armed=pressed.delete(input);if(!armed||!guiPasswordEyeHit(input,x,y))return false;
  if(revealed.has(input))revealed.delete(input);else revealed.add(input);return true;
}
export function guiPasswordCancel(input:GuiInput,hide=false):void {pressed.delete(input);if(hide)revealed.delete(input);}
export function guiInputCounterText(input:GuiInput):string|null {return Number.isFinite(input.maxLength)?`${input.value.length}/${input.maxLength}`:null;}
export function guiInputClearRect(input:GuiInput):GuiRect|null {
  if(!input.clearable||input.disabled||input.readOnly||!input.value)return null;
  const r=frame(input),eye=guiPasswordEye(input),size=Math.max(0,Math.min(24,r.height-4,r.width-4));
  return {x:r.x+r.width-(eye?eye.width+4:0)-size-2,y:r.y+(r.height-size)/2,width:size,height:size};
}
export function guiInputClearHit(input:GuiInput,x:number,y:number):boolean {const r=guiInputClearRect(input);return !!r&&x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height;}
interface TextAdornment {text:string;rect:GuiRect;}
export interface GuiInputAdornmentLayout {
  eye:GuiRect|null;
  counter:(TextAdornment&{fontSize:number})|null;
  right:number;bottom:number;
  clear?:GuiRect|null;
  prefix?:TextAdornment|null;
  suffix?:TextAdornment|null;
  left?:number;
}
export function guiInputAdornments(input:GuiInput,measure:(text:string)=>number,fontSize:number):GuiInputAdornmentLayout{
  const r=frame(input,fontSize),eye=guiPasswordEye(input),clear=guiInputClearRect(input),eyeWidth=eye?eye.width+4:0,clearWidth=clear?clear.width+4:0;
  const size=Math.min(12,fontSize),text=guiInputCounterText(input),available=Math.max(0,r.width-eyeWidth-clearWidth-16);
  const prefixWidth=input.prefix?Math.min(available*.35,measure(input.prefix))+8:0,suffixWidth=input.suffix?Math.min(available*.35,measure(input.suffix))+8:0;
  const width=text?Math.max(0,Math.min(available-prefixWidth-suffixWidth,(fontSize>0?measure(text)*size/fontSize:0)+2)):0;
  const counter=text?{text,fontSize:size,rect:{x:r.x+r.width-eyeWidth-clearWidth-6-width,y:r.y+r.height-size-4,width,height:size+2}}:null;
  const prefix=input.prefix?{text:input.prefix,rect:{x:r.x+8,y:r.y,width:Math.max(0,prefixWidth-8),height:r.height}}:null;
  const suffix=input.suffix?{text:input.suffix,rect:{x:r.x+r.width-eyeWidth-clearWidth-(counter&&!input.multiline?width+8:0)-suffixWidth,y:r.y,width:Math.max(0,suffixWidth-8),height:r.height}}:null;
  return {eye,clear,counter,prefix,suffix,left:prefixWidth,right:eyeWidth+clearWidth+suffixWidth+(counter&&!input.multiline?width+8:0),bottom:counter&&input.multiline?size+6:0};
}
