import {readGuiExternalPresentation,readGuiExternalInputGeometry} from '../GuiExternalPresentation';
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
export type GuiInputPresentation=ReturnType<typeof defaultGuiInputPresentation> & {readonly caretVisible?:boolean;readonly compositionRanges?:readonly GuiRect[]};
export function guiInputPresentation(input:GuiInput,measure:(text:string)=>number,fontSize:number,lineHeight=fontSize*1.2):GuiInputPresentation{
 const geometry=readGuiExternalInputGeometry(input);if(geometry)return externalInputPresentation(input,geometry);
 const p=readGuiExternalPresentation(input)??defaultGuiInputPresentation(input,measure,fontSize,lineHeight),range=input.displayCompositionRange;
 return{...p,caretVisible:input.focused&&!input.disabled&&!input.readOnly&&(input.isComposing||!input.hasSelection&&state(input).caretVisible),compositionRanges:input.focused&&range?p.ranges(...range):[]};
}
function defaultGuiInputPresentation(input:GuiInput,measure:(text:string)=>number,fontSize:number,lineHeight=fontSize*1.2){
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

/** Source-neutral metrics from the externally painted glyph owner, in GUI logical coordinates. */
export type GuiInputGeometry=Omit<GuiInputPresentation,'scrollX'|'scrollY'|'caretVisible'|'compositionRanges'> & {
 readonly contentBounds?:GuiRect;
 /** Map the local geometry plane into GUI coordinates after the original local scroll calculation. */
 readonly coordinateTransform?:readonly[number,number,number,number,number,number];
};
export interface GuiInputViewSnapshot {readonly scrollX:number;readonly scrollY:number;readonly focused:boolean;readonly multiline:boolean;readonly caretVisible:boolean;readonly compositionRange?:readonly[number,number];}

/** Pure projection over the original G06 viewport state; fallible external draws may snapshot/retry it. */
export function projectGuiInputGeometry(g:GuiInputGeometry,s:GuiInputViewSnapshot):GuiInputPresentation {
  if(g?.coordinateTransform)return projectAffineGuiInputGeometry(g,s);
  const finite=(v:number)=>typeof v==='number'&&Number.isFinite(v),rect=(r:GuiRect)=>r&&[r.x,r.y,r.width,r.height].every(finite)&&r.width>=0&&r.height>=0;
  if(!g||!rect(g.clip)||!rect(g.caret)||!finite(g.origin.x)||!finite(g.origin.y)||!finite(g.contentWidth)||!finite(g.contentHeight)||g.contentWidth<0||g.contentHeight<0||!finite(s.scrollX)||!finite(s.scrollY))throw new Error('Invalid external G06 geometry or viewport state.');
  const bounds=g.contentBounds??{x:g.origin.x,y:g.origin.y,width:g.contentWidth+2,height:g.contentHeight};if(!rect(bounds))throw new Error('Invalid external G06 content bounds.');
  const minimumX=Math.min(0,bounds.x-g.clip.x),maximumX=Math.max(0,bounds.x+bounds.width-g.clip.x-g.clip.width),minimumY=s.multiline?Math.min(0,bounds.y-g.clip.y):0,maximumY=s.multiline?Math.max(0,bounds.y+bounds.height-g.clip.y-g.clip.height):0;
  let x=s.scrollX,y=s.multiline?s.scrollY:0;
  if(s.focused){if(g.caret.x-x<g.clip.x)x=g.caret.x-g.clip.x;else if(g.caret.x+g.caret.width-x>g.clip.x+g.clip.width)x=g.caret.x+g.caret.width-g.clip.x-g.clip.width;
    if(s.multiline){if(g.caret.y-y<g.clip.y)y=g.caret.y-g.clip.y;else if(g.caret.y+g.caret.height-y>g.clip.y+g.clip.height)y=g.caret.y+g.caret.height-g.clip.y-g.clip.height;}}
  x=Math.max(minimumX,Math.min(maximumX,x));y=Math.max(minimumY,Math.min(maximumY,y));
  const shift=(r:GuiRect):GuiRect=>({x:r.x-x,y:r.y-y,width:r.width,height:r.height}),ranges=(a:number,b:number)=>g.ranges(a,b).map(shift);
  const composition=s.focused&&s.compositionRange?ranges(...s.compositionRange):[];
  return{...g,origin:{x:g.origin.x-x,y:g.origin.y-y},caret:shift(g.caret),ranges,indexAt:(px:number,py:number)=>g.indexAt(px+x,py+y),scrollX:x,scrollY:y,caretVisible:s.focused&&s.caretVisible,compositionRanges:composition};
}
/** External glyph owners keep scrolling in their layout plane; platform rectangles are enclosures. */
function projectAffineGuiInputGeometry(g:GuiInputGeometry,s:GuiInputViewSnapshot):GuiInputPresentation{
 const {coordinateTransform:m,...local}=g;
 if(!Array.isArray(m)||m.length!==6||m.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('Invalid external G06 coordinate transform.');
 const p=projectGuiInputGeometry(local,s),point=(x:number,y:number)=>{
  const q={x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]};
  if(!Number.isFinite(q.x)||!Number.isFinite(q.y))throw new Error('External G06 affine geometry overflow.');return q;
 },rect=(r:GuiRect):GuiRect=>{
  const corners=[point(r.x,r.y),point(r.x+r.width,r.y),point(r.x,r.y+r.height),point(r.x+r.width,r.y+r.height)],x=Math.min(...corners.map(q=>q.x)),y=Math.min(...corners.map(q=>q.y)),width=Math.max(...corners.map(q=>q.x))-x,height=Math.max(...corners.map(q=>q.y))-y;
  if(!Number.isFinite(width)||!Number.isFinite(height))throw new Error('External G06 affine bounds overflow.');return{x,y,width,height};
 };
 const scale=Math.max(...m.slice(0,4).map(Math.abs)),a=m[0]/scale,b=m[1]/scale,c=m[2]/scale,d=m[3]/scale,det=a*d-b*c;
 const indexAt=(x:number,y:number):number=>{
  if(!scale||!det)return p.indexAt(p.caret.x,p.caret.y);
  const u=(x-m[4])/scale,v=(y-m[5])/scale,lx=(d*u-c*v)/det,ly=(a*v-b*u)/det;
  if(!Number.isFinite(lx)||!Number.isFinite(ly))return p.indexAt(p.caret.x,p.caret.y);
  return p.indexAt(lx,ly);
 };
 return{...p,clip:rect(p.clip),origin:point(p.origin.x,p.origin.y),caret:rect(p.caret),ranges:(a,b)=>p.ranges(a,b).map(rect),indexAt,
  ...(p.compositionRanges?{compositionRanges:p.compositionRanges.map(rect)}:{}),adornments:{...p.adornments,eye:p.adornments.eye?rect(p.adornments.eye):null,counter:p.adornments.counter?{...p.adornments.counter,rect:rect(p.adornments.counter.rect)}:null}};
}
function externalInputPresentation(input:GuiInput,g:GuiInputGeometry):GuiInputPresentation{
 const view=state(input),compositionRange=input.displayCompositionRange;
 const result=projectGuiInputGeometry(g,{scrollX:view.x,scrollY:view.y,focused:input.focused,multiline:input.multiline,caretVisible:!input.disabled&&!input.readOnly&&(input.isComposing||!input.hasSelection&&view.caretVisible),...(compositionRange?{compositionRange}:{})});
 view.x=result.scrollX;view.y=result.scrollY;return result;
}
