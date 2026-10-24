import type {ProductionTextResult} from './types.js';
import {textFail} from './snapshot.js';
import {mergeProductionTextRanges} from '../parameterized/ProductionTextGeometry.js';
const readers=new WeakMap<ProductionTextResult,ReturnType<typeof createReader>>();
/** Reads the original shaping result; it owns no text buffer, undo state, sampler or device listener. */
export function productionTextEditing(result:ProductionTextResult){let reader=readers.get(result);if(!reader){reader=createReader(result);readers.set(result,reader);}return reader;}
function createReader(result:ProductionTextResult){
 const value=result.editing;if(!value)textFail('E_HYA_RUNTIME_HOST_PORT','$.text.editing','the prepared font port did not provide actual editing geometry');
 const byOffset=new Map(value.carets.map(c=>[c.offset,c])),rows=new Map<number,{left:number;top:number;right:number;bottom:number}>();
 for(const c of value.carets){const r=c.rect,b=rows.get(c.line);if(b){b.left=Math.min(b.left,r[0]);b.top=Math.min(b.top,r[1]);b.right=Math.max(b.right,r[0]+r[2]);b.bottom=Math.max(b.bottom,r[1]+r[3]);}else rows.set(c.line,{left:r[0],top:r[1],right:r[0]+r[2],bottom:r[1]+r[3]});}
 return Object.freeze({text:value.text,caret(offset:number){const c=byOffset.get(offset);if(!c)textFail('E_HYA_RUNTIME_TEXT','$.text.editing.offset','offset has no visible shaped grapheme caret');return c.rect;},ranges(from:number,to:number){if(!byOffset.has(from)||!byOffset.has(to))textFail('E_HYA_RUNTIME_TEXT','$.text.editing.range','selection endpoints must be visible shaped grapheme boundaries');return mergeProductionTextRanges(value.cells,Math.min(from,to),Math.max(from,to));},indexAt(x:number,y:number):number{
  if(!Number.isFinite(x)||!Number.isFinite(y))textFail('E_HYA_RUNTIME_TEXT','$.text.editing.point','hit coordinates must be finite');
  let row:number|undefined,vertical=Infinity,horizontal=Infinity;for(const[i,r]of rows){const dy=Math.max(r.top-y,0,y-r.bottom),dx=Math.max(r.left-x,0,x-r.right);if(dy<vertical||dy===vertical&&dx<horizontal){row=i;vertical=dy;horizontal=dx;}}
  let found:number|undefined,best=Infinity;for(const c of value.carets)if(c.line===row){const dx=x-c.rect[0],dy=Math.max(c.rect[1]-y,0,y-c.rect[1]-c.rect[3]),d=dx*dx+dy*dy;if(d<best||d===best&&c.offset>(found??-1)){best=d;found=c.offset;}}
  if(found===undefined)textFail('E_HYA_RUNTIME_TEXT','$.text.editing.point','visible line has no shaped caret');return found;
 }});
}
