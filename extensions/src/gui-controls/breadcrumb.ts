import{GuiElement,GuiButton,GuiLabel,GuiDirtyFlags}from'@haiyue/engine/gui';
import type{GuiFocusManager}from'@haiyue/engine/gui';
import{createGuiContainer,setContainerStyle}from'../gui-layout/presets.js';
import{headerStyle}from'../gui-layout/panel-content.js';
import{within}from'../gui-layout/panel-state.js';
import{invalid,live,stableKey,text,flag,array,onClick}from'./common.js';
import{BreadcrumbPopup}from'./breadcrumb-popup.js';
import type{GuiBreadcrumbItem,GuiBreadcrumbOptions}from'./types.js';
interface Entry{item:GuiBreadcrumbItem;element:GuiElement;button:GuiButton;menu:GuiButton|null;separator:GuiLabel;off:readonly(()=>void)[];}
function capture(items:readonly GuiBreadcrumbItem[]):readonly GuiBreadcrumbItem[]{
 array(items);const keys=new Set<string>(),key=(value:string)=>{stableKey(value);if(keys.has(value))invalid('Breadcrumb and menu keys must be unique across the component.');keys.add(value);return value;};
 return Object.freeze(items.map(item=>{
  if(!item||typeof item!=='object')invalid('Invalid breadcrumb item.');
  const id=key(item.key),label=text(item.label),disabled=flag(item.disabled);headerStyle(item);if(item.separator!==undefined)text(item.separator);
  const menu=item.menu;if(menu!==undefined)array(menu);
  const captured=menu?.map(i=>{
   if(!i||typeof i!=='object')invalid('Invalid breadcrumb menu item.');
   headerStyle(i);return Object.freeze({...i,key:key(i.key),label:text(i.label),disabled:flag(i.disabled)});
  });
  return Object.freeze({...item,key:id,label,disabled,...(captured===undefined?{}:{menu:Object.freeze(captured)})});
 }));
}
export class GuiBreadcrumb{
 readonly element:GuiElement;
 private entries:Entry[]=[];
 private current:string|null;
 private explicitNone:boolean;
 private readonly separator:string;
 private readonly focus:GuiFocusManager|undefined;
 private navigate:((key:string)=>void)|undefined;
 private popup:{view:BreadcrumbPopup;trigger:GuiButton}|null=null;
 private dead=false;
 constructor(options:GuiBreadcrumbOptions){
  if(!options||typeof options!=='object')invalid('Breadcrumb options required.');const items=capture(options.items);
  if(options.onNavigate!==undefined&&typeof options.onNavigate!=='function')invalid('Invalid navigation callback.');this.separator=text(options.separator??'/');
  this.current=options.currentKey===undefined?this.fallback(items):options.currentKey;if(this.current!==null&&!items.some(i=>i.key===this.current))invalid('Current breadcrumb key must exist.');this.explicitNone=options.currentKey===null;this.focus=options.focus;this.navigate=options.onNavigate;
  this.element=createGuiContainer('flow',{style:{width:'auto',height:'auto',minWidth:0,alignItems:'center'}});this.element.pointerFilter='ignore';if(options.style)this.element.setStyle(options.style);this.replace(items);
 }
 get currentKey():string|null{return this.current;}
 setItems(items:readonly GuiBreadcrumbItem[]):void{live(this.dead);const captured=capture(items);this.replace(captured);}
 setCurrent(key:string|null):void{live(this.dead);if(key!==null&&!this.entries.some(e=>e.item.key===key))invalid('Unknown breadcrumb key.');this.explicitNone=key===null;if(key===this.current)return;this.closeMenu();this.current=key;this.synchronize();}
 private fallback(items:readonly GuiBreadcrumbItem[]):string|null{return [...items].reverse().find(i=>!i.disabled)?.key??null;}
 private replace(items:readonly GuiBreadcrumbItem[]):void{
  const previous=this.entries,byKey=new Map(previous.map(e=>[e.item.key,e]));
  if(items.length===previous.length&&items.every((item,i)=>['key','label','icon','iconPosition','disabled','separator'].every(k=>Object.is(item[k as keyof GuiBreadcrumbItem],previous[i]!.item[k as keyof GuiBreadcrumbItem]))&&JSON.stringify(item.menu?.map(m=>[m.key,m.label,m.disabled]))===JSON.stringify(previous[i]!.item.menu?.map(m=>[m.key,m.label,m.disabled]))&&item.menu?.every((m,j)=>m.icon===previous[i]!.item.menu?.[j]?.icon)!==false))return;
  this.closeMenu();
  if(!this.explicitNone&&!items.some(i=>i.key===this.current))this.current=this.fallback(items);
  const next=items.map(item=>{let e=byKey.get(item.key);if(e&&!!e.menu!==!!item.menu?.length){this.removeEntry(e);e=undefined;}if(!e)e=this.createEntry(item);e.item=item;e.button.setText(item.label);e.button.setStyle(headerStyle({icon:item.icon??null,iconPosition:item.iconPosition??'left'}));return e;});
  for(const e of previous)if(!next.includes(e))this.removeEntry(e);
  this.entries=next;for(let i=0;i<next.length;i++){const e=next[i]!;e.separator.setText(i===next.length-1?'':e.item.separator??this.separator);e.separator.setVisible(i!==next.length-1);if(e.element.parent!==this.element)this.element.add(e.element);}
  this.element.children.splice(0,this.element.children.length,...next.map(e=>e.element));this.synchronize();this.element.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Children|GuiDirtyFlags.Input);
 }
 private createEntry(item:GuiBreadcrumbItem):Entry{
  const element=createGuiContainer('row',{style:{width:'auto',height:32,minWidth:0,maxWidth:{percent:100},alignItems:'center'}});element.pointerFilter='ignore';
  const button=element.add(new GuiButton({text:item.label,themeControlType:'GuiBreadcrumbItem'}));setContainerStyle(button,{width:'auto',height:32,minWidth:0,shrink:1});
  const menu=item.menu?.length?element.add(new GuiButton({text:'v',themeControlType:'GuiBreadcrumbMenuTrigger'})):null;if(menu)setContainerStyle(menu,{width:28,height:32,shrink:0});
  const separator=element.add(new GuiLabel({text:'',pointerFilter:'ignore',autoWidth:true,themeControlType:'GuiBreadcrumbSeparator'}));setContainerStyle(separator,{width:'auto',height:32,shrink:0,margin:{left:4,right:4}});
  const e:Entry={item,element,button,menu,separator,off:[]};e.off=[onClick(button,()=>{if(!this.dead&&this.entries.includes(e)&&!e.item.disabled&&this.current!==e.item.key)this.navigate?.(e.item.key);}),...(menu?[onClick(menu,()=>this.openMenu(e))]:[])];return e;
 }
 private synchronize():void{
  for(const e of this.entries){const disabled=!!e.item.disabled||this.current===e.item.key;e.button.setDisabled(disabled);e.button.setStyle({cursor:disabled?'default':'pointer'});e.menu?.setDisabled(!!e.item.disabled);}
  if(this.focus&&within(this.focus.focused,this.element)&&this.focus.focused?.disabled)this.focus.focus(this.entries.find(e=>!e.button.disabled)?.button??null);
 }
 private openMenu(e:Entry):void{
  if(this.dead||!this.entries.includes(e)||e.item.disabled||!e.menu||!e.item.menu?.length)return;
  if(this.popup?.trigger===e.menu){this.closeMenu();return;}this.closeMenu();let root=this.element;while(root.parent)root=root.parent;
  const trigger=e.menu,view=new BreadcrumbPopup(trigger,e.item.menu,key=>{this.closeMenu();if(!this.dead)this.navigate?.(key);},()=>this.closeMenu());this.popup={view,trigger};root.add(view);this.focus?.reconcile();this.focus?.focus(view.children.at(-1)?.children.find(c=>!c.disabled)??null);
 }
 private closeMenu():void{const p=this.popup;if(!p)return;this.popup=null;p.view.release();this.focus?.reconcile();this.focus?.focus(p.trigger);}
 private removeEntry(e:Entry):void{if(within(this.focus?.focused??null,e.element))this.focus?.blur();for(const off of e.off)off();e.button.setDisabled(true);e.menu?.setDisabled(true);e.element.parent?.remove(e.element);}
 dispose():void{if(this.dead)return;this.dead=true;this.closeMenu();if(within(this.focus?.focused??null,this.element))this.focus?.blur();this.element.parent?.remove(this.element);for(const e of this.entries)this.removeEntry(e);this.entries=[];this.navigate=undefined;}
}
