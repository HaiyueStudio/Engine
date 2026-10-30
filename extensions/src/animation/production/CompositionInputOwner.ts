import {layoutNodeContains,layoutLocalPoint,type LayoutAffine} from '../layout/production/ProductionLayoutGeometry.js';
import type {ProductionLayoutNode} from '../layout/production/types.js';
import {snapshotPlainTextData} from '../text/PlainTextData.js';
import {InteractionRuntime} from '../interaction/InteractionRuntime.js';
import type {RuntimeInteractionDocument, RuntimeInteractionAction, RoutedInteractionEvent, InteractionGeometryPort, RuntimeValue} from '../interaction/runtime-types.js';
import {ProductionFrameError, snapshotProductionFrameRequest, type ProductionFrameInput, type ProductionFrameStage} from './FrameTransaction.js';

export interface CompositionInteractionPart {
  readonly id: string; readonly document: RuntimeInteractionDocument; readonly geometry?: InteractionGeometryPort;
  invoke(action: RuntimeInteractionAction, event: RoutedInteractionEvent, transaction: number): void;
}
export interface CompositionInteractionEvent {readonly part: string; readonly id: string; readonly sequence: number; readonly target: string; readonly name: string; readonly payload: RuntimeValue;}
export type CompositionGuiInput = Omit<ProductionFrameInput,'consumed'|'target'>;
export interface CompositionGuiTarget {readonly part:string; readonly id:string;}
interface QueuedGuiInput {readonly input:ProductionFrameInput; readonly target?:string; readonly bytes:number;}
interface Alias {readonly id: string; readonly part: string; readonly kind: string; readonly address: readonly string[];}
const key=(part: string, id: string): string=>JSON.stringify([part,id]);
function fail(path: string,message: string): never {throw new ProductionFrameError('E_HYA_RUNTIME_INPUT',path,message);}

