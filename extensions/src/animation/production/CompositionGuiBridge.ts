import type {ProductionCompositionFrame,GuiTextModel} from './CompositionOwner.js';
import {ProductionCompositionGuiTextBridge} from './CompositionGuiTextBridge.js';
import {GuiElement, type GuiRoot, type GuiSystem, type GuiPointerEvent} from '@haiyue/engine/gui';
import {ProductionFrameError} from './FrameTransaction.js';
import type {ProductionCompositionOwner} from './CompositionOwner.js';
import type {CompositionGuiInput, CompositionGuiTarget} from './CompositionInputOwner.js';

type Action=Parameters<GuiElement['handleAction']>[0];
type Target=ProductionCompositionOwner['guiTargets'][number];
/** Borrow G05 routing/focus/capture and suppress only the subtree painted by the original HYA renderer. */
export class ProductionCompositionGuiBridge {
 readonly element:GuiElement;
 private readonly nodes:GuiTargetElement[]=[];
 private readonly byKey=new Map<string,GuiTargetElement>();
 private release:()=>void=()=>{};
 private unhandled:()=>void=()=>{};
 private readonly text:ProductionCompositionGuiTextBridge;
 private closed=false;
 private synchronizing=false;
 private active=false;
 constructor(private readonly owner:ProductionCompositionOwner,readonly gui:GuiSystem,readonly root:GuiRoot,readonly viewport:()=>readonly[number,number]){
  const targets=owner.guiTargets;
  for(const target of targets)if(!owner.guiBounds(target))throw new ProductionFrameError('E_HYA_RUNTIME_HOST_PORT','$.gui.targets.'+target.id,'GUI navigation requires the original target geometry; custom geometry bounds are not connected yet');
  this.element=root.add(new GuiElement({id:'hya-subtree-'+nextBridge++,width:'100%',height:'100%',pointerFilter:'ignore',visible:false}));
  this.text=new ProductionCompositionGuiTextBridge(this,owner);
  try{
   for(const target of targets){const node=this.element.add(new GuiTargetElement(this,target));this.nodes.push(node);this.byKey.set(target.focusKey,node);}
   this.release=gui.bindExternalElement(this.element,{gamepad:(sample,target)=>this.gamepad(sample,target),keyboard:(event,target)=>this.keyboard(event,target),textEdit:(edit,input)=>this.text.commit(input,edit)});this.text.watch();

  }catch(error){this.dispose();throw error;}
 }
 present(frame:ProductionCompositionFrame,texts:readonly GuiTextModel[],viewport:readonly[number,number]=this.viewport()):ProductionCompositionFrame{return this.text.present(frame,texts,viewport);}
 private gamepad(sample:Readonly<{index:number;control:string;value:number;phases:readonly ('down'|'up'|'change')[]}>,element:GuiElement):boolean {
  if(this.closed||this.synchronizing)return false;const target=element instanceof GuiTargetElement&&element.bridge===this?element.target:this.text.targetFor(element);if(!target||!this.owner.guiHandlesGamepad(target,sample.index,sample.control))return false;
  const inputs:CompositionGuiInput[]=sample.phases.filter(phase=>this.owner.guiHandlesGamepad(target,sample.index,sample.control,phase)).map(phase=>({kind:'gamepad',gamepad:{index:sample.index,control:sample.control,phase,value:sample.value}}));this.owner.enqueueGuiBatch(inputs,target);return true;
 }
 private keyboard(event:KeyboardEvent,element:GuiElement):boolean {
  if(this.closed||this.synchronizing||event.isComposing)return false;
  const target=element instanceof GuiTargetElement&&element.bridge===this?element.target:this.text.targetFor(element);if(!target)return false;
  const phase=event.type==='keyup'?'up':event.repeat?'repeat':'down',mods=modifiers(event),matched=this.owner.guiHandlesKeyboard(target,event.key,phase,mods);
  const reserved=event.type!=='keyup'&&this.owner.guiHandlesKeyboard(target,event.key,'up',mods);
  if(matched)this.enqueue({kind:'keyboard',key:event.key,keyPhase:phase,modifiers:mods},target);return matched||reserved;
 }
 get enabled():boolean{return !this.closed&&this.active;}
 point(x:number,y:number):readonly[number,number]{const v=this.viewport(),r=this.root.viewport;return [(x-r.x)*v[0]/r.width,(y-r.y)*v[1]/r.height];}
 rect(target:CompositionGuiTarget):{x:number;y:number;width:number;height:number}{
  const b=this.owner.guiBounds(target),v=this.viewport(),r=this.root.viewport;
  if(!b||v[0]<=0||v[1]<=0)return{x:r.x,y:r.y,width:0,height:0};
  return{x:r.x+b[0]*r.width/v[0],y:r.y+b[1]*r.height/v[1],width:b[2]*r.width/v[0],height:b[3]*r.height/v[1]};
 }
 hit(target:CompositionGuiTarget,x:number,y:number):boolean{
  const r=this.root.viewport,v=this.viewport();return this.enabled&&r.width>0&&r.height>0&&v[0]>0&&v[1]>0&&this.owner.guiHit(target,this.point(x,y));
 }
 enqueue(input:CompositionGuiInput,target?:CompositionGuiTarget):void{
  if(this.closed||this.synchronizing)return;
  // Pointer Events uses -1 when no button changed. The logical optional button stays absent.
  if(input.button===-1&&(input.kind==='pointer-move'||input.kind==='pointer-cancel')){
   const {button,...event}=input;void button;this.owner.enqueueGui(event,target);
  }else this.owner.enqueueGui(input,target);
 }
 /** Runs after the original whole-frame barrier; failed frames never publish new HYA focus. */
 sync(focused:string|null):void{
  if(this.closed)return;this.active=true;this.element.visible=true;
  this.synchronizing=true;
  try{this.text.sync();for(const node of this.nodes){node.rect=this.rect(node.target);node.disabled=this.text.ownsTarget(node.target)||!this.owner.guiTargetEnabled(node.target);}}finally{this.synchronizing=false;}
  this.synchronizing=true;
  try{const next=focused===null?undefined:this.text.focusNode(focused)??this.byKey.get(focused),previous=this.gui.focus.focused;
   if(next&&next!==previous)this.gui.focus.focus(next);
   else if(!next&&(previous instanceof GuiTargetElement&&previous.bridge===this||this.text.owns(previous)))this.gui.focus.blur();
  }finally{this.synchronizing=false;}this.text.capture();
 }
 dispose():void{
  if(this.closed)return;this.closed=true;this.active=false;
  try{try{this.text.dispose();}finally{try{this.unhandled();}finally{this.release();}}}finally{this.root.remove(this.element);this.nodes.length=0;this.byKey.clear();}
 }
}
let nextBridge=1;
class GuiTargetElement extends GuiElement {
 constructor(readonly bridge:ProductionCompositionGuiBridge,readonly target:Target){super({id:JSON.stringify(['hya-target',bridge.element.id,target.part,target.id]),focus:{mode:target.focusable?'all':'none',...(target.tabIndex===undefined?{}:{tabIndex:target.tabIndex})}});}
 override layout():void{this.rect=this.bridge.rect(this.target);}
 override hitTest(x:number,y:number):GuiElement|null{return this.visible&&!this.disabled&&this.bridge.hit(this.target,x,y)?this:null;}
 override handlePointerDown(event:GuiPointerEvent):void{super.handlePointerDown(event);this.pointer('pointer-down',event);}
 override handlePointerMove(event:GuiPointerEvent):void{super.handlePointerMove(event);this.pointer('pointer-move',event);}
 override handlePointerUp(event:GuiPointerEvent):void{super.handlePointerUp(event);this.pointer('pointer-up',event);}
 override handlePointerCancel(event:GuiPointerEvent):void{super.handlePointerCancel(event);this.pointer('pointer-cancel',event);}
 override handleFocus():void{super.handleFocus();this.bridge.enqueue({kind:'focus'},this.target);}
 override handleBlur():void{super.handleBlur();this.bridge.enqueue({kind:'blur'});}
 override handleAction(event:Action):void{super.handleAction(event);if(!event.consumed&&event.action==='confirm'){this.bridge.enqueue({kind:'gui-activate'},this.target);event.consume();}}
 private pointer(kind:string,event:GuiPointerEvent):void{
  const pointerType=event.nativeEvent.pointerType;
  this.bridge.enqueue({kind,pointerId:event.pointerId,point:this.bridge.point(event.x,event.y),button:event.button,...(['mouse','touch','pen'].includes(pointerType)?{pointerType:pointerType as 'mouse'|'touch'|'pen'}:{})});
 }
}
function modifiers(event:KeyboardEvent):readonly string[]{return Object.freeze([...(event.shiftKey?['shift']:[]),...(event.ctrlKey?['control']:[]),...(event.altKey?['alt']:[]),...(event.metaKey?['meta']:[])]);}
