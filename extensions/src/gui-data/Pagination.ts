import {Composite,button,textElement,number,fail} from '../gui-common/composite.js';
import {GuiInputNumber} from '../gui-forms/InputNumber.js';
import type {GuiPaginationOptions} from './types.js';
export class GuiPagination extends Composite {
  readonly previous:import('@haiyue/engine/gui').GuiButton;readonly next:import('@haiyue/engine/gui').GuiButton;readonly summary:import('@haiyue/engine/gui').GuiLabel;readonly jump:GuiInputNumber|undefined;
  private total:number;private current:number;private size:number;
  constructor(private readonly options:GuiPaginationOptions){
    super('GuiPagination',{direction:'row',columnGap:8,alignItems:'center',width:'auto'},options,undefined,options.focusManager);this.total=this.integer(options.total,'total',0);this.size=this.integer(options.pageSize??10,'page size',1);this.current=this.integer(options.page??1,'page',1);this.current=Math.min(this.pageCount,this.current);
    this.previous=this.part('previous',button('‹',this.action(()=>this.setPage(this.current-1,true)),{width:32}));this.summary=this.part('summary',textElement('',{width:150,height:32}));this.next=this.part('next',button('›',this.action(()=>this.setPage(this.current+1,true)),{width:32}));
    if(options.quickJump){this.jump=new GuiInputNumber({width:120,min:1,max:1e9,value:this.current,onChange:value=>{if(value!==null)this.setPage(value,true);}});this.element.add(this.jump.element);this.releases.push(()=>this.jump?.dispose());}this.sync();this.finish();
  }
  private integer(value:number,name:string,min:number):number {number(value,name,min,1e9);if(!Number.isInteger(value))fail(`${name} must be an integer.`);return value;}
  get page():number{return this.current;}get pageSize():number{return this.size;}get pageCount():number{return Math.max(1,Math.ceil(this.total/this.size));}
  setPage(value:number,emit=false):void {this.alive();this.integer(value,'page',0);const next=Math.max(1,Math.min(this.pageCount,value));if(next===this.current){this.sync();return;}this.current=next;this.sync();if(emit)this.options.onChange?.(next,this.size);}
  setTotal(value:number):void {this.alive();this.total=this.integer(value,'total',0);this.current=Math.min(this.current,this.pageCount);this.sync();}
  setPageSize(value:number,emit=false):void {this.alive();const first=(this.current-1)*this.size;this.size=this.integer(value,'page size',1);this.current=Math.min(this.pageCount,Math.floor(first/this.size)+1);this.sync();if(emit)this.options.onChange?.(this.current,this.size);}
  private sync():void {this.summary.setText(`${this.current} / ${this.pageCount} · ${this.total}`);this.previous.setDisabled(this.current<=1);this.next.setDisabled(this.current>=this.pageCount);this.jump?.setValue(this.current);}
}
