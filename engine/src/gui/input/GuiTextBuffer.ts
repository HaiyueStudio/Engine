import {guiGraphemeBoundaries,guiSnapIndex,guiWellFormedText,guiTextDifference} from './GuiGraphemes';

export interface GuiTextBufferEdit {readonly previous:string;readonly value:string;readonly startUtf16:number;readonly endUtf16:number;readonly text:string;}
interface Snapshot {value:string;anchor:number;focus:number;}
interface Preedit {before:Snapshot;start:number;end:number;text:string;selection:readonly [number,number];}

/** Platform-free committed editing state. Preedit never mutates value or undo history. */
export class GuiTextBuffer {
  private text='';
  private boundaries:readonly number[]=[0];
  private anchor=0;
  private focus=0;
  private limit=Infinity;
  private readonly past:Snapshot[]=[];
  private readonly future:Snapshot[]=[];
  private preedit:Preedit|null=null;
  revision=0;

  constructor(value='',maxLength=Infinity,private readonly committed?:(edit:GuiTextBufferEdit)=>void){this.setLimit(maxLength);this.setValue(value);this.select(this.text.length,this.text.length);}
  get value():string{return this.text;}
  get caret():number{return this.focus;}
  get selectionAnchor():number{return this.anchor;}
  get selectionFocus():number{return this.focus;}
  get selectionStart():number{return Math.min(this.anchor,this.focus);}
  get selectionEnd():number{return Math.max(this.anchor,this.focus);}
  get maxLength():number{return this.limit;}
  get composing():boolean{return this.preedit!==null;}
  get composition():Readonly<{text:string;selectionUtf16:readonly [number,number];startUtf16:number;endUtf16:number}>|null {
    const p=this.preedit;return p?{text:p.text,selectionUtf16:p.selection,startUtf16:p.start,endUtf16:p.end}:null;
  }
  get displayValue():string {const p=this.preedit;return p?this.text.slice(0,p.start)+p.text+this.text.slice(p.end):this.text;}
  get displayCaret():number {return this.preedit?this.preedit.start+this.preedit.selection[1]:this.focus;}
  get graphemeBoundaries():readonly number[]{return this.boundaries;}
  get canUndo():boolean{return this.past.length>0;}
  get canRedo():boolean{return this.future.length>0;}

