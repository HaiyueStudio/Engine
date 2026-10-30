import {segmentGraphemes} from './DeterministicTextShaper.js';
import type {RuntimeFontAsset,TextGlyphPose,TextLinePose} from './runtime-types.js';
type Rect=readonly[number,number,number,number];
type Cluster=Readonly<{start:number;end:number;sequence:string}>;
export interface ProductionLogicalCell {readonly start:number;readonly end:number;readonly line:number;readonly rect:Rect;}
export interface ProductionLogicalCaret {readonly offset:number;readonly line:number;readonly rect:Rect;}
const poseGeometry=new WeakMap<object,ReturnType<typeof createProductionTextGeometry>>();
export function rememberProductionTextGeometry<T extends object>(pose:T,geometry:ReturnType<typeof createProductionTextGeometry>|undefined):T{if(geometry)poseGeometry.set(pose,geometry);return pose;}
export function productionTextGeometryForPose(pose:object){return poseGeometry.get(pose);}
const bounds=(points:readonly(readonly[number,number])[]):Rect=>{const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1]));return Object.freeze([x,y,Math.max(...points.map(p=>p[0]))-x,Math.max(...points.map(p=>p[1]))-y]);};
/** The original shaped line/glyph identities determine blank-line and newline positions too. */
export function productionLogicalLines(glyphs:readonly TextGlyphPose[],lines:readonly TextLinePose[],clusters:readonly Cluster[]){
 let next=0;return Object.freeze(lines.map(line=>{let start=Infinity,end=-Infinity;for(let i=line.startGlyph;i<line.endGlyph;i++){const g=glyphs[i]!;start=Math.min(start,g.logicalIndex);end=Math.max(end,g.logicalIndex+segmentGraphemes(g.sequence).length);}if(start===Infinity)start=end=next;next=end;if(['\n','\r','\r\n'].includes(clusters[next]?.sequence??''))next++;return Object.freeze({start,end});}));
}
/** Geometry only. Original font metrics, shaper, modifiers, pen offsets and line placement remain authoritative. */
export function createProductionTextGeometry(glyphs:readonly TextGlyphPose[],lines:readonly TextLinePose[],clusters:readonly Cluster[],fonts:ReadonlyMap<string,RuntimeFontAsset>){
 const ranges=productionLogicalLines(glyphs,lines,clusters),cells:ProductionLogicalCell[]=[],starts=new Map<string,Rect>(),ends=new Map<string,Rect>();
 const point=(g:TextGlyphPose,distance:number,height:number):readonly[number,number]=>{const [px,py]=g.penOffset!,x=px+distance,y=py+height,c=Math.cos(g.rotation),s=Math.sin(g.rotation);return[g.x+x*g.scaleX*c-y*g.scaleY*s,g.y+x*g.scaleX*s+y*g.scaleY*c];};
 for(const g of glyphs){
  const parts=segmentGraphemes(g.sequence),font=fonts.get(g.fontAsset),style=g.style!;
  // The compiled backend has no GDEF caret table. Its deterministic ligature fallback uses the validated component advances, scaled to the actual ligature advance.
  const widths=parts.map((p,i)=>{const metric=font?.metrics.glyphs[p.sequence]??font?.metrics.missingGlyph;let units=metric?.advance??0;for(const[tag,coefficient]of Object.entries(metric?.axisAdvance??{})){const axis=font?.metrics.axes?.[tag];if(axis)units+=((g.axes[tag]??axis.default)-axis.default)*coefficient;}if(i)units+=font?.metrics.kerning?.[parts[i-1]!.sequence+'|'+p.sequence]??0;return Math.max(0,units*style.fontSize/(font?.metrics.unitsPerEm??1)+style.tracking);}),sum=widths.reduce((a,b)=>a+b,0);let used=0;
  for(let i=0;i<parts.length;i++){
   const before=sum?used/sum:i/parts.length;used+=widths[i]!;const after=sum?used/sum:(i+1)/parts.length;
   const a=g.direction==='rtl'?(1-before)*g.advance:before*g.advance,b=g.direction==='rtl'?(1-after)*g.advance:after*g.advance,height=lines[g.line]!.height;
   const start=g.logicalIndex+i,end=start+1,rect=bounds([point(g,a,0),point(g,b,0),point(g,a,height),point(g,b,height)]);
   const caret=(distance:number)=>bounds([point(g,distance,0),point(g,distance+1,0),point(g,distance,height),point(g,distance+1,height)]);
   cells.push(Object.freeze({start,end,line:g.line,rect}));starts.set(JSON.stringify([g.line,start]),caret(a));ends.set(JSON.stringify([g.line,end]),caret(b));
  }
 }
 const carets:ProductionLogicalCaret[]=[],intervals=ranges.map((r,line)=>({...r,line})).sort((a,b)=>a.start-b.start||a.line-b.line),heap:typeof intervals=[];let incoming=0;
 const push=(item:typeof intervals[number])=>{let i=heap.length;heap.push(item);while(i>0){const parent=(i-1)>>1;if(heap[parent]!.line>=item.line)break;heap[i]=heap[parent]!;i=parent;}heap[i]=item;};
 const pop=()=>{const last=heap.pop();if(!heap.length||!last)return;let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&heap[child+1]!.line>heap[child]!.line)child++;if(heap[child]!.line<=last.line)break;heap[i]=heap[child]!;i=child;}heap[i]=last;};
 for(let offset=0;offset<=clusters.length;offset++){
  while(incoming<intervals.length&&intervals[incoming]!.start<=offset)push(intervals[incoming++]!);while(heap.length&&heap[0]!.end<offset)pop();
  const row=heap[0]?.line;if(row===undefined)continue;const line=lines[row]!,rect=starts.get(JSON.stringify([row,offset]))??ends.get(JSON.stringify([row,offset]))??Object.freeze([line.x,line.y,1,line.height] as const);
  carets.push(Object.freeze({offset,line:row,rect}));
 }
 const byOffset=new Map(carets.map(c=>[c.offset,c]));
 return Object.freeze({cells:Object.freeze(cells),carets:Object.freeze(carets),lines:ranges,caret:(offset:number)=>byOffset.get(offset),selection:(from:number,to:number)=>mergeProductionTextRanges(cells,Math.min(from,to),Math.max(from,to))});
}
/** Shared by original selection controls and readers of the serialized font result. */
export function mergeProductionTextRanges(cells:readonly ProductionLogicalCell[],from:number,to:number):readonly Rect[]{
 const selected=cells.filter(c=>c.start>=from&&c.end<=to).sort((a,b)=>a.line-b.line||a.rect[1]-b.rect[1]||a.rect[0]-b.rect[0]),output:Rect[]=[];let row=-1;
 for(const c of selected){const r=c.rect,p=output.at(-1);if(p&&row===c.line&&Math.abs(p[1]-r[1])<1e-9&&Math.abs(p[3]-r[3])<1e-9&&r[0]<=p[0]+p[2]+1e-9)output[output.length-1]=Object.freeze([p[0],p[1],Math.max(p[0]+p[2],r[0]+r[2])-p[0],p[3]]);else{output.push(r);row=c.line;}}
 return Object.freeze(output);
}
