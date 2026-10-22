import type {GuiInput} from '../components/GuiInput';
import type {GuiPointerEvent} from '../GuiTypes';

interface Press {id:number;x:number;y:number;time:number;kind:string;}
interface Clicks {press:Press|null;count:number;time:number;x:number;y:number;kind:string;}
const clicks=new WeakMap<GuiInput,Clicks>();
const interval=500,slopSquared=6*6;
const time=(event:GuiPointerEvent)=>Number.isFinite(event.nativeEvent?.timeStamp)?event.nativeEvent.timeStamp:performance.now();
const kind=(event:GuiPointerEvent)=>event.nativeEvent?.pointerType||'mouse';
const distance=(a:{x:number;y:number},b:{x:number;y:number})=>(a.x-b.x)**2+(a.y-b.y)**2;

/** Completed primary clicks only; no timer, DOM click count or retained input owner. */
export function beginGuiInputClick(input:GuiInput,event:GuiPointerEvent):void {
  if(input.disabled||event.button!==0||event.nativeEvent?.isPrimary===false){clicks.delete(input);return;}
  let state=clicks.get(input);
  // Overlapping pointers are not a sequence of clicks.
  if(state?.press){clicks.delete(input);return;}
  if(!state){state={press:null,count:0,time:0,x:0,y:0,kind:''};clicks.set(input,state);}
  state.press={id:event.pointerId,x:event.x,y:event.y,time:time(event),kind:kind(event)};
}

export function moveGuiInputClick(input:GuiInput,event:GuiPointerEvent):void {
  const state=clicks.get(input);
  if(state?.press?.id===event.pointerId&&distance(state.press,event)>slopSquared)clicks.delete(input);
}

export function finishGuiInputClick(input:GuiInput,event:GuiPointerEvent):boolean {
  const state=clicks.get(input),press=state?.press;
  if(!state||!press)return false;
  const now=time(event),r=input.rect;
  state.press=null;
  if(input.disabled||event.button!==0||press.id!==event.pointerId||press.kind!==kind(event)||now<press.time||now-press.time>interval||distance(press,event)>slopSquared||event.x<r.x||event.x>r.x+r.width||event.y<r.y||event.y>r.y+r.height){clicks.delete(input);return false;}
  const continuing=state.count>0&&now>=state.time&&now-state.time<=interval&&state.kind===press.kind&&distance(state,press)<=slopSquared;
  if(!continuing){state.count=0;state.x=press.x;state.y=press.y;state.kind=press.kind;}
  state.time=now;
  if(++state.count===3){clicks.delete(input);return true;}
  return false;
}

export function cancelGuiInputClick(input:GuiInput):void {clicks.delete(input);}
