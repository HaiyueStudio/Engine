import {graphemeProperties, extendedPictographic, indicConjunct} from './GuiUnicode15_1';

// UAX #29 revision 43, Unicode 15.1. No dependency on the host ICU version.
const CR=1,LF=2,CONTROL=3,EXTEND=4,ZWJ=5,RI=6,PREPEND=7,SPACING=8,L=9,V=10,T=11,LV=12,LVT=13;
function property(table: readonly number[], code: number): number {
  let low=0,high=table.length/3-1;
  while(low<=high){const mid=(low+high)>>>1,start=table[mid*3]!,end=table[mid*3+1]!;
    if(code<start)high=mid-1;else if(code>end)low=mid+1;else return table[mid*3+2]!;
  }
  return 0;
}
function graphemeProperty(code:number):number {
  if(code>=0xac00&&code<=0xd7a3)return (code-0xac00)%28===0?LV:LVT;
  return property(graphemeProperties,code);
}
const control=(p:number)=>p===CR||p===LF||p===CONTROL;

/** UTF-16 offsets of extended grapheme boundaries, including zero and length. */
export function guiGraphemeBoundaries(text:string):readonly number[] {
  const points=[...text].map(character=>character.codePointAt(0)!);
  const properties=points.map(graphemeProperty),indic=points.map(code=>property(indicConjunct,code));
  const result=[0];let offset=0,regionalRun=properties[0]===RI?1:0;
  for(let i=1;i<points.length;i++){
    offset+=points[i-1]!>0xffff?2:1;
    const a=properties[i-1]!,b=properties[i]!;let joins=false;
    if(a===CR&&b===LF)joins=true; // GB3
    else if(control(a)||control(b))joins=false; // GB4/5
    else if(a===L&&(b===L||b===V||b===LV||b===LVT))joins=true; // GB6
    else if((a===LV||a===V)&&(b===V||b===T))joins=true; // GB7
    else if((a===LVT||a===T)&&b===T)joins=true; // GB8
    else if(b===EXTEND||b===ZWJ||b===SPACING||a===PREPEND)joins=true; // GB9/9a/9b
    else if(indic[i]===1){ // GB9c: consonant, with at least one linker before this consonant.
      let j=i-1,linker=false;
      while(j>=0&&(indic[j]===2||indic[j]===3)){linker ||= indic[j]===2;j--;}
      joins=linker&&j>=0&&indic[j]===1;
    }
    if(!joins&&!control(a)&&!control(b)&&a===ZWJ&&property(extendedPictographic,points[i]!)===1){ // GB11
      let j=i-2;while(j>=0&&properties[j]===EXTEND)j--;
      joins=j>=0&&property(extendedPictographic,points[j]!)===1;
    }
    if(!joins&&a===RI&&b===RI)joins=regionalRun%2===1; // GB12/13
    if(!joins)result.push(offset); // GB999
    regionalRun=b===RI?(a===RI?regionalRun+1:1):0;
  }
  if(text.length)result.push(text.length);
  return result;
}

export function guiSnapIndex(boundaries:readonly number[],index:number,forward=false):number {
  if(!Number.isFinite(index))throw new RangeError('GUI text index must be finite.');
  const target=Math.max(0,Math.min(boundaries.at(-1)!,Math.trunc(index)));
  let low=0,high=boundaries.length-1;
  while(low<=high){const mid=(low+high)>>>1,value=boundaries[mid]!;if(value===target)return value;if(value<target)low=mid+1;else high=mid-1;}
  return boundaries[forward?low:Math.max(0,high)]!;
}

export function guiWellFormedText(text:string):string {
  let result='';for(const character of text){const code=character.codePointAt(0)!;result+=code>=0xd800&&code<=0xdfff?'\ufffd':character;}
  return result;
}

/** Minimal replacement whose unchanged prefix/suffix are complete clusters in both strings. */
export function guiTextDifference(previous:string,next:string):{startUtf16:number;endUtf16:number;text:string} {
  let start=0;while(start<previous.length&&start<next.length&&previous[start]===next[start])start++;
  let oldEnd=previous.length,newEnd=next.length;
  while(oldEnd>start&&newEnd>start&&previous[oldEnd-1]===next[newEnd-1]){oldEnd--;newEnd--;}
  const before=new Set(guiGraphemeBoundaries(previous)),after=new Set(guiGraphemeBoundaries(next));
  while(start>0&&(!before.has(start)||!after.has(start)))start--;
  let suffix=Math.min(previous.length-oldEnd,next.length-newEnd,previous.length-start,next.length-start);
  while(suffix>0&&(!before.has(previous.length-suffix)||!after.has(next.length-suffix)))suffix--;
  return {startUtf16:start,endUtf16:previous.length-suffix,text:next.slice(start,next.length-suffix)};
}
