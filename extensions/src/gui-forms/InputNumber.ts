import {GuiInput} from '@haiyue/engine/gui';
import type {GuiActionEvent} from '@haiyue/engine/gui';
import {Composite,button,number,fail} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiInputNumberOptions} from './types.js';
class NumberInput extends GuiInput {
  stepValue:((delta:number)=>void)|undefined;commitValue:(()=>void)|undefined;
  override handleAction(event:GuiActionEvent):void {if(!this.isComposing&&(event.action==='up'||event.action==='down')){this.stepValue?.(event.action==='up'?1:-1);event.consume();}else super.handleAction(event);}
  override handleBlur():void {super.handleBlur();this.commitValue?.();}
}
export class GuiInputNumber extends Composite {
  readonly input:GuiInput;private current:number|null;private readonly min:number;private readonly max:number;private readonly step:number;private readonly precision:number;
  constructor(private readonly options:GuiInputNumberOptions={}){
    super('GuiInputNumber',{direction:'row',alignItems:'center',columnGap:4,width:180},options,undefined,options.focusManager);
    this.min=number(options.min??-1e12,'minimum',-1e12,1e12);this.max=number(options.max??1e12,'maximum',this.min,1e12);this.step=number(options.step??1,'step',Number.EPSILON,1e12);const [fraction,exponent='0']=String(this.step).split('e');this.precision=number(options.precision??Math.min(12,Math.max(0,(fraction!.split('.')[1]??'').length-Number(exponent))),'precision',0,12);if(!Number.isInteger(this.precision))fail('Precision must be an integer.');
    this.current=this.clamp(options.value??null);const input=this.part('input',new NumberInput({value:this.format(this.current),placeholder:options.placeholder??'',inputType:'text',onSubmit:this.action(()=>{this.commit();})}));this.input=input;setContainerStyle(input,{grow:1,basis:0,minWidth:24,height:32});input.stepValue=delta=>this.increment(delta);input.commitValue=this.action(()=>{this.commit();});this.releases.push(()=>{input.stepValue=undefined;input.commitValue=undefined;input.onSubmit=null;});
    for(const [part,text,delta]of [['decrease','−',-1],['increase','+',1]] as const)this.part(part,button(text,this.action(()=>this.increment(delta)),{width:28})).setDefaultSkin(()=>({padding:0,paddingY:0}));this.finish();
  }
  get value():number|null{return this.current;}
  private clamp(value:number|null):number|null {if(value===null)return null;number(value,'number value',-Number.MAX_VALUE,Number.MAX_VALUE);const bounded=Math.min(this.max,Math.max(this.min,value));return Math.min(this.max,Math.max(this.min,Number(bounded.toFixed(this.precision))));}
  private format(value:number|null):string{return value===null?'':String(value);}
  setValue(value:number|null,emit=false):void {this.alive();const next=this.clamp(value),changed=next!==this.current;this.current=next;this.input.cancelComposition();this.input.setValue(this.format(next));this.input.setVisualState({invalid:false});if(changed&&emit)this.options.onChange?.(next);}
  private parsed():number|null|undefined {if(this.input.isComposing)return undefined;const text=this.input.value.trim();if(text!==''&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)||!Number.isFinite(Number(text))){this.input.setVisualState({invalid:true});return undefined;}return text===''?null:Number(text);}
  commit():boolean {this.alive();const value=this.parsed();if(value===undefined)return false;this.setValue(value,true);return true;}
  increment(delta:number):void {this.alive();number(delta,'step count',-1e6,1e6);const value=this.parsed();if(value===undefined)return;this.setValue((this.clamp(value)??0)+delta*this.step,true);}
}
