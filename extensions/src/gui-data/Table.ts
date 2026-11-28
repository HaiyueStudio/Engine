import {GuiInput,GuiButton} from '@haiyue/engine/gui';
import {Composite,surface,button,number,fail} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import {createGuiVirtualList} from '../gui-collections.js';
import type {GuiVirtualList} from '../gui-collections.js';
import type {GuiTableOptions,GuiTableColumn} from './types.js';
/** Fixed header and visible cells; all row pooling, scrolling and retirement belong to VirtualList. */
export class GuiTable<T> extends Composite {
  readonly list:GuiVirtualList<T>;readonly headers:readonly GuiButton[];readonly columns:readonly GuiTableColumn<T>[];
  private items:readonly T[];private predicate:((item:T)=>boolean)|null=null;private sort:{column:GuiTableColumn<T>;direction:'asc'|'desc'}|null=null;
  constructor(private readonly options:GuiTableOptions<T>){
    super('GuiTable',{direction:'column',width:480,rowGap:0},options,theme=>({borderColor:theme.colors.border,borderWidth:1,radius:8,clipRadius:8}),options.focusManager);
    if(!Array.isArray(options.columns)||!options.columns.length||options.columns.length>32)fail('Tables require 1–32 columns.');const keys=new Set<string>();this.columns=Object.freeze(options.columns.map(column=>{if(!column.key||keys.has(column.key)||typeof column.text!=='function')fail('Table columns require unique keys and text accessors.');keys.add(column.key);number(column.width,'column width',24,4096);return Object.freeze({...column});}));this.items=options.items;
    const header=this.part('header',surface('GuiTableHeader',{direction:'row',height:36,shrink:0}));header.setDefaultSkin(theme=>({backgroundColor:theme.colors.hover}));
    this.headers=Object.freeze(this.columns.map(column=>this.part('heading',button(column.title,this.action(()=>{if(column.compare)this.setSort(column.key,this.sort?.column.key===column.key&&this.sort.direction==='asc'?'desc':'asc');}),{width:column.width,height:36},{disabled:!column.compare}),header)));
    const rowHeight=number(options.rowHeight??34,'row height',24,256);
    this.list=createGuiVirtualList({items:this.items,keyOf:options.keyOf,rowHeight,height:options.height??240,maxItems:options.maxItems??100000,...(options.focusManager?{focus:options.focusManager}:{}),...(options.onSelection?{onSelection:options.onSelection}:{}),createRow:()=>{
      const element=surface('GuiTableRow',{direction:'row',height:rowHeight,width:{percent:100}},{height:rowHeight});let current:T|undefined,key='';
      const cells=this.columns.map(column=>{const cell=column.editable?new GuiInput({height:rowHeight,onChange:value=>{if(current!==undefined)column.onEdit?.(current,value,key);}}):new GuiButton({height:rowHeight,onClick:()=>{if(key)this.list.setSelection(key);}});cell.setDefaultSkin((theme,state)=>({borderWidth:0,radius:0,backgroundColor:state.focus?theme.colors.hover:'transparent',color:theme.colors.text}));setContainerStyle(cell,{width:column.width,height:rowHeight,shrink:0,minWidth:0});element.add(cell);return cell;});
      return{element,bind:(item:T,itemKey:string)=>{current=item;key=itemKey;for(let i=0;i<cells.length;i++){const cell=cells[i]!,text=this.columns[i]!.text(item);if(cell instanceof GuiInput)cell.setValue(text);else cell.setText(text);}return()=>{current=undefined;key='';for(const cell of cells)if(cell instanceof GuiInput){cell.cancelComposition();cell.onSubmit=null;}};},dispose:()=>{for(const cell of cells){if(cell instanceof GuiInput)cell.onChange=null;cell.removeAllListeners();}}};
    }});this.element.add(this.list.element);this.releases.push(()=>this.list.dispose());this.finish();
  }
  private refresh():void {let items=this.predicate?this.items.filter(this.predicate):[...this.items];if(this.sort){const {column,direction}=this.sort;items=items.map((item,index)=>({item,index})).sort((a,b)=>(direction==='asc'?1:-1)*column.compare!(a.item,b.item)||a.index-b.index).map(entry=>entry.item);}this.list.setItems(items);for(let i=0;i<this.headers.length;i++)this.headers[i]!.setText(this.columns[i]!.title+(this.sort?.column.key===this.columns[i]!.key?(this.sort.direction==='asc'?' ↑':' ↓'):''));}
  setItems(items:readonly T[]):void {this.alive();const previous=this.items;this.items=items;try{this.refresh();}catch(error){this.items=previous;throw error;}}
  setSort(key:string|null,direction:'asc'|'desc'='asc'):void {this.alive();const column=key===null?undefined:this.columns.find(column=>column.key===key);if(key!==null&&!column?.compare||!['asc','desc'].includes(direction))fail('Unknown sortable column or direction.');const previous=this.sort;this.sort=column?{column,direction}:null;try{this.refresh();}catch(error){this.sort=previous;throw error;}}
  setFilter(predicate:((item:T)=>boolean)|null):void {this.alive();const previous=this.predicate;this.predicate=predicate;try{this.refresh();}catch(error){this.predicate=previous;throw error;}}
  setSelection(key:string|null):void {this.alive();this.list.setSelection(key);}
}