  setLimit(limit:number):void {
    if(limit!==Infinity&&(!Number.isSafeInteger(limit)||limit<0))throw new RangeError('GUI maxLength must be a nonnegative UTF-16 integer.');
    if(this.limit===limit)return;
    this.limit=limit;this.cancelComposition();this.past.length=this.future.length=0;
    const value=this.clip(this.text,limit);if(value!==this.text)this.assign(value,this.anchor,this.focus);else this.revision++;
  }
  setValue(value:string):void {
    this.cancelComposition();const next=this.clip(guiWellFormedText(value),this.limit);
    if(next===this.text)return;
    this.past.length=this.future.length=0;this.assign(next,this.focus,this.focus);
  }
  select(anchor:number,focus:number):void {
    const collapsed=anchor===focus,reverse=anchor>focus;
    const start=guiSnapIndex(this.boundaries,Math.min(anchor,focus));
    const end=collapsed?start:guiSnapIndex(this.boundaries,Math.max(anchor,focus),true);
    const a=reverse?end:start,f=reverse?start:end;
    if(a===this.anchor&&f===this.focus)return;
    this.anchor=a;this.focus=f;this.revision++;
  }
  setCaret(index:number,extend=false):void {
    const next=guiSnapIndex(this.boundaries,index);
    this.select(extend?this.anchor:next,next);
  }
  move(delta:number,extend=false):void {
    if(!Number.isFinite(delta))throw new RangeError('GUI caret movement must be finite.');
    if(!extend&&this.anchor!==this.focus&&delta){this.setCaret(delta<0?this.selectionStart:this.selectionEnd);return;}
    const index=this.boundaries.indexOf(this.focus);
    const next=this.boundaries[Math.max(0,Math.min(this.boundaries.length-1,index+Math.trunc(delta)))]!;
    this.setCaret(next,extend);
  }
  insert(text:string):void {this.replace(this.selectionStart,this.selectionEnd,text);}
  delete(backward:boolean):void {
    let start=this.selectionStart,end=this.selectionEnd;
    if(start===end){const index=this.boundaries.indexOf(this.focus);if(backward)start=this.boundaries[Math.max(0,index-1)]!;else end=this.boundaries[Math.min(this.boundaries.length-1,index+1)]!;}
    if(start!==end)this.replace(start,end,'');
  }
  replace(start:number,end:number,text:string):boolean {
    this.cancelComposition();
    const low=guiSnapIndex(this.boundaries,Math.min(start,end));
    const high=start===end?low:guiSnapIndex(this.boundaries,Math.max(start,end),true);
    const inserted=this.clip(guiWellFormedText(text),Math.max(0,this.limit-(this.text.length-(high-low))));
    // An unrepresentable pasted cluster must not erase the selected text.
    if(text.length&&!inserted.length)return false;
    const next=this.text.slice(0,low)+inserted+this.text.slice(high);
    const edit=Object.freeze({previous:this.text,value:next,startUtf16:low,endUtf16:high,text:inserted});
    if(next===this.text){this.setCaret(low+inserted.length);if(high!==low||inserted.length)this.committed?.(edit);return true;}
    this.remember();this.assign(next,low+inserted.length,low+inserted.length,true);this.committed?.(edit);
    return true;
  }
  beginComposition():void {
    if(this.preedit)return;
    this.preedit={before:this.snapshot(),start:this.selectionStart,end:this.selectionEnd,text:'',selection:[0,0]};this.revision++;
  }
  updateComposition(text:string,selection:readonly [number,number]=[text.length,text.length]):void {
    const p=this.preedit;if(!p)return;
    const next=guiWellFormedText(text),boundaries=guiGraphemeBoundaries(next);
    const a=guiSnapIndex(boundaries,Math.min(...selection)),b=guiSnapIndex(boundaries,Math.max(...selection),selection[0]!==selection[1]);
    const range:readonly [number,number]=selection[0]>selection[1]?[b,a]:[a,b];
    if(p.text===next&&p.selection[0]===range[0]&&p.selection[1]===range[1])return;
    p.text=next;p.selection=range;this.revision++;
  }
  commitComposition(text=this.preedit?.text??''):void {
    const p=this.preedit;if(!p)return;
    this.preedit=null;this.anchor=p.before.anchor;this.focus=p.before.focus;this.revision++;
    this.replace(p.start,p.end,text);
  }
  cancelComposition():void {
    const p=this.preedit;if(!p)return;
    this.preedit=null;this.anchor=p.before.anchor;this.focus=p.before.focus;this.revision++;
  }
  undo():void {
    this.cancelComposition();const previous=this.past.pop();if(!previous)return;
    const before=this.text;this.future.push(this.snapshot());this.assign(previous.value,previous.anchor,previous.focus);if(before!==this.text)this.committed?.(Object.freeze({previous:before,value:this.text,...guiTextDifference(before,this.text)}));
  }
  redo():void {
    this.cancelComposition();const next=this.future.pop();if(!next)return;
    const before=this.text;this.past.push(this.snapshot());this.assign(next.value,next.anchor,next.focus);if(before!==this.text)this.committed?.(Object.freeze({previous:before,value:this.text,...guiTextDifference(before,this.text)}));
  }
  private snapshot():Snapshot{return {value:this.text,anchor:this.anchor,focus:this.focus};}
  private remember():void {this.past.push(this.snapshot());if(this.past.length>128)this.past.shift();this.future.length=0;}
  private clip(text:string,limit:number):string {return text.length<=limit?text:text.slice(0,guiSnapIndex(guiGraphemeBoundaries(text),limit));}
  private assign(value:string,anchor:number,focus:number,forwardCaret=false):void {
    this.text=value;this.boundaries=guiGraphemeBoundaries(value);
    if(forwardCaret&&anchor===focus)anchor=focus=guiSnapIndex(this.boundaries,focus,true);
    this.anchor=guiSnapIndex(this.boundaries,anchor);this.focus=guiSnapIndex(this.boundaries,focus);this.revision++;
  }
}
