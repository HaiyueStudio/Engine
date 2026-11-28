import {GuiElement,GuiProgress} from '@haiyue/engine/gui';
import {Composite,surface,textElement,number,show,flag} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiSpinOptions} from './types.js';
export class GuiSpin extends Composite {
  private readonly content:GuiElement;private readonly indicator:GuiElement;private readonly progress:GuiProgress;
  private stop:()=>void=()=>{};
  private spinning=false;
  constructor(private readonly options:GuiSpinOptions={}){
    const size=number(options.size??28,'spinner size',12,128);number(options.delayMs??0,'spinner delay',0,60000);
    const spinning=flag(options.spinning,'spinner state',true);
    super('GuiSpin',{direction:'column',width:160,minHeight:64},options,theme=>({parts:{label:{color:theme.colors.primary,fontSize:12}}}),options.focusManager);
    this.content=this.part('content',surface('GuiSpinContent',{direction:'column',width:'auto',height:'auto',grow:1}));
    this.indicator=this.part('indicator',surface('GuiSpinIndicator',{position:'absolute',inset:{left:0,right:0,top:0,bottom:0},direction:'column',alignItems:'center',justifyContent:'center',rowGap:8,width:'auto',height:'auto'},{pointerFilter:'stop'}));
    this.progress=this.part('progress',new GuiProgress({variant:'circle',indeterminate:true,strokeWidth:3,width:size,height:size}),this.indicator);setContainerStyle(this.progress,{width:size,height:size});
    if(options.label)this.part('label',textElement(options.label),this.indicator);
    try{this.mount([{name:'contentBody',node:options.content,parent:this.content}]);}catch(error){this.dispose();throw error;}
    this.releases.push(()=>this.stop());this.releases.push(()=>this.progress.setIndeterminate(false));this.setSpinning(spinning);this.finish();
  }
  setSpinning(value:boolean):void {
    this.alive();if(typeof value!=='boolean')throw new TypeError('Invalid spinner state.');if(value)this.blurWithin(this.content);this.spinning=value;this.stop();this.stop=()=>{};show(this.element,value||!!this.options.content);this.content.setDisabled(value);show(this.indicator,value&&(this.options.delayMs??0)===0);this.progress.setIndeterminate(value);
    if(value&&(this.options.delayMs??0)>0){let elapsed=0;this.stop=this.element.setActivity(delta=>{elapsed+=delta;if(elapsed>=(this.options.delayMs??0)||this.element.getTheme().motionScale===0){show(this.indicator,true);return false;}},{motion:false});}
  }
  get isSpinning():boolean{return this.spinning;}
}
