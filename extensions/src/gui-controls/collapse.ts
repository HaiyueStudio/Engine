import{GuiElement,GuiButton,GuiDirtyFlags}from'@haiyue/engine/gui';
import type{GuiFocusManager}from'@haiyue/engine/gui';
import{createGuiContainer,ownContentFrame,setContainerStyle}from'../gui-layout/presets.js';
import{within}from'../gui-layout/panel-state.js';
import{headerStyle,iconPosition}from'../gui-layout/panel-content.js';
import{invalid,live,stableKey,text,flag,array,onClick}from'./common.js';
import type{GuiCollapseItem,GuiCollapseOptions}from'./types.js';
interface Entry{item:GuiCollapseItem;section:GuiElement;header:GuiElement;title:GuiButton;arrow:GuiButton;body:GuiElement;off:readonly(()=>void)[];}
function capture(items:readonly GuiCollapseItem[]):readonly GuiCollapseItem[]{
 array(items);const keys=new Set<string>(),nodes=new Set<GuiElement>();
 return Object.freeze(items.map(item=>{if(!item||typeof item!=='object')invalid('Invalid collapse item.');const key=stableKey(item.key),title=text(item.title),disabled=flag(item.disabled),content=item.content,extra=item.extra;headerStyle(item);
  if(keys.has(key)||!(content instanceof GuiElement)||nodes.has(content)||extra!==undefined&&(!(extra instanceof GuiElement)||nodes.has(extra)||extra===content))invalid('Collapse items require distinct keys and borrowed content/extra nodes.');keys.add(key);nodes.add(content);if(extra)nodes.add(extra);
  return Object.freeze({...item,key,title,disabled});}));
}
/** Stable sections retain borrowed business content; only the original input domain changes focus. */
export class GuiCollapse{
 readonly element:GuiElement;
 private entries:Entry[]=[];
 private readonly frames=new Map<GuiElement,()=>void>();
 private expanded=new Set<string>();
 private readonly accordion:boolean;
 private readonly toggleArea:'header'|'icon';
 private readonly indicator:'left'|'right';
 private readonly focus:GuiFocusManager|undefined;
 private change:((keys:readonly string[])=>void)|undefined;
 private dead=false;
 constructor(options:GuiCollapseOptions){
  if(!options||typeof options!=='object')invalid('Collapse options required.');const items=capture(options.items);
  if(options.accordion!==undefined&&typeof options.accordion!=='boolean'||options.toggleArea!==undefined&&!['header','icon'].includes(options.toggleArea)||options.onExpandChange!==undefined&&typeof options.onExpandChange!=='function')invalid('Invalid collapse configuration.');iconPosition(options.expandIconPosition);
  this.accordion=options.accordion??false;this.toggleArea=options.toggleArea??'header';this.indicator=options.expandIconPosition??'left';this.focus=options.focus;this.change=options.onExpandChange;
  const initial=this.keys(options.expandedKeys??[],items);
  this.element=createGuiContainer('column',{style:{width:'auto',height:'auto',minWidth:0,contentMinimum:true}});this.element.pointerFilter='ignore';if(options.style)this.element.setStyle(options.style);
  this.expanded=new Set(initial);this.replace(items);
 }
 setItems(items:readonly GuiCollapseItem[]):void{live(this.dead);this.replace(capture(items));}
 private keys(keys:readonly string[],items:readonly GuiCollapseItem[]=this.entries.map(e=>e.item)):readonly string[]{
  array(keys);const known=new Set(items.map(i=>i.key));if(new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!known.has(k))||this.accordion&&keys.length>1)invalid('Expanded keys must be unique known panel keys and respect accordion mode.');return keys;
 }
 getExpandedKeys():readonly string[]{live(this.dead);return Object.freeze(this.entries.filter(e=>this.expanded.has(e.item.key)).map(e=>e.item.key));}
 setExpandedKeys(keys:readonly string[],notify=false):void{
  live(this.dead);this.keys(keys);if(typeof notify!=='boolean')invalid('Collapse notification flag must be boolean.');const next=new Set(keys);if(next.size===this.expanded.size&&[...next].every(k=>this.expanded.has(k)))return;
  for(const e of this.entries)if(this.expanded.has(e.item.key)&&!next.has(e.item.key))this.focusBeforeHide(e);
  if(this.dead)return;this.expanded=next;this.synchronize();if(notify)this.change?.(this.getExpandedKeys());
 }
 toggle(key:string,notify=false):void{live(this.dead);if(!this.entries.some(e=>e.item.key===key))invalid('Unknown collapse panel.');this.setExpandedKeys(this.expanded.has(key)?[...this.expanded].filter(k=>k!==key):this.accordion?[key]:[...this.expanded,key],notify);}
 private replace(items:readonly GuiCollapseItem[]):void{
  const previous=this.entries,byKey=new Map(previous.map(e=>[e.item.key,e])),itemsByKey=new Map(items.map(i=>[i.key,i])),resources=new Set(items.flatMap(i=>i.extra?[i.content,i.extra]:[i.content]));
  if(items.length===previous.length&&items.every((item,i)=>['key','title','content','extra','icon','iconPosition','disabled'].every(k=>Object.is(item[k as keyof GuiCollapseItem],previous[i]!.item[k as keyof GuiCollapseItem]))))return;
  for(const node of resources)if(node===this.element||within(this.element,node)||node.parent&&!this.frames.has(node))invalid('Collapse cannot steal attached content or form a cycle.');
  const acquired=new Map<GuiElement,()=>void>();try{for(const node of resources)if(!this.frames.has(node))acquired.set(node,ownContentFrame(node,{}));}catch(error){for(const release of acquired.values())release();throw error;}
  const next:Entry[]=[];
  try{for(const item of items){const e=byKey.get(item.key)??this.createEntry(item);next.push(e);}}
  catch(error){for(const release of acquired.values())release();for(const e of next)if(!previous.includes(e))for(const off of e.off)off();throw error;}
  for(const[node,release]of acquired)this.frames.set(node,release);
  const nextEntries=new Set(next);
  for(const old of previous){const n=nextEntries.has(old),item=itemsByKey.get(old.item.key);if(!n||item?.content!==old.item.content||item.extra!==old.item.extra||item.disabled&&!old.item.disabled){if(within(this.focus?.focused??null,old.section))this.focus?.focus(n?this.target(old):next.find(e=>!itemsByKey.get(e.item.key)?.disabled)?.title??null);}}
  if(this.dead){for(const release of acquired.values())release();return;}
  for(const old of previous){const replacement=itemsByKey.get(old.item.key);if(replacement?.content!==old.item.content&&old.item.content.parent===old.body)old.body.remove(old.item.content);if(replacement?.extra!==old.item.extra&&old.item.extra?.parent===old.header)old.header.remove(old.item.extra);if(!nextEntries.has(old)){for(const off of old.off)off();old.section.parent?.remove(old.section);}}
  for(let i=0;i<next.length;i++){
   const e=next[i]!,item=items[i]!;
   e.item=item;e.title.setText(item.title);e.title.setStyle(headerStyle({icon:item.icon??null,iconPosition:item.iconPosition??'left'}));e.title.setDisabled(!!item.disabled);e.arrow.setDisabled(!!item.disabled);e.header.setStyle({cursor:item.disabled||this.toggleArea==='icon'?'default':'pointer'});
   if(item.content.parent!==e.body)e.body.add(item.content);if(item.extra&&item.extra.parent!==e.header)e.header.add(item.extra);
   const headers:GuiElement[]=this.indicator==='left'?[e.arrow,e.title]:[e.title,e.arrow];if(item.extra)headers.push(item.extra);e.header.children.splice(0,e.header.children.length,...headers);e.header.markDirty(GuiDirtyFlags.Children|GuiDirtyFlags.Layout);
   if(e.section.parent!==this.element)this.element.add(e.section);
  }
  this.entries=next;this.element.children.splice(0,this.element.children.length,...next.map(e=>e.section));this.expanded=new Set([...this.expanded].filter(k=>itemsByKey.has(k)));
  for(const[node,release]of this.frames)if(!resources.has(node)){release();this.frames.delete(node);}
  this.synchronize();this.element.markDirty(GuiDirtyFlags.Children|GuiDirtyFlags.Layout|GuiDirtyFlags.Input);
 }
 private createEntry(item:GuiCollapseItem):Entry{
  const section=createGuiContainer('column',{style:{width:{percent:100},height:'auto',minWidth:0,shrink:0,contentMinimum:true}}),header=section.add(createGuiContainer('row',{style:{width:{percent:100},height:36,minWidth:0,alignItems:'center'}})),body=section.add(createGuiContainer('column',{style:{width:{percent:100},height:'auto',minWidth:0,contentMinimum:true}}));section.pointerFilter=body.pointerFilter='ignore';
  const title=header.add(new GuiButton({text:item.title,themeControlType:'GuiCollapseHeader',pointerFilter:this.toggleArea==='icon'?'ignore':'stop',focus:{mode:this.toggleArea==='icon'?'none':'all'}})),arrow=header.add(new GuiButton({text:'>',themeControlType:'GuiCollapseToggle'}));setContainerStyle(title,{width:'auto',height:36,minWidth:0,grow:1,basis:0});setContainerStyle(arrow,{width:32,height:36,shrink:0});
  const e:Entry={item,section,header,title,arrow,body,off:[]},toggle=()=>{if(!this.dead&&!e.item.disabled&&this.entries.includes(e))this.toggle(e.item.key,true);};
  const backgroundClick=(event:{target:unknown})=>{if(event.target===header&&this.toggleArea==='header'&&!e.item.disabled&&!this.dead){this.focus?.focus(this.target(e));toggle();}};header.on('click',backgroundClick);
  e.off=[onClick(title,()=>{if(this.toggleArea==='header')toggle();}),onClick(arrow,toggle),()=>header.off('click',backgroundClick)];return e;
 }
 private target(e:Entry):GuiButton{return this.toggleArea==='icon'?e.arrow:e.title;}
 private focusBeforeHide(e:Entry):void{if(within(this.focus?.focused??null,e.body))this.focus?.focus(e.item.disabled?this.entries.find(other=>!other.item.disabled)?.title??null:this.target(e));}
 private synchronize():void{for(const e of this.entries){const shown=this.expanded.has(e.item.key);if(!shown)this.focusBeforeHide(e);e.body.setVisible(shown);setContainerStyle(e.body,{width:{percent:100},height:'auto',minWidth:0,contentMinimum:true,display:shown?'flex':'none'});e.arrow.setText(shown?'v':'>');}}
 dispose():void{if(this.dead)return;this.dead=true;if(within(this.focus?.focused??null,this.element))this.focus?.blur();this.element.parent?.remove(this.element);for(const e of this.entries){for(const off of e.off)off();e.item.content.parent?.remove(e.item.content);e.item.extra?.parent?.remove(e.item.extra);e.section.parent?.remove(e.section);e.title.setDisabled(true);e.arrow.setDisabled(true);}for(const release of this.frames.values())release();this.frames.clear();this.entries=[];this.expanded.clear();this.change=undefined;}
}