/** All declared parts share the original router, focus and capture owner; this class never samples devices. */
export class ProductionCompositionInputOwner {
  private readonly runtime: InteractionRuntime;
  private readonly guiFocusTargets=new Set<string>();
  private readonly guiGeometry=new Map<string,()=>ProductionLayoutNode>();
  private readonly targets = new Map<string,{part: CompositionInteractionPart; id: string}>();
  private readonly aliases = new Map<string,string>();
  private readonly names = new Map<string,string>();
  private readonly actions = new WeakMap<object,{part: CompositionInteractionPart; action: RuntimeInteractionAction; id: string}>();
  private events: CompositionInteractionEvent[] = [];
  private transaction = 0;
  private eventBytes = 0;
  private preparing = false;
  private disposed = false;
  private readonly guiQueue:QueuedGuiInput[]=[];
  private guiBytes=0;
  private guiAttempt:Readonly<{sequence:number; entries:readonly QueuedGuiInput[]}>|undefined;
  private readonly maxGuiQueue:number;
  constructor(parts: readonly CompositionInteractionPart[], aliases: readonly Alias[]) {
    this.maxGuiQueue=Math.min(1_000_000,...parts.map(part=>part.document.limits?.maxEventQueue??1_000_000));
    const targets: RuntimeInteractionDocument['targets'][number][] = [],listeners: RuntimeInteractionDocument['listeners'][number][]=[];
    for(const part of parts){
      for(const target of [...part.document.targets].sort((a,b)=>a.order-b.order)){
        const id=key(part.id,target.id);this.targets.set(id,{part,id:target.id});
        if(target.hitArea.kind==='geometry'&&!part.geometry?.containsGeometry) fail(id,'original geometry hit area requires its real geometry port');
        targets.push({...target,id,order:targets.length,...(target.parent?{parent:key(part.id,target.parent)}:{}),...(target.clips?{clips:target.clips.map(id=>key(part.id,id))}:{})});
      }
      for(const listener of part.document.listeners)listeners.push({...listener,id:key(part.id,listener.id),target:key(part.id,listener.target),actions:listener.actions.map((action,index)=>{
        const owned=Object.freeze({...action,...(action.kind==='focus'&&typeof action.target==='string'?{target:key(part.id,action.target)}:{})});
        this.actions.set(owned,{part,action,id:key(part.id,listener.id+':'+index)});return owned;
      })});
    }
    for(const alias of aliases)if(alias.kind==='interaction-target'){
      const id=key(alias.part,alias.address[0]!);if(!this.targets.has(id))fail(alias.id,'interaction alias does not resolve');this.aliases.set(alias.id,id);if(!this.names.has(id))this.names.set(id,alias.id);
    }
    const identify=(id: string)=>this.targets.get(id)??fail(id,'unknown original interaction target');
    this.runtime=new InteractionRuntime({dragThreshold:Math.min(...parts.map(part=>part.document.dragThreshold)),targets,listeners}, {presentationGeometry:id=>{const node=this.guiGeometry.get(id)?.();return node?{...(node.transform?{transform:node.transform}:{}),enabled:!!layoutLocalPoint(node.transform,[0,0]),contains:point=>layoutNodeContains(node,point)}:undefined;},dragThreshold:id=>identify(id).part.document.dragThreshold,geometryPort:{
      matrix:id=>{const value=identify(id);return value.part.geometry?.matrix?.(value.id);},
      visible:id=>{const value=identify(id);return value.part.geometry?.visible?.(value.id)!==false;},
      containsGeometry:(port,id,point)=>{const value=identify(id);return value.part.geometry?.containsGeometry?.(port,value.id,point)??false;},
    },maxEventQueue:Math.min(1_000_000,...parts.map(part=>part.document.limits?.maxEventQueue??1_000_000)),
      maxEventRecursion:Math.min(64,...parts.map(part=>part.document.limits?.maxEventRecursion??64)),maxPointers:Math.min(1024,...parts.map(part=>part.document.limits?.maxPointers??1024)),
      actionPort:{begin:id=>{this.transaction=id},commit(){},rollback(){},invoke:(action,event)=>{
        const source=this.actions.get(action)??fail('$.actions','action is not in the compiled graph');
        if(source.action.kind==='report-event'){
          this.eventBytes+=new TextEncoder().encode(JSON.stringify([source.action,event])).byteLength;if(this.events.length>=1_000_000||this.eventBytes>64*1024*1024)fail('$.events','composition event ceiling exceeded');
          this.events.push(Object.freeze({part:source.part.id,id:JSON.stringify([source.id,event.sequence]),sequence:event.sequence,target:this.names.get(event.target)??event.target,name:source.action.name as string,payload:(source.action.payload??null) as RuntimeValue}));
          this.runtime.enqueueReportedEvent(source.action.name as string,(source.action.payload??null) as RuntimeValue,event.currentTarget);
        }else if(!['focus','pointer-capture','pointer-release'].includes(source.action.kind)){
          source.part.invoke(source.action,Object.freeze({...event,target:identify(event.target).id,currentTarget:identify(event.currentTarget).id}),this.transaction);
        }
      }}});
  }
  /** Called only by the existing GUI owner after exclusive logical routing. No device sampling. */
  enqueueGui(input:CompositionGuiInput,address?:CompositionGuiTarget):void {this.prepareGui(input,address).commit();}
  prepareGui(input:CompositionGuiInput,address?:CompositionGuiTarget):Readonly<{commit():void}> {return this.prepareGuiBatch([input],address);}
  prepareGuiBatch(inputs:readonly CompositionGuiInput[],address?:CompositionGuiTarget):Readonly<{commit():void}> {
    if(this.disposed)fail('$.gui.input','input owner is disposed');const snapshot=snapshotPlainTextData(inputs,'$.gui.inputs',(path,message)=>fail(path,message),{strict:true,maxBytes:64*1024*1024});if(!Array.isArray(snapshot))fail('$.gui.inputs','expected a dense routed input batch');
    const entries=(snapshot as readonly CompositionGuiInput[]).map(input=>this.captureGui(input,address)),bytes=entries.reduce((sum,e)=>sum+e.bytes,0);
    const capacity=()=>{if(this.guiQueue.length+entries.length>this.maxGuiQueue||this.guiBytes+bytes>64*1024*1024)throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT','$.gui.input','GUI input queue exceeds the original event/byte ceiling');};capacity();let committed=false;
    return Object.freeze({commit:()=>{if(committed)return;if(this.disposed)fail('$.gui.input','input owner is disposed');capacity();for(const entry of entries)this.guiQueue.push(entry);this.guiBytes+=bytes;committed=true;}});
  }
  private captureGui(input:CompositionGuiInput,address?:CompositionGuiTarget):QueuedGuiInput {
    if(this.disposed)fail('$.gui.input','input owner is disposed');
    // Snapshot the original event before reading members: getters, prototype keys and later mutation cannot enter a retry.
    const raw=snapshotPlainTextData(input,'$.gui.input',(path,message)=>fail(path,message),{strict:true,maxBytes:64*1024*1024}) as CompositionGuiInput;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('$.gui.input','expected a routed logical event');
    if(Object.hasOwn(raw,'consumed')||Object.hasOwn(raw,'target'))fail('$.gui.input','GUI ownership and compiled target are supplied by the adapter');
    const event=snapshotProductionFrameRequest({sequence:0,deltaSeconds:0,viewport:[0,0],dpr:1,input:[{...raw,consumed:false}]}).input![0]!;
    const target=address===undefined?undefined:key(address.part,address.id);
    if(target!==undefined&&!this.targets.has(target)&&!this.guiFocusTargets.has(target))fail('$.gui.target','GUI target is not in this composition');
    this.validateGui(event,target);
    const bytes=new TextEncoder().encode(JSON.stringify([event,target??null])).byteLength;
    if(this.guiQueue.length>=this.maxGuiQueue||this.guiBytes+bytes>64*1024*1024)throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT','$.gui.input','GUI input queue exceeds the original event/byte ceiling');
    return Object.freeze({input:event,...(target===undefined?{}:{target}),bytes});
  }
  get guiTrace():Readonly<{queued:number;bytes:number;retrySequence:number|null;selected:number}>{return Object.freeze({queued:this.guiQueue.length,bytes:this.guiBytes,retrySequence:this.guiAttempt?.sequence??null,selected:this.guiAttempt?.entries.length??0});}
  private validateGui(input:ProductionFrameInput,target:string|undefined):void {
    const fields:Record<string,readonly string[]>={
      'pointer-down':['pointerId','point','button','pointerType'],'pointer-move':['pointerId','point','button','pointerType'],'pointer-up':['pointerId','point','button','pointerType'],'pointer-cancel':['pointerId','point','button','pointerType'],
      keyboard:['key','keyPhase','modifiers'],'text-input':['text'],gamepad:['gamepad'],focus:[],blur:[],'gui-activate':[],'semantic-action':['semanticAction']};
    if(!fields[input.kind]||Object.keys(input).some(k=>!['kind','consumed',...fields[input.kind]!].includes(k)))fail('$.gui.input','unknown GUI logical event fields');
    const point=input.point;
    if(['pointer-down','pointer-move','pointer-up','pointer-cancel'].includes(input.kind)){
      if(!Number.isSafeInteger(input.pointerId)||input.pointerId!<0||(input.kind!=='pointer-cancel'||point!==undefined)&&(!Array.isArray(point)||point.length!==2||point.some(n=>typeof n!=='number'||!Number.isFinite(n)))||input.button!==undefined&&(!Number.isSafeInteger(input.button)||input.button<0)||input.pointerType!==undefined&&!['mouse','touch','pen'].includes(input.pointerType))fail('$.gui.input.pointer','invalid logical pointer');
    }else if(input.kind==='keyboard'){
      if(typeof input.key!=='string'||!['down','up','repeat'].includes(input.keyPhase??'')||input.modifiers!==undefined&&(!Array.isArray(input.modifiers)||input.modifiers.some(v=>typeof v!=='string')))fail('$.gui.input.keyboard','invalid logical keyboard');
    }else if(input.kind==='text-input'){
      if(typeof input.text!=='string')fail('$.gui.input.text','only committed text is accepted');
    }else if(input.kind==='gamepad'){
      const g=input.gamepad;if(!g||!Number.isSafeInteger(g.index)||g.index<0||typeof g.control!=='string'||!['down','up','change'].includes(g.phase)||!Number.isFinite(g.value))fail('$.gui.input.gamepad','invalid routed gamepad input');
    }else if(input.kind==='focus'||input.kind==='gui-activate'){
      if(!target)fail('$.gui.target','focus requires a compiled target');
    }else if(input.kind==='semantic-action'){
      if(!target||!['tap','increase','decrease','focus'].includes(input.semanticAction??''))fail('$.gui.input.semantic','invalid original logical UI action');
    }else if(input.kind!=='blur')fail('$.gui.input.kind','GUI adapter cannot enqueue internal data/report events');
  }
  stage(before?:()=>void): ProductionFrameStage {
    return {id:'composition-input',phase:'input-queue',prepare:context=>{
      if(this.disposed||this.preparing)fail('$.input','input owner is not idle');this.preparing=true;this.events=[];this.eventBytes=0;
      if(!this.guiAttempt||this.guiAttempt.sequence!==context.request.sequence)this.guiAttempt=Object.freeze({sequence:context.request.sequence,entries:Object.freeze([...this.guiQueue])});
      const selected=this.guiAttempt.entries;
      const token=this.runtime.captureFrame();let closed=false;
      const close=(commit:boolean)=>{if(closed)return;closed=true;this.preparing=false;if(!this.disposed){if(commit){this.runtime.releaseFrame(token);this.guiQueue.splice(0,selected.length);for(const item of selected)this.guiBytes-=item.bytes;this.guiAttempt=undefined;}else this.runtime.restoreFrame(token);}};
      try{before?.();for(const item of selected)this.dispatch(item.input,item.target);for(const input of context.request.input??[])this.dispatch(input);const value=Object.freeze({focused:this.focused,events:Object.freeze([...this.events])});return{value,commit:()=>close(true),rollback:()=>close(false)};}
      catch(error){close(false);throw error;}
    },dispose:()=>this.dispose()};
  }
  semantic(alias: string,action: string): void {
    if(!this.preparing)fail(alias,'semantic actions must join the input phase');
    const target=this.aliases.get(alias)??fail(alias,'semantic action requires its declared interaction alias');
    this.semanticTarget(target,action);
  }
  private semanticTarget(target:string,action:string):void {
    if(!['tap','increase','decrease','focus'].includes(action))fail(target,'unsupported semantic action');
    if(action==='focus')this.runtime.focus(target);
    this.runtime.dispatchSemanticAction(target,action as 'tap'|'increase'|'decrease'|'focus');
  }
  registerGuiFocus(target:CompositionGuiTarget):()=>void {
    if(this.disposed||this.preparing||this.guiAttempt)fail('$.gui.focus','GUI focus registration requires an idle committed frame');
    const id=key(target.part,target.id),release=this.runtime.registerGuiFocusTarget(id);this.guiFocusTargets.add(id);let closed=false;
    return()=>{if(closed)return;if(!this.disposed&&this.preparing)fail(id,'GUI focus release cannot reenter routing');release();closed=true;this.guiFocusTargets.delete(id);for(let i=this.guiQueue.length-1;i>=0;i--)if(this.guiQueue[i]!.target===id){this.guiBytes-=this.guiQueue[i]!.bytes;this.guiQueue.splice(i,1);}if(this.guiAttempt)this.guiAttempt=Object.freeze({...this.guiAttempt,entries:Object.freeze(this.guiAttempt.entries.filter(e=>e.target!==id))});};
  }
  get guiTargets(){return Object.freeze([...this.targets].map(([id,value])=>{const target=value.part.document.targets.find(t=>t.id===value.id)!;return Object.freeze({part:value.part.id,id:value.id,focusKey:this.names.get(id)??id,focusable:target.focusable===true,...(target.tabIndex===undefined?{}:{tabIndex:target.tabIndex})});}));}
  registerGuiTextGeometry(target:CompositionGuiTarget,resolve:()=>ProductionLayoutNode):()=>void{
    const id=key(target.part,target.id);if(this.disposed||this.preparing||!this.targets.has(id)||this.guiGeometry.has(id))fail(id,'GUI presentation geometry requires one idle original target owner');
    this.guiGeometry.set(id,resolve);let closed=false;return()=>{if(closed)return;closed=true;if(this.guiGeometry.get(id)===resolve)this.guiGeometry.delete(id);};
  }
  guiBoundsWithTransform(target:CompositionGuiTarget,matrix:LayoutAffine){return this.runtime.targetBounds(key(target.part,target.id),matrix);}
  guiBounds(target:CompositionGuiTarget){return this.runtime.targetBounds(key(target.part,target.id));}
  guiHit(target:CompositionGuiTarget,point:readonly[number,number]):boolean{return this.runtime.hitTest(point)===key(target.part,target.id);}
  guiTargetEnabled(target:CompositionGuiTarget):boolean{return this.runtime.targetEnabled(key(target.part,target.id));}
  guiHandlesText(target:CompositionGuiTarget):boolean{return this.runtime.handlesText(key(target.part,target.id));}
  guiHandlesGamepad(target:CompositionGuiTarget,index:number,control:string,phase?:'down'|'up'|'change'):boolean{return this.runtime.handlesGamepad(key(target.part,target.id),index,control,phase);}
  guiHandlesKeyboard(target:CompositionGuiTarget,keyValue:string,phase:'down'|'up'|'repeat',modifiers:readonly string[]):boolean{return this.runtime.handlesKeyboard(key(target.part,target.id),keyValue,phase,modifiers);}
  get focused(): string|null {const id=this.runtime.trace.focused;return id?(this.names.get(id)??id):null;}
  get trace(){return this.runtime.trace;}
  dispose(): void {if(this.disposed)return;this.disposed=true;this.runtime.dispose();this.guiGeometry.clear();this.events=[];this.guiQueue.length=0;this.guiBytes=0;this.guiAttempt=undefined;}
  private dispatch(input: ProductionFrameInput,compiledTarget?:string): void {
    if(input.consumed)return;
    const target=compiledTarget??(input.target===undefined?undefined:this.aliases.get(input.target)??fail(input.target,'routed input target is not a declared interaction alias'));
    if(['pointer-down','pointer-move','pointer-up','pointer-cancel'].includes(input.kind)){
      if(!Number.isSafeInteger(input.pointerId)||input.pointerId!<0||(!input.point&&input.kind!=='pointer-cancel'))fail('$.input.pointer','logical pointer needs its ID and point');
      this.runtime.dispatchPointer({kind:input.kind.slice(8) as 'down'|'move'|'up'|'cancel',pointerId:input.pointerId!,point:input.point??[0,0],...(input.button===undefined?{}:{button:input.button})});
    }else if(input.kind==='keyboard'){
      if(typeof input.key!=='string'||!['down','up','repeat'].includes(input.keyPhase??''))fail('$.input.keyboard','logical keyboard needs its key and phase');
      this.runtime.dispatchKeyboard({key:input.key,phase:input.keyPhase as 'down'|'up'|'repeat',...(input.modifiers?{modifiers:input.modifiers}:{})},compiledTarget);
    }else if(input.kind==='text-input'){if(typeof input.text!=='string')fail('$.input.text','only committed text is accepted');this.runtime.dispatchText(input.text,compiledTarget);}
    else if(input.kind==='gamepad'){if(!input.gamepad||!['down','up','change'].includes(input.gamepad.phase)||!Number.isSafeInteger(input.gamepad.index)||!Number.isFinite(input.gamepad.value))fail('$.input.gamepad','invalid logical gamepad sample');this.runtime.dispatchGamepad({...input.gamepad,phase:input.gamepad.phase as 'down'|'up'|'change'},compiledTarget);}
    else if(input.kind==='focus'){if(!target)fail('$.input.focus','focus requires its declared target');this.runtime.focus(target);}
    else if(input.kind==='blur')this.runtime.focus(undefined);
    else if(input.kind==='gui-activate'&&compiledTarget)this.runtime.dispatchActivation(compiledTarget);
    else if(input.kind==='semantic-action'){if(!target||!input.semanticAction)fail('$.input.semantic','semantic action requires its target and action');this.semanticTarget(target,input.semanticAction);}
    else if(input.kind==='reported-event'){if(!target||typeof input.name!=='string')fail('$.input.event','reported event requires its target and name');this.runtime.enqueueReportedEvent(input.name,input.payload??null,target);}
    else if(input.kind==='component-event'){if(!target||typeof input.name!=='string')fail('$.input.event','component event requires its target and name');this.runtime.enqueueComponentEvent(target,input.name,input.payload??null);}
    else if(input.kind==='data-change'){if(typeof input.binding!=='string'||input.value===undefined)fail('$.input.data','data event requires its binding and value');this.runtime.dispatchDataChange(input.binding,input.value,target);}
    else fail('$.input.'+input.kind,'logical input kind has no original router adapter');
  }
}
