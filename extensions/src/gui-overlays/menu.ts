import {GuiElement,GuiButton,GuiScrollView,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiActionEvent,GuiPointerEvent} from '@haiyue/engine/gui';
import {Composite,surface,textElement,button,number,fail,within} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {headerStyle} from '../gui-layout/panel-content.js';
import {OverlayController,validateOverlayTrigger} from './overlay.js';
import type {GuiMenuItem,GuiMenuOptions,GuiDropdownOptions,GuiContextMenuOptions} from './types.js';
interface Entry {item:GuiMenuItem;row:GuiElement;button:GuiButton|null;}
const owners=new WeakMap<MenuCore,OverlayController>();
function capture(items:readonly GuiMenuItem[]):readonly GuiMenuItem[]{
  const keys=new Set<string>();let count=0;
  const walk=(values:readonly GuiMenuItem[],depth:number):readonly GuiMenuItem[]=>{
    if(!Array.isArray(values)||depth>16)fail('Invalid menu tree or depth.');
    return Object.freeze(values.map(item=>{if(++count>1000||!item||typeof item.key!=='string'||!item.key||keys.has(item.key)||item.type!==undefined&&!['item','separator'].includes(item.type)||item.type!=='separator'&&typeof item.label!=='string'||['disabled','danger','checked'].some(key=>Object.hasOwn(item,key)&&typeof item[key as keyof GuiMenuItem]!=='boolean'))fail('Menus require unique keys and valid bounded data.');keys.add(item.key);headerStyle(item);if(item.shortcut!==undefined&&typeof item.shortcut!=='string')fail('Invalid menu shortcut.');return Object.freeze({...item,...(item.children?{children:walk(item.children,depth+1)}:{})});}));
  };return walk(items,1);
}
/** All menu forms share these rows, actions, submenus and disposal. No new sampler or focus manager. */
export class MenuCore extends Composite {
  readonly list:GuiScrollView;
  private entries:Entry[]=[];
  private child:{menu:MenuCore;overlay:OverlayController;key:string}|undefined;
  constructor(private readonly options:GuiMenuOptions){
    const items=capture(options.items);
    if(items.some(i=>i.children?.length)&&(!options.root||!options.focusManager))fail('Submenus borrow the live root and focus manager.');
    super('GuiMenu',{direction:'column',width:240,height:Math.min(360,Math.max(36,items.length*36)),minHeight:0},{style:options.style,...(options.root?{root:options.root}:{})},theme=>({parts:{item:{padding:8,paddingY:4,borderWidth:0,borderColor:'transparent',radius:4},shortcut:{color:theme.colors.textMuted,fontSize:11},separator:{backgroundColor:theme.colors.border}}}),options.focusManager);
    this.list=this.part('list',new GuiScrollView({contentHeight:items.length*36,showScrollbar:true}));setContainerStyle(this.list,{direction:'column',width:'auto',height:'auto',grow:1,basis:0,minHeight:0});this.setItems(items);this.finish();
  }
  get buttons():readonly GuiButton[]{return Object.freeze(this.entries.flatMap(e=>e.button?[e.button]:[]));}
  setItems(items:readonly GuiMenuItem[]):void {
    this.alive();const data=capture(items);if(data.some(i=>i.children?.length)&&(!this.options.root||!this.options.focusManager))fail('Submenus require the live root and focus manager.');this.closeChild();
    const focusKey=this.entries.find(e=>e.button===this.focus?.focused)?.item.key;
    for(const entry of this.entries){this.blurWithin(entry.row);this.forget(entry.row);}
    this.entries=[];let total=0;
    for(const item of data){
      if(item.type==='separator'){const row=this.part('separator',surface('GuiMenuSeparator',{height:1,width:{percent:100},margin:{top:5,bottom:5},shrink:0}),this.list);this.entries.push({item,row,button:null});total+=11;continue;}
      const row=this.part('row',surface('GuiMenuRow',{direction:'row',width:{percent:100},height:34,alignItems:'center',columnGap:4,shrink:0},{pointerFilter:'stop'}),this.list),entry:Entry={item,row,button:null};
      const node=this.part('item',button((item.checked?'✓ ':'')+(item.label??''),this.action(()=>this.activate(entry)),{grow:1,basis:0,height:32,minWidth:0},{themeControlType:'GuiMenuItem',disabled:item.disabled??false,style:headerStyle(item),onAction:event=>this.move(entry,event)}),row);entry.button=node;
      node.setDefaultSkin((theme,state)=>({color:state.disabled?theme.colors.disabledText??theme.colors.textMuted:item.danger?theme.colors.danger:theme.colors.text,backgroundColor:state.focus||state.hover?theme.colors.hover:'transparent'}));
      if(item.shortcut)this.part('shortcut',textElement(item.shortcut,{width:'auto',height:28}),row);
      if(item.children?.length)this.part('arrow',textElement('›',{width:16,height:28}),row);
      row.on('click',event=>{if(event.target===row)this.activate(entry);});node.on('pointerenter',()=>{if(!this.dead&&!item.disabled){if(item.children?.length)this.openChild(entry);else this.closeChild();}});
      this.entries.push(entry);total+=34;
    }
    this.list.setContentHeight(total);this.element.markDirty(GuiDirtyFlags.Children|GuiDirtyFlags.Layout);
    if(focusKey!==undefined)this.focus?.focus(this.entries.find(e=>e.item.key===focusKey&&!e.item.disabled)?.button??this.buttons.find(b=>!b.disabled)??null);
  }
  private activate(entry:Entry):void {if(this.dead||entry.item.disabled||!this.entries.includes(entry))return;if(entry.item.children?.length)this.openChild(entry);else this.options.onSelect?.(entry.item.key);}
  private move(entry:Entry,event:GuiActionEvent):void {
    if(this.dead||event.consumed)return;
    if(event.action==='right'&&entry.item.children?.length){this.openChild(entry);event.consume();return;}
    if(event.action==='left'&&owners.has(this)){owners.get(this)!.close('cancel');event.consume();return;}
    if(event.action!=='up'&&event.action!=='down')return;const entries=this.entries.filter(e=>e.button&&!e.item.disabled),index=entries.indexOf(entry);
    if(entries.length&&this.focus){this.closeChild();this.focus.focus(entries[(index+(event.action==='up'?-1:1)+entries.length)%entries.length]!.button);event.consume();}
  }
  private openChild(entry:Entry):void {
    if(this.child?.key===entry.item.key||!entry.item.children?.length||!entry.button||!this.options.root||!this.focus)return;this.closeChild();
    const menu=new MenuCore({...this.options,items:entry.item.children,onSelect:key=>this.options.onSelect?.(key)});
    let overlay:OverlayController;
    overlay=new OverlayController({root:this.options.root,focusManager:this.focus,anchor:entry.button,placement:'right',align:'start',width:240,height:Math.min(340,entry.item.children.length*34+24),onOpenChange:open=>{if(!open&&this.child?.overlay===overlay)this.closeChild();}},menu.element,undefined,owners.get(this));
    owners.set(menu,overlay);this.child={menu,overlay,key:entry.item.key};overlay.open();this.focus.focus(menu.buttons.find(b=>!b.disabled)??null);
  }
  private closeChild():void {const child=this.child;if(!child)return;this.child=undefined;try{child.overlay.dispose();}finally{child.menu.dispose();}}
  override dispose():void {if(this.dead)return;try{this.closeChild();}finally{this.entries=[];super.dispose();}}
}
export class GuiMenu extends MenuCore {constructor(options:GuiMenuOptions){super(options);}}
export class GuiDropdown extends OverlayController {
  readonly menu:GuiMenu;
  constructor(options:GuiDropdownOptions){
    validateOverlayTrigger(options,options.trigger??'click');
    let selected:(key:string)=>void=()=>{};
    const menu=new GuiMenu({items:options.items,root:options.root,focusManager:options.focusManager,style:options.style,onSelect:key=>selected(key)});
    try{super({...options,height:options.height??Math.min(360,Math.max(48,options.items.length*34+24))},menu.element);}catch(error){menu.dispose();throw error;}
    this.menu=menu;owners.set(menu,this);selected=key=>{this.close('select');options.onSelect?.(key);};this.releaseWith(()=>menu.dispose());this.bindTrigger(options.trigger??'click');
  }
  setItems(items:readonly GuiMenuItem[]):void {this.alive();this.menu.setItems(items);}
  override open():boolean {const opened=super.open();if(opened)this.options.focusManager.focus(this.menu.buttons.find(button=>!button.disabled)??null);return opened;}
}
export class GuiContextMenu extends GuiDropdown {
  constructor(options:GuiContextMenuOptions){
    const duration=number(options.longPressMs??500,'long press duration',250,2000);super({...options,trigger:'manual'});
    const anchor=options.anchor;if(!anchor){this.dispose();fail('Context menus require an anchor.');}
    let pending:{x:number;y:number;id:number;timer:GuiElement}|undefined;
    const clear=()=>{const p=pending;pending=undefined;if(p){p.timer.setActivity(null);p.timer.parent?.remove(p.timer);}};
    const down=(event:{detail:GuiPointerEvent})=>{const p=event.detail;if(p.button===2){clear();p.preventDefault();p.stopPropagation();this.openAt({x:p.x,y:p.y});}
      else if(p.nativeEvent?.pointerType==='touch'){clear();const timer=new GuiElement({width:1,height:1,pointerFilter:'ignore'});pending={x:p.x,y:p.y,id:p.pointerId,timer};options.root.add(timer);let elapsed=0;timer.setActivity(delta=>{elapsed+=delta;if(!anchor.isEffectivelyVisible()){clear();return false;}if(elapsed>=duration){const value=pending;clear();if(value)this.openAt({x:value.x,y:value.y});return false;}},{motion:false});}};
    const move=(event:{detail:GuiPointerEvent})=>{const p=event.detail;if(pending&&Math.hypot(p.x-pending.x,p.y-pending.y)>8)clear();};
    anchor.on('pointerdown',down);anchor.on('pointermove',move);anchor.on('pointerup',clear);anchor.on('pointercancel',clear);
    this.releaseWith(()=>{clear();anchor.off('pointerdown',down);anchor.off('pointermove',move);anchor.off('pointerup',clear);anchor.off('pointercancel',clear);});
  }
}
