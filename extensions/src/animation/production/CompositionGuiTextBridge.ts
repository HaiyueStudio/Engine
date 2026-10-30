import {layoutNodeContains,layoutRectBounds,layoutLocalPoint} from '../layout/production/ProductionLayoutGeometry.js';
import type {ProductionLayoutNode} from '../layout/production/types.js';
import {guiTextGeometry,projectGuiText,replaceGuiTextNodes} from './CompositionGuiTextViewport.js';
import type {ProductionCompositionFrame} from './CompositionOwner.js';
import {GuiInput,type GuiElement,type GuiPointerEvent} from '@haiyue/engine/gui';
import type {ProductionCompositionGuiBridge} from './CompositionGuiBridge.js';
import type {ProductionCompositionOwner,GuiTextModel,GuiTextView} from './CompositionOwner.js';
import type {CompositionGuiTarget} from './CompositionInputOwner.js';
import {productionTextEditing} from '../text/production/ProductionTextEditing.js';

type Rect=readonly[number,number,number,number];
interface Entry {model:GuiTextModel;base:string;input:TextInput;target:CompositionGuiTarget;focusKey:string;pending:Set<number>;closed:boolean;release:()=>void;releaseGeometry:()=>void;unregister:()=>void;}
/** The original G06 buffer/host handles edits; this bridge only supplies original HYA geometry and binding intents. */
export class ProductionCompositionGuiTextBridge {
 private readonly entries=new Map<string,Entry>();
 private unwatch:()=>void=()=>{};
 private closed=false;private syncing=false;private capturing=false;
 constructor(readonly bridge:ProductionCompositionGuiBridge,private readonly owner:ProductionCompositionOwner){}
 watch():void{this.unwatch=this.bridge.root.onInvalidation(()=>this.capture());}
 sync():void{
  if(this.closed)return;this.syncing=true;
  try{
   const models=new Map(this.owner.guiTexts.map(m=>[m.key,m]));
   for(const[key,entry]of this.entries)if(!models.has(key)||models.get(key)!.source!==entry.model.source)this.remove(key,entry);
   for(const model of models.values()){
    let entry=this.entries.get(model.key);
    if(!entry){entry=this.create(model);this.entries.set(model.key,entry);}
    else {
     entry.model=model;
     for(const id of entry.pending)if(!this.owner.guiTransactionPending(id))entry.pending.delete(id);
     if(model.plan.reader&&!entry.input.isComposing&&!entry.pending.size){if(entry.input.value!==model.value)entry.input.setValue(model.value,false);entry.base=model.value;}
    }
    entry.input.rect=this.nodeRect(model.node);entry.input.disabled=!layoutLocalPoint(model.node.transform,[0,0])||(model.plan.target?!this.owner.guiTargetEnabled(model.plan.target):false);
   }
  }finally{this.syncing=false;}
 }
 private create(model:GuiTextModel):Entry{
  const target=model.plan.target??{part:'@gui-text',id:JSON.stringify([model.key,model.source])},focusKey=model.plan.target?this.owner.guiTargets.find(t=>t.part===target.part&&t.id===target.id)!.focusKey:JSON.stringify([target.part,target.id]);
  const entry={model,base:model.value,target,focusKey,pending:new Set<number>(),closed:false,release:()=>{},releaseGeometry:()=>{},unregister:()=>{}} as Entry;
  if(!model.plan.target)entry.unregister=this.owner.registerGuiTextFocus(target);
  try{
   entry.input=this.bridge.element.add(new TextInput(this,entry,{id:JSON.stringify(['hya-text',this.bridge.element.id,model.key]),value:model.value,multiline:model.plan.block.input!.multiline??false,readOnly:!!model.plan.reader&&!model.writers.length,onChange:()=>this.capture()}));
   entry.release=this.bridge.gui.bindExternalElement(entry.input,{inputGeometry:()=>this.geometry(entry)});if(model.plan.target)entry.releaseGeometry=this.owner.registerGuiTextGeometry(target,()=>entry.model.node);return entry;
  }catch(error){entry.closed=true;try{entry.releaseGeometry();entry.release();entry.unregister();}finally{if(entry.input)this.bridge.element.remove(entry.input);}throw error;}
 }
 private remove(key:string,entry:Entry):void{
  entry.closed=true;this.entries.delete(key);
  try{entry.release();}finally{try{entry.releaseGeometry();entry.unregister();}finally{this.bridge.element.remove(entry.input);if(this.owner.lastFrame)this.owner.setGuiTextPreview(entry.model.address,null);entry.pending.clear();}}
 }
 capture():void{
  const r=this.bridge.root.viewport,v=this.bridge.viewport();if(this.closed||this.syncing||this.capturing||!(r.width>0&&r.height>0&&v[0]>0&&v[1]>0))return;this.capturing=true;
  try{for(const entry of this.entries.values())if(!entry.closed){
   const input=entry.input;
   const p=this.bridge.gui.getInputPresentation(input),composition=input.displayCompositionRange;
   this.owner.setGuiTextPreview(entry.model.address,input.focused?{...this.view(input),base:entry.base,source:entry.model.source,composing:input.isComposing,...(composition?{composition}:{}),...(p?{presentation:{scroll:[p.scrollX*this.bridge.viewport()[0]/this.bridge.root.viewport.width,p.scrollY*this.bridge.viewport()[1]/this.bridge.root.viewport.height],caretVisible:p.caretVisible??true}}:{})}:entry.model.plan.reader&&!p.scrollX&&!p.scrollY?null:{value:input.value,base:entry.base,source:entry.model.source,presentation:{scroll:[p.scrollX*this.bridge.viewport()[0]/this.bridge.root.viewport.width,p.scrollY*this.bridge.viewport()[1]/this.bridge.root.viewport.height],caretVisible:false}});
  }}finally{this.capturing=false;}
 }
 private view(input:GuiInput):GuiTextView{return{value:input.displayValue,selection:input.isComposing?[input.displayCaretIndex,input.displayCaretIndex]:[input.displaySelectionStart,input.displaySelectionEnd],cursor:input.displayCaretIndex};}
 nodeRect(node:ProductionLayoutNode){return this.rect(layoutRectBounds(node.rect,node.transform));}
 rect(r:Rect):{x:number;y:number;width:number;height:number}{const v=this.bridge.viewport(),root=this.bridge.root.viewport;return{x:root.x+r[0]*root.width/v[0],y:root.y+r[1]*root.height/v[1],width:r[2]*root.width/v[0],height:r[3]*root.height/v[1]};}
 private geometry(entry:Entry){const {model,input}=entry;return guiTextGeometry(model,this.owner.guiShapeText(model,this.view(input)),this.bridge.root.viewport,this.bridge.viewport(),input.displayCaretIndex);}
 /** Prepare only presentation; snapshot geometry/clock/selection survive an exact failed-frame retry. */
 present(frame:ProductionCompositionFrame,models:readonly GuiTextModel[],viewport:readonly[number,number]=this.bridge.viewport()):ProductionCompositionFrame{
  const nodes=new Map<string,GuiTextModel['node']>(),root=this.bridge.root.viewport,v=viewport,sx=root.width/v[0],sy=root.height/v[1];if(!(sx>0&&sy>0))return frame;
  for(const model of models){
   const entry=this.entries.get(model.key),same=entry&&!entry.closed&&entry.model.source===model.source,focused=!!same&&frame.input.focused===entry.focusKey,view=model.view,offset=view?.cursor??model.value.length;
   let source=model.node.text!;const geometry=guiTextGeometry(model,source,root,v,offset,false),s=view?.presentation,p=this.bridge.gui.projectInputPresentation(geometry,{scrollX:(s?.scroll[0]??0)*sx,scrollY:(s?.scroll[1]??0)*sy,focused,multiline:model.plan.block.input!.multiline??false,caretVisible:(s?.caretVisible??true)&&!(model.plan.reader&&!model.writers.length),...(focused&&view?.composing&&view.composition?{compositionRange:view.composition}:{})});
   if((p.scrollX||p.scrollY)&&source.runs.some(run=>run.glyphs.some(g=>g.paint.kind==='bitmap')))source=this.owner.guiShapeText(model,view??{value:model.value},[p.scrollX/sx,p.scrollY/sy]);
   nodes.set(model.key,projectGuiText(model,source,{...p,...(!focused?{caretVisible:false,compositionRanges:[]}:{} )},root,v,focused));
  }return replaceGuiTextNodes(frame,nodes);
 }
 hit(entry:Entry,x:number,y:number):boolean{
  if(!this.bridge.enabled||entry.closed||entry.input.disabled)return false;
  const point=this.bridge.point(x,y),n=entry.model.node;
  if(!layoutNodeContains(n,point))return false;
  return !entry.model.plan.target||this.owner.guiHit(entry.model.plan.target,point);
 }
 pointer(entry:Entry,kind:string,event:GuiPointerEvent):void{
  if(!entry.model.plan.target)return;const pointerType=event.nativeEvent.pointerType;
  this.bridge.enqueue({kind,pointerId:event.pointerId,point:this.bridge.point(event.x,event.y),button:event.button,...(['mouse','touch','pen'].includes(pointerType)?{pointerType:pointerType as 'mouse'|'touch'|'pen'}:{})});
 }
 focus(entry:Entry,focused:boolean):void{if(!this.closed&&!entry.closed)this.bridge.enqueue({kind:focused?'focus':'blur'},entry.target);}
 targetFor(node:GuiElement){const entry=[...this.entries.values()].find(e=>e.input===node&&!e.closed);return entry?.model.plan.target;}
 commit(node:GuiInput,edit:Readonly<{previous:string;value:string;text:string}>):void {const entry=[...this.entries.values()].find(e=>e.input===node);if(this.closed||this.syncing||!entry||entry.closed)return;const id=this.owner.guiCommitText(entry.model,edit.value,edit.text,edit.previous!==edit.value);if(id!==null)entry.pending.add(id);this.capture();}
 focusNode(key:string):GuiElement|undefined{return[...this.entries.values()].find(e=>e.focusKey===key)?.input;}
 owns(node:GuiElement|null):boolean{return[...this.entries.values()].some(e=>e.input===node);}
 ownsTarget(target:CompositionGuiTarget):boolean{return[...this.entries.values()].some(e=>e.model.plan.target?.part===target.part&&e.model.plan.target.id===target.id);}
 dispose():void{if(this.closed)return;this.closed=true;this.unwatch();const errors:unknown[]=[];for(const[key,entry]of this.entries)try{this.remove(key,entry);}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'HYA text bridge release failed');}
}
class TextInput extends GuiInput {
 constructor(private readonly adapter:ProductionCompositionGuiTextBridge,private readonly entry:Entry,options:ConstructorParameters<typeof GuiInput>[0]){super(options);}
 override layout():void{this.rect=this.adapter.nodeRect(this.entry.model.node);}
 override hitTest(x:number,y:number):GuiElement|null{return this.visible&&this.adapter.hit(this.entry,x,y)?this:null;}
 override handleFocus():void{super.handleFocus();this.adapter.focus(this.entry,true);}
 override handleBlur():void{super.handleBlur();this.adapter.focus(this.entry,false);}
 override handlePointerDown(event:GuiPointerEvent):void{super.handlePointerDown(event);this.adapter.pointer(this.entry,'pointer-down',event);}
 override handlePointerMove(event:GuiPointerEvent):void{super.handlePointerMove(event);this.adapter.pointer(this.entry,'pointer-move',event);}
 override handlePointerUp(event:GuiPointerEvent):void{super.handlePointerUp(event);this.adapter.pointer(this.entry,'pointer-up',event);}
 override handlePointerCancel(event:GuiPointerEvent):void{super.handlePointerCancel(event);this.adapter.pointer(this.entry,'pointer-cancel',event);}
}
function contains(r:Rect,p:readonly[number,number]):boolean{return p[0]>=r[0]&&p[1]>=r[1]&&p[0]<=r[0]+r[2]&&p[1]<=r[1]+r[3];}
function intersect(a:Rect,b:Rect):Rect{const x=Math.max(a[0],b[0]),y=Math.max(a[1],b[1]);return[x,y,Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-x),Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-y)];}
function roundedContains(r:Rect,radii:readonly[number,number,number,number],p:readonly[number,number]):boolean{
 if(!contains(r,p))return false;const x=p[0]-r[0],y=p[1]-r[1],right=x>r[2]/2,bottom=y>r[3]/2,radius=Math.max(0,Math.min(radii[bottom?(right?2:3):(right?1:0)],r[2]/2,r[3]/2));
 const dx=right?r[2]-x:x,dy=bottom?r[3]-y:y;return dx>=radius||dy>=radius||(dx-radius)**2+(dy-radius)**2<=radius**2;
}
