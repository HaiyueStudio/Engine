import {GuiElement,GuiDirtyFlags} from '@haiyue/engine/gui';
import {Composite,button,textElement,surface,fail,within} from '../gui-common/composite.js';
import {LatestRequest} from '../gui-common/latest.js';
import {GuiPopover} from '../gui-overlays/popover.js';
import {setContainerStyle} from '../gui-layout/presets.js';
import type {GuiTourOptions} from './types.js';
export class GuiTour extends Composite {
 readonly title:import('@haiyue/engine/gui').GuiLabel;readonly description:import('@haiyue/engine/gui').GuiLabel;
 private readonly backButton:import('@haiyue/engine/gui').GuiButton;private readonly nextButton:import('@haiyue/engine/gui').GuiButton;
 private readonly request=new LatestRequest();private popup:GuiPopover|null=null;private index=-1;private transition=false;private highlight:GuiElement|null=null;private geometry='';
 constructor(private readonly options:GuiTourOptions){
  super('GuiTour',{direction:'column',rowGap:8,width:300,height:180},{root:options.root,style:options.style},undefined,options.focusManager);
  if(!options.steps.length||options.steps.length>256||new Set(options.steps.map(step=>step.key)).size!==options.steps.length||options.steps.some(step=>!step.key||!(step.target instanceof GuiElement)||typeof step.title!=='string'||typeof step.description!=='string'))fail('Invalid tour steps.');
  this.title=this.part('title',textElement('',{height:28},{style:{fontWeight:600,fontSize:17}}));this.description=this.part('description',textElement('',{grow:1,basis:0,height:72}));
  const footer=this.part('footer',surface('GuiTourFooter',{direction:'row',columnGap:6,height:32}));
  this.backButton=this.part('previous',button('Back',this.action(()=>{if(this.index>0)void this.go(this.index-1);}),{width:72}),footer);this.backButton.setDisabled(true);
  this.nextButton=this.part('next',button('Next',this.action(()=>{if(this.index===options.steps.length-1){this.close();options.onFinish?.();}else void this.go(this.index+1);}),{width:72}),footer);
  this.part('close',button('Close',this.action(()=>this.close()),{width:72}),footer);this.releases.push(()=>this.close());this.finish();
 }
 get currentKey():string|null{return this.options.steps[this.index]?.key??null;}
 async start():Promise<boolean>{return this.go(0);}
 async go(index:number):Promise<boolean>{
  this.alive();if(!Number.isInteger(index)||index<0||index>=this.options.steps.length)fail('Invalid tour step.');const step=this.options.steps[index]!,signal=this.request.begin();
  try{await step.prepare?.(signal);if(!this.request.current(signal))return false;if(!within(step.target,this.options.root.root)||!step.target.isEffectivelyVisible())fail('Tour target is not visible in the borrowed root.');
   this.transition=true;try{this.popup?.dispose();this.popup=null;this.removeHighlight();this.title.setText(step.title);this.description.setText(step.description);this.backButton.setDisabled(index===0);this.nextButton.setText(index===this.options.steps.length-1?'Finish':'Next');this.popup=new GuiPopover({root:this.options.root,focusManager:this.options.focusManager,anchor:step.target,content:this.element,width:320,height:204,trigger:'manual',onOpenChange:open=>{if(!open&&!this.transition)this.close();}});this.index=index;if(!this.popup.open()){this.close();return false;}
    this.highlight=surface('GuiTourHighlight',{position:'absolute',width:0,height:0},{pointerFilter:'ignore',style:{backgroundColor:'transparent',borderWidth:2,borderColor:this.options.root.theme.colors.primary,radius:8}});this.options.root.add(this.highlight);this.refresh();
   }finally{this.transition=false;}this.options.onChange?.(step.key);return true;
  }catch(error){if(!this.request.current(signal))return false;this.close();this.description.setText(error instanceof Error?error.message:'Tour step unavailable.');return false;}
 }
 refresh():void {if(this.dead||!this.highlight||this.index<0)return;const target=this.options.steps[this.index]!.target;if(!within(target,this.options.root.root)||!target.isEffectivelyVisible()){this.close();return;}const r=target.rect,origin=this.options.root.root.rect,key=[r.x,r.y,r.width,r.height,origin.x,origin.y].join(',');if(key===this.geometry)return;this.geometry=key;setContainerStyle(this.highlight,{anchors:{left:0,top:0,right:0,bottom:0},offsets:{left:r.x-origin.x-3,top:r.y-origin.y-3},width:r.width+6,height:r.height+6});this.highlight.markDirty(GuiDirtyFlags.Layout);}
 close():void {this.request.cancel();const popup=this.popup;this.popup=null;this.index=-1;this.removeHighlight();if(popup){const old=this.transition;this.transition=true;try{popup.dispose();}finally{this.transition=old;}}}
 private removeHighlight():void {this.geometry='';if(this.highlight){this.highlight.parent?.remove(this.highlight);this.highlight.removeAllListeners();this.highlight=null;}}
}
