import {GuiButton,GuiDirtyFlags} from '@haiyue/engine/gui';
import type {GuiActionEvent} from '@haiyue/engine/gui';
import {Composite,choice,fail,button} from '../gui-common/composite.js';
import {headerStyle} from '../gui-layout/panel-content.js';
import type {GuiButtonGroupOptions,GuiSegmentedOptions,GuiSelectionItem} from './types.js';

interface Entry {item:GuiSelectionItem;button:GuiButton;release:()=>void;}
function capture(items:readonly GuiSelectionItem[]):readonly GuiSelectionItem[]{
  if(!Array.isArray(items)||items.length>1000)fail('Selection groups accept at most 1000 items.');
  const keys=new Set<string>();return items.map(item=>{
    if(!item||typeof item.key!=='string'||!item.key||keys.has(item.key)||typeof item.label!=='string'||item.disabled!==undefined&&typeof item.disabled!=='boolean')fail('Selection group keys and labels must be valid and unique.');
    headerStyle(item);keys.add(item.key);return Object.freeze({...item});
  });
}
/** Shared selection and roving focus; the original GUI button remains the action owner. */
class SelectionGroup extends Composite {
  private entries:Entry[]=[];
  private current:string|null=null;
  private readonly selection:'none'|'single';
  private readonly orientation:'horizontal'|'vertical';
  constructor(private readonly options:GuiButtonGroupOptions,private readonly segmented:boolean){
    const items=capture(options.items),orientation=choice(options.orientation??'horizontal',['horizontal','vertical'],'group orientation');
    super(segmented?'GuiSegmented':'GuiButtonGroup',{direction:orientation==='horizontal'?'row':'column',height:'auto',width:'auto',padding:segmented?{left:4,right:4,top:4,bottom:4}:{}},options,theme=>({radius:8,...(segmented?{backgroundColor:theme.colors.hover}:{}),parts:{item:{fontSize:theme.fontSize,states:{disabled:{color:theme.colors.disabledText??theme.colors.textMuted}}}}}),options.focusManager);
    this.orientation=orientation;this.selection=choice(options.selection??'none',['none','single'],'group selection');
    if(options.selectedKey!==undefined&&options.selectedKey!==null&&!items.some(i=>i.key===options.selectedKey&&!i.disabled))fail('Unknown or disabled initial selection.');
    this.current=options.selectedKey??(segmented?items.find(i=>!i.disabled)?.key??null:null);this.setItems(items);this.finish();
  }
  get selectedKey():string|null{return this.current;}
  get buttons():readonly GuiButton[]{return Object.freeze(this.entries.map(e=>e.button));}
  setSelectedKey(key:string|null,emit=false):void {
    this.alive();if(key!==null&&!this.entries.some(e=>e.item.key===key&&!e.item.disabled))fail('Unknown or disabled selection.');
    if(key===this.current)return;this.current=key;this.synchronize();if(emit&&key!==null)this.options.onSelect?.(key);
  }
  setItems(items:readonly GuiSelectionItem[]):void {
    this.alive();const captured=capture(items),old=new Map(this.entries.map(e=>[e.item.key,e])),next:Entry[]=[];
    for(const item of captured){let entry=old.get(item.key);
      if(!entry){const e={} as Entry;const node=this.part('item',button(item.label,this.action(()=>this.choose(e)),{height:32,shrink:0},{themeControlType:this.segmented?'GuiSegmentedItem':'GuiButtonGroupItem',onAction:event=>this.move(e,event)}));entry=Object.assign(e,{item,button:node,release:()=>this.forget(node)});}
      entry.item=item;entry.button.setText(item.label);entry.button.setStyle(headerStyle({icon:item.icon??null}));entry.button.setDisabled(!!item.disabled);next.push(entry);
    }
    for(const entry of this.entries)if(!next.includes(entry)){if(this.focus?.focused===entry.button)this.focus.blur();entry.release();}
    this.entries=next;this.element.children.splice(0,this.element.children.length,...next.map(e=>e.button));
    if(this.current!==null&&!next.some(e=>e.item.key===this.current&&!e.item.disabled))this.current=next.find(e=>!e.item.disabled)?.item.key??null;
    this.synchronize();this.element.markDirty(GuiDirtyFlags.Children|GuiDirtyFlags.Layout|GuiDirtyFlags.Visual);
  }
  private choose(entry:Entry):void {if(this.dead||entry.item.disabled||!this.entries.includes(entry))return;if(this.selection==='single')this.setSelectedKey(entry.item.key,true);else this.options.onSelect?.(entry.item.key);}
  private move(entry:Entry,event:GuiActionEvent):void {
    if(this.dead||event.consumed||!this.entries.includes(entry))return;
    const negative=this.orientation==='horizontal'?'left':'up',positive=this.orientation==='horizontal'?'right':'down';if(event.action!==negative&&event.action!==positive)return;
    const nodes=this.entries.filter(e=>!e.item.disabled),index=nodes.indexOf(entry);if(!nodes.length)return;
    const target=nodes[(index+(event.action===negative?-1:1)+nodes.length)%nodes.length]!;if(this.selection==='single')this.setSelectedKey(target.item.key,true);if(this.focus){this.focus.focus(target.button);event.consume();}
  }
  private synchronize():void {
    const enabled=this.entries.find(e=>!e.item.disabled)?.item.key??null,active=this.current??enabled;
    this.entries.forEach((e,i)=>{
      e.button.setVisualState({selected:e.item.key===this.current});
      e.button.setFocusOptions({mode:'all',tabIndex:this.focus&&e.item.key!==active?-1:0});
      const last=this.entries.length-1,vertical=this.orientation==='vertical',corners:[number,number,number,number]=this.segmented?[5,5,5,5]:[i===0?6:0,(!vertical&&i===last||vertical&&i===0)?6:0,i===last?6:0,(!vertical&&i===0||vertical&&i===last)?6:0];
      e.button.setDefaultSkin((theme,state)=>({backgroundColor:state.selected?this.segmented?theme.colors.elevated??theme.colors.surface:theme.colors.primary:state.hover?theme.colors.hover:this.segmented?'transparent':theme.colors.surface,color:state.disabled?theme.colors.disabledText??theme.colors.textMuted:state.selected&&!this.segmented?theme.colors.onPrimary??'#fff':theme.colors.text,borderColor:this.segmented?'transparent':theme.colors.border,borderWidth:this.segmented?0:1,cornerRadii:corners,padding:12,paddingY:4}));
    });
  }
  override dispose():void {if(this.dead)return;this.entries=[];super.dispose();}
}
export class GuiButtonGroup extends SelectionGroup {constructor(options:GuiButtonGroupOptions){super(options,false);}}
export class GuiSegmented extends SelectionGroup {constructor(options:GuiSegmentedOptions){super({...options,selection:'single'},true);}}
