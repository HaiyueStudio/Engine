import type {GuiButton} from '@haiyue/engine/gui';
import {Composite,button,number,fail} from '../gui-common/composite.js';
import type {GuiRateOptions} from './types.js';
export class GuiRate extends Composite {
  readonly stars:readonly GuiButton[];private current:number;private readonly count:number;private halfIndex=-1;
  constructor(private readonly options:GuiRateOptions={}){
    super('GuiRate',{direction:'row',columnGap:2,width:'auto'},options,undefined,options.focusManager);this.count=number(options.count??5,'star count',1,20);if(!Number.isInteger(this.count))fail('Star count must be an integer.');this.current=this.checked(options.value??0);
    this.stars=Object.freeze(Array.from({length:this.count},(_,index)=>{const node=this.part('star',button('☆',this.action(()=>{if(options.readOnly)return;const value=index+1-(options.allowHalf&&this.halfIndex===index?.5:0);this.halfIndex=-1;this.setValue(options.allowClear&&value===this.current?0:value,true);}),{width:32,height:36},{disabled:options.readOnly??false,onPointerDown:event=>{this.halfIndex=event.localX<16?index:-1;},onAction:event=>{if(!options.readOnly&&(event.action==='left'||event.action==='right')){this.setValue(Math.min(this.count,Math.max(0,this.current+(event.action==='right'?1:-1)*(options.allowHalf?.5:1))),true);event.consume();}}}));node.setDefaultSkin(theme=>({backgroundColor:'transparent',borderWidth:0,padding:0,color:theme.colors.warning??'#d6a333',fontSize:26}));return node;}));this.sync();this.finish();
  }
  private checked(value:number):number {number(value,'rating',0,this.count);if(!Number.isInteger(value/(this.options.allowHalf?.5:1)))fail('Rating must respect the selected step.');return value;}
  get value():number{return this.current;}
  setValue(value:number,emit=false):void {this.alive();const next=this.checked(value),changed=next!==this.current;this.current=next;this.sync();if(changed&&emit)this.options.onChange?.(next);}
  private sync():void {this.stars.forEach((star,index)=>star.setText(this.current>=index+1?'★':this.current>index?'◐':'☆'));}
}
