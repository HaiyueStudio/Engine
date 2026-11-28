import type {GuiButton} from '@haiyue/engine/gui';
import {Composite,button,choice,fail} from '../gui-common/composite.js';
import {setContentContainerStyle} from '../gui-layout/presets.js';
import type {GuiStepsOptions} from './types.js';
export class GuiSteps extends Composite {
  readonly buttons:readonly GuiButton[];private current:string;
  constructor(private readonly options:GuiStepsOptions){
    super('GuiSteps',{direction:choice(options.direction??'horizontal',['horizontal','vertical'],'step direction')==='horizontal'?'row':'column',columnGap:12,rowGap:8,width:480},options,undefined,options.focusManager);
    const keys=new Set<string>();if(!options.items.length||options.items.length>256)fail('Steps require 1–256 items.');for(const item of options.items){if(!item.key||keys.has(item.key))fail('Steps require unique keys.');keys.add(item.key);}this.current=options.currentKey??options.items[0]!.key;if(!keys.has(this.current))fail('Unknown current step.');
    this.buttons=Object.freeze(options.items.map((item,index)=>{const node=this.part('item',button(item.content?'':`${index+1}  ${item.title}${item.description?' · '+item.description:''}`,this.action(()=>{this.setCurrent(item.key);options.onChange?.(item.key);}),{height:48,grow:options.direction==='vertical'?0:1,minWidth:0},{disabled:item.disabled??!options.onChange}));node.setDefaultSkin((theme,state)=>({color:item.status==='error'?theme.colors.danger:item.key===this.current?theme.colors.primary:theme.colors.textMuted,backgroundColor:item.key===this.current?theme.colors.hover:'transparent',borderColor:item.key===this.current?theme.colors.primary:theme.colors.border,borderWidth:1,radius:8}));return node;}));try{for(let i=0;i<options.items.length;i++){const node=this.buttons[i]!,item=options.items[i]!;if(item.content){setContentContainerStyle(node,{direction:'column',height:48,grow:options.direction==='vertical'?0:1,minWidth:0,padding:{left:8,right:8,top:4,bottom:4}});this.mount([{name:'content',node:item.content,parent:node,layout:{grow:1,minWidth:0}}]);}}}catch(error){this.dispose();throw error;}this.setCurrent(this.current);this.finish();
  }
  get currentKey():string{return this.current;}
  setCurrent(key:string):void {this.alive();if(!this.options.items.some(item=>item.key===key))fail('Unknown current step.');this.current=key;this.buttons.forEach((node,index)=>node.setVisualState({selected:this.options.items[index]!.key===key}));}
}
