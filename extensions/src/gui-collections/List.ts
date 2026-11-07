import {EngineError,EngineErrorCode} from '@haiyue/engine/core';
import {GuiElement,GuiScrollView,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiActionEvent} from '@haiyue/engine/gui';
import {collectionWindow} from '../collections/window.js';
import type {GuiCollectionRow,GuiVirtualList,GuiVirtualListOptions} from './types.js';

export const invalid=(message:string)=>new EngineError(EngineErrorCode.GuiCollectionLimit,message,{docsPath:'errors/E_GUI_COLLECTION_LIMIT'});
export function collectionNotify(element:GuiElement,event:string):void {
  const path:GuiElement[]=[];for(let node:GuiElement|null=element;node;node=node.parent)path.unshift(node);
  element.emit(event,{target:element,path,bubbles:true});
}
function contains(parent:GuiElement,node:GuiElement|null):boolean {for(;node;node=node.parent)if(node===parent)return true;return false;}
function focusedElement(node:GuiElement):GuiElement|null {if(node.focused)return node;for(const child of node.children){const value=focusedElement(child);if(value)return value;}return null;}
function focused(node:GuiElement):boolean {return focusedElement(node)!==null;}
class RowHost extends GuiElement {
  place(index:number,rowHeight:number):void {const y=index*rowHeight;if(this.y!==y){this.y=y;this.markDirty(GuiDirtyFlags.Layout|GuiDirtyFlags.Visual);}}
}
type Slot<T>={row:GuiCollectionRow<T>;host:RowHost;key:string|null;item:T|undefined;index:number;unbind:(()=>void)|null};

