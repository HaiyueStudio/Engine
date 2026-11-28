import {GuiElement,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiButton} from '@haiyue/engine/gui';
import {Composite,button,number,fail,surface,within} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiAnchorOptions,GuiAffixOptions} from './types.js';

export class GuiAnchor extends Composite {
 readonly buttons:readonly GuiButton[];private current:string|null=null;private previousOffset:number;
 constructor(private readonly options:GuiAnchorOptions){
  super('GuiAnchor',{direction:'column',rowGap:4,width:180},options,undefined,options.focusManager);
  if(options.viewport.axis!=='vertical'||!options.items.length||options.items.length>256)fail('Anchor requires a vertical viewport and 1–256 items.');number(options.offset??0,'anchor offset',0,4096);const keys=new Set<string>();
  for(const item of options.items){if(!item.key||keys.has(item.key)||typeof item.label!=='string'||!(item.target instanceof GuiElement))fail('Invalid anchor items.');keys.add(item.key);}
  this.previousOffset=options.viewport.scrollOffset;this.buttons=Object.freeze(options.items.map(item=>this.part('link',button(item.label,this.action(()=>this.activate(item.key)),{height:32}))));
  // Scroll notifications are supplied by the existing viewport, not a polling observer.
  const changed=()=>this.refresh();options.viewport.on('gui:viewport',changed);this.releases.push(()=>options.viewport.off('gui:viewport',changed));this.finish();
 }
 get activeKey():string|null{return this.current;}
 activate(key:string):void {this.alive();const item=this.options.items.find(item=>item.key===key);if(!item||!within(item.target,this.options.viewport))fail('Anchor target is not in the borrowed viewport.');const viewport=this.options.viewport;viewport.scrollTo(viewport.scrollOffset+item.target.rect.y-viewport.rect.y-(this.options.offset??0));this.select(key,true);}
 refresh():void {if(this.dead)return;const viewport=this.options.viewport,delta=viewport.scrollOffset-this.previousOffset;this.previousOffset=viewport.scrollOffset;let nearest:string|null=null,distance=-Infinity;for(const item of this.options.items)if(within(item.target,viewport)&&item.target.visible){const y=item.target.rect.y-delta-viewport.rect.y-(this.options.offset??0);if(y<=1&&y>distance){nearest=item.key;distance=y;}}if(nearest)this.select(nearest,false);}
 private select(key:string,emit:boolean):void {const changed=key!==this.current;this.current=key;this.buttons.forEach((button,i)=>button.setVisualState({selected:this.options.items[i]!.key===key}));if(changed&&emit)this.options.onChange?.(key);}
}

/** Normal-flow placeholder + one offset panel; scrolling and clipping remain viewport-owned. */
export class GuiAffix extends Composite {
 private readonly panel:GuiElement;private offset=-1;private readonly height:number;
 constructor(private readonly options:GuiAffixOptions){
  const height=typeof options.height==='number'?options.height:48;super('GuiAffix',{direction:'column',height,width:{percent:100}},options);
  if(options.viewport.axis!=='vertical')fail('Affix requires a vertical viewport.');number(options.top??0,'affix top',0,4096);number(options.contentOffset??0,'content offset',0,1e9);this.height=number(height,'affix height',1,4096);
  this.panel=this.part('panel',surface('GuiAffixPanel',{position:'absolute',inset:{top:0,left:0,right:0},height}));
  try{this.mount([{name:'content',node:options.content,parent:this.panel,layout:{width:{percent:100},height:{percent:100},minWidth:0,minHeight:0}}]);}catch(error){this.dispose();throw error;}
  const changed=()=>this.refresh();options.viewport.on('gui:viewport',changed);this.releases.push(()=>options.viewport.off('gui:viewport',changed));this.refresh();this.finish();
 }
 get fixed():boolean{return this.offset>0;}
 refresh():void {if(this.dead)return;const viewport=this.options.viewport,max=Math.max(0,viewport.contentHeight-(this.options.contentOffset??0)-this.height),offset=Math.min(max,Math.max(0,viewport.scrollOffset+(this.options.top??0)-(this.options.contentOffset??0)));if(offset===this.offset)return;this.offset=offset;setContainerStyle(this.panel,{position:'absolute',inset:{top:offset,left:0,right:0},height:this.height});this.panel.markDirty(GuiDirtyFlags.Layout);}
}
