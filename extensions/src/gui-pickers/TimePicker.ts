import {Composite,textElement,fail,number} from '../gui-common/composite.js';
import {GuiInputNumber} from '../gui-forms/InputNumber.js';
import type {GuiTimePickerOptions} from './types.js';
function parse(value:string,seconds:boolean):number {if(typeof value!=='string'||!(seconds?/^\d{2}:\d{2}:\d{2}$/:/^\d{2}:\d{2}$/).test(value))fail('Use HH:mm or HH:mm:ss for the selected precision.');const [h,m,s=0]=value.split(':').map(Number);if(h!>23||m!>59||s>59)fail('Invalid wall-clock time.');return h!*3600+m!*60+s;}
function format(value:number,seconds:boolean):string {const parts=[Math.floor(value/3600),Math.floor(value/60)%60];if(seconds)parts.push(value%60);return parts.map(n=>String(n).padStart(2,'0')).join(':');}
export class GuiTimePicker extends Composite {
 readonly hours:GuiInputNumber;readonly minutes:GuiInputNumber;readonly seconds:GuiInputNumber|undefined;
 private current:string|null;private readonly min:number;private readonly max:number;
 constructor(private readonly options:GuiTimePickerOptions={}){
  super('GuiTimePicker',{direction:'row',columnGap:6,width:options.seconds?530:350},options,undefined,options.focusManager);
  this.min=parse(options.min??(options.seconds?'00:00:00':'00:00'),!!options.seconds);this.max=parse(options.max??(options.seconds?'23:59:59':'23:59'),!!options.seconds);if(this.max<this.min)fail('Invalid time interval.');
  for(const step of [options.stepMinutes??1,options.stepSeconds??1]){number(step,'time step',1,60);if(!Number.isInteger(step))fail('Time step must be integral.');}
  const make=(name:string,max:number,step:number)=>{number(step,'time step',1,60);if(!Number.isInteger(step))fail('Time step must be integral.');const n=new GuiInputNumber({...(options.root?{root:options.root}:{}),...(options.focusManager?{focusManager:options.focusManager}:{}),min:0,max,step,precision:0,width:160,onChange:()=>this.changed()});this.part(name,n.element);this.releases.push(()=>n.dispose());return n;};
  this.hours=make('hours',23,1);this.part('separator',textElement(':',{width:8,height:32}));this.minutes=make('minutes',59,options.stepMinutes??1);
  if(options.seconds){this.part('separator',textElement(':',{width:8,height:32}));this.seconds=make('seconds',59,options.stepSeconds??1);}
  this.current=null;try{this.setValue(options.value??null);this.finish();}catch(error){this.dispose();throw error;}
 }
 get value():string|null{return this.current;}
 setValue(value:string|null,emit=false):void {this.alive();let parsed:number|null=null;if(value!==null){parsed=parse(value,!!this.options.seconds);if(parsed<this.min||parsed>this.max)fail('Time is outside its interval.');}const changed=this.current!==value;this.current=value;this.hours.setValue(parsed===null?null:Math.floor(parsed/3600));this.minutes.setValue(parsed===null?null:Math.floor(parsed/60)%60);this.seconds?.setValue(parsed===null?null:parsed%60);if(changed&&emit)this.options.onChange?.(value);}
 private changed():void {if(this.dead)return;const value=(this.hours.value??0)*3600+(this.minutes.value??0)*60+(this.seconds?.value??0),clamped=Math.max(this.min,Math.min(this.max,value));this.setValue(format(clamped,!!this.options.seconds),true);}
}
