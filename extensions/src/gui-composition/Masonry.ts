import {Composite,surface,number,fail} from '../gui-common/composite.js';
import type {GuiMasonryOptions} from './types.js';
/** Greedy column assignment; all actual measurement and flow use the existing shared layout. */
export class GuiMasonry extends Composite {
 readonly columnHeights:readonly number[];
 constructor(options:GuiMasonryOptions){
  const columns=number(options.columns??3,'masonry columns',1,12),width=number(options.columnWidth??200,'masonry column width',16,4096),gap=number(options.gap??12,'masonry gap',0,128);
  super('GuiMasonry',{direction:'row',alignItems:'start',columnGap:gap,width:columns*width+(columns-1)*gap},options);
  if(!Number.isInteger(columns)||!Array.isArray(options.items)||options.items.length>1000)fail('Invalid masonry columns or item count.');const keys=new Set<string>(),nodes=new Set(),heights=Array<number>(columns).fill(0);
  for(const item of options.items){if(!item.key||keys.has(item.key)||nodes.has(item.content)||item.content.parent)fail('Masonry requires distinct keys and unattached borrowed nodes.');keys.add(item.key);nodes.add(item.content);number(item.height,'masonry height',1,16384);}
  const panels=Array.from({length:columns},()=>this.part('column',surface('GuiMasonryColumn',{direction:'column',rowGap:gap,width,shrink:0}))),entries=[];
  for(const item of options.items){let column=0;for(let i=1;i<columns;i++)if(heights[i]!<heights[column]!)column=i;const slot=this.part('item',surface('GuiMasonryItem',{direction:'column',height:item.height,width,shrink:0}),panels[column]);entries.push({name:'content',node:item.content,parent:slot,layout:{width:{percent:100},height:{percent:100},shrink:0}});heights[column]=heights[column]!+item.height+(heights[column]!>0?gap:0);}
  try{this.mount(entries);}catch(error){this.dispose();throw error;}this.columnHeights=Object.freeze(heights);this.finish();
 }
}
