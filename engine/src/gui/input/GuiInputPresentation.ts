import type {GuiInput} from '../components/GuiInput';
import type {GuiRect} from '../GuiTypes';
import {guiInputAdornments,guiPasswordMasked} from './GuiInputAdornments';
import {guiGraphemeBoundaries} from './GuiGraphemes';
import {guiContentBox} from '../GuiContent';

interface InputView {x:number;y:number;caretVisible:boolean;revision:number;}
const views=new WeakMap<GuiInput,InputView>();
const state=(input:GuiInput):InputView=>{let view=views.get(input);if(!view){view={x:0,y:0,caretVisible:true,revision:0};views.set(input,view);}return view;};
export function resetGuiInputCaret(input:GuiInput):void {const view=state(input);view.caretVisible=true;view.revision++;}
export function guiInputCaretRevision(input:GuiInput):number{return state(input).revision;}
export function guiInputCaretVisible(input:GuiInput):boolean{return state(input).caretVisible;}
export function toggleGuiInputCaret(input:GuiInput):void {const view=state(input);view.caretVisible=!view.caretVisible;}

/** Shared geometry for GPU glyphs, pointer selection and the platform candidate window. */
export function guiInputPresentation(input:GuiInput,measure:(text:string)=>number,fontSize:number,lineHeight=fontSize*1.2){
  const skin=input.getResolvedStyle(),view=state(input),padding=Math.max(0,skin.padding??8),r=input.rect;
  const box=guiContentBox(input,8,fontSize),customContent=!!(skin.contentInsets||skin.nineSlice||skin.icon);
  const adornments=guiInputAdornments(input,measure,fontSize);
  const clip=customContent?{...box.text,width:Math.max(0,box.text.width-adornments.right),height:Math.max(0,box.text.height-adornments.bottom)}:{x:r.x+padding,y:r.y+Math.min(padding,r.height/2),width:Math.max(0,r.width-2*padding-adornments.right),height:Math.max(0,r.height-2*padding-adornments.bottom)};
  const textY=customContent?clip.y:r.y,textHeight=customContent?clip.height:r.height;
  const text=input.displayValue,lines:string[]=[],starts:number[]=[];
  const oneLine=(value:string)=>value.replace(/\r\n|\r|\n/gu,' ');
  if(input.multiline){let start=0;for(const match of text.matchAll(/\r\n|\r|\n/gu)){starts.push(start);lines.push(text.slice(start,match.index));start=match.index+match[0].length;}starts.push(start);lines.push(text.slice(start));}
  else {starts.push(0);lines.push(oneLine(text));}
  const position=(index:number)=>{
    let row=0;while(row+1<starts.length&&starts[row+1]!<=index)row++;
    return {row,x:measure(input.multiline?lines[row]!.slice(0,Math.max(0,index-starts[row]!)):oneLine(text.slice(0,index)))};
  };
  const caret=position(input.displayCaretIndex),width=lines.reduce((max,line)=>Math.max(max,measure(line)),0);
  const visibleHeight=input.multiline?clip.height:textHeight;
  const contentHeight=input.multiline?lines.length*lineHeight:visibleHeight;
  if(input.focused){
    if(caret.x<view.x)view.x=caret.x;else if(caret.x+2>view.x+clip.width)view.x=caret.x+2-clip.width;
    if(input.multiline){const top=caret.row*lineHeight;if(top<view.y)view.y=top;else if(top+lineHeight>view.y+visibleHeight)view.y=top+lineHeight-visibleHeight;}
  }
  view.x=Math.max(0,Math.min(Math.max(0,width+2-clip.width),view.x));
  view.y=input.multiline?Math.max(0,Math.min(Math.max(0,contentHeight-visibleHeight),view.y)):0;
  const origin={x:clip.x-view.x,y:input.multiline?clip.y-view.y:textY};
  const caretRect:GuiRect={x:origin.x+caret.x,y:input.multiline?origin.y+caret.row*lineHeight:customContent?textY+Math.max(0,(textHeight-lineHeight)/2):r.y+7,width:1.5,height:input.multiline?lineHeight:customContent?Math.min(lineHeight,textHeight):Math.max(10,r.height-14)};
  const ranges=(from:number,to:number):GuiRect[]=>{
    const rects:GuiRect[]=[];
    if(!input.multiline){const a=position(from).x,b=position(to).x;return [{x:origin.x+a,y:customContent?textY:r.y+5,width:Math.max(1,b-a),height:customContent?textHeight:Math.max(10,r.height-10)}];}
    for(let row=0;row<lines.length;row++){
      const line=lines[row]!,offset=starts[row]!,a=Math.max(0,from-offset),b=Math.min(line.length,to-offset);
      if(b<a||to<=offset||from>offset+line.length)continue;
      const x=measure(line.slice(0,a)),end=measure(line.slice(0,b));
      rects.push({x:origin.x+x,y:input.multiline?origin.y+row*lineHeight:r.y+5,width:Math.max(1,end-x),height:input.multiline?lineHeight:Math.max(10,r.height-10)});
    }
    return rects;
  };
  const indexAt=(x:number,y:number):number=>{
    const row=input.multiline?Math.max(0,Math.min(lines.length-1,Math.floor((y-origin.y)/lineHeight))):0;
    const local=x-origin.x,line=input.multiline?lines[row]!:text,boundaries=guiGraphemeBoundaries(line);
    let offset=line.length;
    for(let i=1;i<boundaries.length;i++)if(local<(measure(input.multiline?line.slice(0,boundaries[i-1]):oneLine(line.slice(0,boundaries[i-1])))+measure(input.multiline?line.slice(0,boundaries[i]):oneLine(line.slice(0,boundaries[i]))))/2){offset=boundaries[i-1]!;break;}
    const displayOffset=starts[row]!+offset;
    return guiPasswordMasked(input)?guiGraphemeBoundaries(input.value)[displayOffset]??input.value.length:displayOffset;
  };
  return {adornments,clip,origin,textHeight,caret:caretRect,lines,lineHeight,ranges,indexAt,contentWidth:width,contentHeight,scrollX:view.x,scrollY:view.y};
}