/** A bounded set of original GUI subtrees; logical data never becomes GUI children. */
export class VirtualList<T> implements GuiVirtualList<T> {
  readonly element:GuiScrollView;
  private items:readonly T[]=[];
  private keys:string[]=[];
  private indices=new Map<string,number>();
  private slots:Slot<T>[]=[];
  private selection:string|null=null;
  private dead=false;
  private changing=false;
  private first=0;
  private last=0;
  private readonly overscan:number;
  private readonly maxItems:number;
  private readonly unsubscribers:(()=>void)[]=[];
  private readonly viewportChanged=()=>{if(!this.changing&&!this.dead)this.change(()=>this.refresh());};
  private readonly focusChanged=(event:{target:GuiElement})=>{
    if(this.changing||this.dead)return;
    const slot=this.slots.find(slot=>contains(slot.host,event.target));
    if(slot?.key!==null&&slot?.key!==undefined){
      this.setSelection(slot.key);
      if(event.target===slot.host||event.target.focusOptions.mode==='none')this.focusKey(slot.key);
    }
  };
  constructor(private readonly options:GuiVirtualListOptions<T>,private readonly enabled:(item:T)=>boolean=()=>true,private readonly extraAction?:(event:GuiActionEvent)=>void) {
    this.maxItems=options.maxItems??100000;this.overscan=options.overscan??2;
    if(!Number.isInteger(this.maxItems)||this.maxItems<1||this.maxItems>1000000||!Number.isInteger(this.overscan)||this.overscan<0||this.overscan>32||!Number.isFinite(options.rowHeight)||options.rowHeight<=0||!Number.isFinite(options.height)||options.height<=0||Math.ceil(options.height/options.rowHeight)+1+this.overscan*2>256||typeof options.keyOf!=='function'||typeof options.createRow!=='function')throw invalid('Invalid collection geometry, callbacks or limits.');
    this.element=new GuiScrollView({width:'100%',height:options.height,...(options.style?{style:options.style}:{}),onAction:event=>this.action(event)});
    // Give scroll clamping its declared viewport before first root layout.
    this.element.layout({x:0,y:0,width:0,height:options.height});
    this.element.on('gui:viewport',this.viewportChanged);
    this.element.on('gui:collection-focused',this.focusChanged);
    if(options.focus)this.unsubscribers.push(options.focus.subscribe(()=>{const target=options.focus!.focused;if(target)this.focusChanged({target});}));
    try{this.setItems(options.items);}catch(error){this.dispose();throw error;}
  }
  get selectedKey():string|null {return this.selection;}
  get stats(){return Object.freeze({logicalItems:this.items.length,first:this.first,last:this.last,rowInstances:this.slots.length,boundRows:this.slots.filter(s=>s.key!==null).length});}
  private alive():void {if(this.dead)throw invalid('Collection is disposed.');if(this.changing)throw invalid('Collection mutation from a row lifecycle callback is not allowed.');}
  private change(action:()=>void):void {this.changing=true;try{action();}finally{this.changing=false;}}
  private checked(items:readonly T[]):{items:readonly T[];keys:string[];indices:Map<string,number>} {
    if(!Array.isArray(items)||items.length>this.maxItems||!Number.isFinite(items.length*this.options.rowHeight))throw invalid('Logical item limit exceeded.');
    const copy=Array.from(items),keys:string[]=[],indices=new Map<string,number>();
    for(let i=0;i<copy.length;i++){if(!(i in items))throw invalid('Sparse collections are not supported.');const key=this.options.keyOf(copy[i]!);if(typeof key!=='string'||!key||indices.has(key))throw invalid('Collection keys must be nonempty and unique.');keys.push(key);indices.set(key,i);}
    return {items:copy,keys,indices};
  }
  setItems(items:readonly T[]):void {
    this.alive();const next=this.checked(items),oldKeys=this.keys,anchor=Math.floor(this.element.scrollY/this.options.rowHeight),fraction=this.element.scrollY-anchor*this.options.rowHeight;
    const oldFocus=this.slots.find(s=>focused(s.host))?.key??null;
    const oldFocusedElement=focusedElement(this.element);
    const fallback=(key:string|null):string|null=>{
      if(key!==null&&next.indices.has(key))return key;
      const index=key===null?-1:oldKeys.indexOf(key);
      const eligible=(key:string)=>{const i=next.indices.get(key);return i!==undefined&&this.enabled(next.items[i]!);};
      for(let i=index+1;i<oldKeys.length;i++)if(eligible(oldKeys[i]!))return oldKeys[i]!;
      for(let i=index-1;i>=0;i--)if(eligible(oldKeys[i]!))return oldKeys[i]!;
      return next.keys.find(eligible)??null;
    };
    const anchorKey=fallback(oldKeys[anchor]??null),focusKey=oldFocus===null?null:fallback(oldFocus),selection=this.selection===null?null:fallback(this.selection);
    const selectionChanged=selection!==this.selection;
    this.change(()=>{
      this.items=next.items;this.keys=next.keys;this.indices=next.indices;this.selection=selection;
      this.element.setContentHeight(this.items.length*this.options.rowHeight);
      this.element.scrollTo(anchorKey===null?0:next.indices.get(anchorKey)!*this.options.rowHeight+fraction);
      this.refresh();
    });
    if(oldFocus!==null&&focusKey!==null&&!next.indices.has(oldFocus)){this.scrollToKey(focusKey);this.focusKey(focusKey);}
    else if(oldFocus!==null&&oldFocusedElement){
      const slot=this.slots.find(slot=>slot.key===oldFocus);
      if(slot&&contains(slot.host,oldFocusedElement))this.focusElement(oldFocusedElement);
    }
    if(selectionChanged)this.options.onSelection?.(this.selection);
  }
  setScrollOffset(offset:number):void {this.alive();if(!Number.isFinite(offset))throw invalid('Scroll offset must be finite.');this.element.scrollTo(offset);}
  scrollToKey(key:string,align:'nearest'|'start'|'center'|'end'='nearest'):void {
    this.alive();const index=this.indices.get(key);if(index===undefined||!['nearest','start','center','end'].includes(align))throw invalid('Unknown collection key or scroll alignment.');
    const start=index*this.options.rowHeight,end=start+this.options.rowHeight,offset=this.element.scrollY,height=this.element.rect.height;
    this.setScrollOffset(align==='start'?start:align==='center'?start-(height-this.options.rowHeight)/2:align==='end'?end-height:start<offset?start:end>offset+height?end-height:offset);
  }
  setSelection(key:string|null):void {
    this.alive();if(key!==null&&!this.indices.has(key))throw invalid('Unknown collection selection.');
    if(key===this.selection)return;this.selection=key;this.element.markDirty(GuiDirtyFlags.Visual|GuiDirtyFlags.Input);this.options.onSelection?.(key);
  }
  private focusKey(key:string):void {
    const slot=this.slots.find(slot=>slot.key===key);
    // Row hosts retain logical identity; actual controls own editing and focus paint.
    // The original focus owner rejects ineligible (including layout-hidden) targets.
    const pending=slot?[slot.row.element]:[];
    while(pending.length){
      const target=pending.pop()!;
      if(!target.visible||target.disabled)continue;
      if(target.focusOptions.mode!=='none'){
        this.focusElement(target);
        if(target.focused)return;
      }
      for(let i=target.children.length-1;i>=0;i--)pending.push(target.children[i]!);
    }
    this.focusElement(slot?.host??this.element);
  }
  private focusElement(target:GuiElement):void {
    if(this.options.focus)this.options.focus.focus(target);else collectionNotify(target,'gui:collection-focus');
  }
  navigate(key:string):void {this.scrollToKey(key);this.focusKey(key);this.setSelection(key);}
  private retire(slot:Slot<T>):void {
    if(slot.key===null)return;
    const hadFocus=focused(slot.host);
    const errors:unknown[]=[],run=(action:()=>void)=>{try{action();}catch(error){errors.push(error);}};
    run(()=>collectionNotify(slot.host,'gui:collection-retire'));
    if(hadFocus)run(()=>this.focusElement(this.element));
    const unbind=slot.unbind;slot.unbind=null;slot.key=null;slot.item=undefined;slot.index=-1;
    if(unbind)run(unbind);
    if(errors.length)throw new AggregateError(errors,'Collection row cleanup failed.');
  }
  private refresh():void {
    const window=collectionWindow(this.items.length,this.element.scrollY,this.element.rect.height,this.options.rowHeight,this.overscan);
    if(window.last-window.first>256)throw invalid('Visible row limit exceeded.');
    const wanted=new Set(this.keys.slice(window.first,window.last));
    try{
      for(const slot of this.slots)if(slot.key!==null){
        const key=slot.key,index=this.indices.get(key);
        if(!wanted.has(key))this.retire(slot);
        else if(slot.index!==index||slot.item!==this.items[index!]){this.retire(slot);slot.key=key;}
      }
      const count=window.last-window.first;
      while(this.slots.length>count){const index=this.slots.findIndex(s=>s.key===null),slot=this.slots.splice(index,1)[0]!;this.element.remove(slot.host);slot.row.dispose();}
      while(this.slots.length<count){
        const row=this.options.createRow();
        if(!row||!(row.element instanceof GuiElement)||row.element.parent||typeof row.bind!=='function'||typeof row.dispose!=='function'||this.slots.some(s=>s.row===row||s.row.element===row.element))throw invalid('createRow must return a fresh original GUI row.');
        const host=new RowHost({width:'100%',height:this.options.rowHeight,focus:{mode:'all',tabIndex:-1},pointerFilter:'pass'});host.add(row.element);this.element.add(host);this.slots.push({row,host,key:null,item:undefined,index:-1,unbind:null});
      }
      for(let index=window.first;index<window.last;index++){
        const key=this.keys[index]!,slot=this.slots.find(s=>s.key===key)??this.slots.find(s=>s.key===null)!;
        slot.host.place(index,this.options.rowHeight);slot.host.setDisabled(!this.enabled(this.items[index]!));
        if(slot.unbind===null){slot.key=key;slot.item=this.items[index]!;slot.index=index;const unbind=slot.row.bind(this.items[index]!,key,index);if(typeof unbind!=='function')throw invalid('Row bind must return an unbind function.');slot.unbind=unbind;}
      }
      this.slots.sort((a,b)=>a.index-b.index);
      for(let i=0;i<this.slots.length;i++)this.element.children[i]=this.slots[i]!.host;
      this.first=window.first;this.last=window.last;
      // Child geometry is bounded; no full logical layout tree or per-frame loop.
      const content={...this.element.rect,y:this.element.rect.y-this.element.scrollY,height:this.element.contentHeight};
      for(const slot of this.slots)slot.host.layout(content);
    }catch(error){this.dispose();throw error;}
  }
  private action(event:GuiActionEvent):void {
    if(event.consumed||this.dead)return;
    if(this.extraAction){this.extraAction(event);if(event.consumed)return;}
    if(event.action!=='up'&&event.action!=='down'&&event.action!=='confirm')return;
    let index=this.selection===null?-1:this.indices.get(this.selection)??-1;
    if(index>=0&&!this.enabled(this.items[index]!))index=-1;
    const direction=event.action==='up'?-1:1;
    if(event.action!=='confirm'||index<0){let candidate=index<0?0:index+direction;while(candidate>=0&&candidate<this.items.length){if(this.enabled(this.items[candidate]!)){index=candidate;break;}candidate+=direction;}}
    const key=this.keys[index];if(key!==undefined){this.scrollToKey(key);this.focusKey(key);this.setSelection(key);}event.consume();
  }
  dispose():void {
    if(this.dead)return;this.dead=true;const errors:unknown[]=[],run=(action:()=>void)=>{try{action();}catch(error){errors.push(error);}};
    this.element.off('gui:viewport',this.viewportChanged);this.element.off('gui:collection-focused',this.focusChanged);
    for(const unsubscribe of this.unsubscribers)run(unsubscribe);this.unsubscribers.length=0;
    run(()=>collectionNotify(this.element,'gui:collection-retire'));
    if(contains(this.element,this.options.focus?.focused??null))run(()=>this.options.focus?.blur());
    for(const slot of this.slots){run(()=>this.retire(slot));this.element.remove(slot.host);run(()=>slot.row.dispose());}this.slots=[];this.items=[];this.keys=[];this.indices.clear();this.selection=null;this.first=this.last=0;
    run(()=>this.element.setContentHeight(0));run(()=>this.element.setDisabled(true));run(()=>this.element.setVisible(false));run(()=>{this.element.parent?.remove(this.element);});
    if(errors.length)throw new AggregateError(errors,'Collection disposal failed.');
  }
}
export function createGuiVirtualList<T>(options:GuiVirtualListOptions<T>):GuiVirtualList<T> {return new VirtualList(options);}
