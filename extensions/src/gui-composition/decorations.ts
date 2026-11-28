import {Composite,surface,textElement,number,fail} from '../gui-common/composite.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiWatermarkOptions,GuiBorderBeamOptions} from './types.js';
import {GuiDirtyFlags} from '@haiyue/engine/gui';
export class GuiWatermark extends Composite {
 constructor(options:GuiWatermarkOptions){
  super('GuiWatermark',{direction:'column',width:320,height:180},options);const columns=number(options.columns??3,'watermark columns',1,20),rows=number(options.rows??3,'watermark rows',1,20);if(!Number.isInteger(columns)||!Number.isInteger(rows)||typeof options.text!=='string'||options.text.length>256)fail('Invalid watermark grid or text.');
  try{this.mount([{name:'content',node:options.content,parent:this.element,layout:{width:{percent:100},height:{percent:100},minWidth:0,minHeight:0}}]);}catch(error){this.dispose();throw error;}
  const overlay=this.part('overlay',surface('GuiWatermarkOverlay',{position:'absolute',inset:{left:0,right:0,top:0,bottom:0},display:'grid',columns:Array.from({length:columns},()=>({fr:1})),rows:Array.from({length:rows},()=>({fr:1})),alignItems:'center'},{pointerFilter:'ignore'}));
  for(let i=0;i<columns*rows;i++){const text=this.part('mark',textElement(options.text,{minWidth:0},{pointerFilter:'ignore'}),overlay);text.textAlign='center';text.setDefaultSkin(theme=>({color:theme.colors.textMuted,opacity:.22,fontSize:13}));}this.finish();
 }
}
export class GuiBorderBeam extends Composite {
 private elapsed=0;private stop:(()=>void)|undefined;private paused:boolean;private readonly duration:number;private readonly bead:import('@haiyue/engine/gui').GuiElement;private readonly size:number;
 constructor(private readonly options:GuiBorderBeamOptions){
  super('GuiBorderBeam',{direction:'column',width:320,height:160},options,theme=>({borderWidth:1,borderColor:theme.colors.border,radius:10}));this.duration=number(options.durationMs??2400,'beam duration',250,3600000);this.size=number(options.size??6,'beam size',2,64);this.paused=options.paused??false;
  try{this.mount([{name:'content',node:options.content,parent:this.element,layout:{width:{percent:100},height:{percent:100},minWidth:0,minHeight:0}}]);}catch(error){this.dispose();throw error;}
  this.bead=this.part('beam',surface('GuiBorderBeamMarker',{position:'absolute',inset:{left:0,top:0},width:this.size,height:this.size},{pointerFilter:'ignore'},theme=>({backgroundColor:theme.colors.primary,radius:this.size/2,shadow:{color:theme.colors.primary,blur:8}})));this.releases.push(()=>this.stop?.());this.update();this.schedule();this.finish();
 }
 setPaused(paused:boolean):void {this.alive();if(typeof paused!=='boolean')fail('Invalid beam pause state.');this.paused=paused;this.schedule();}
 private schedule():void {this.stop?.();this.stop=undefined;if(!this.paused)this.stop=this.element.setActivity(delta=>{this.elapsed=(this.elapsed+delta)%this.duration;this.update();});}
 private update():void {const width=Math.max(0,this.element.rect.width-this.size),height=Math.max(0,this.element.rect.height-this.size),perimeter=(width+height)*2,t=this.elapsed/this.duration*perimeter;let x=0,y=0;if(t<=width)x=t;else if(t<=width+height){x=width;y=t-width;}else if(t<=width*2+height){x=width-(t-width-height);y=height;}else y=height-(t-width*2-height);setContainerStyle(this.bead,{position:'absolute',inset:{left:x,top:y},width:this.size,height:this.size});this.bead.markDirty(GuiDirtyFlags.Layout);}
}
