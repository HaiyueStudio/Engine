import {SemanticsRuntime} from '../interaction/SemanticsRuntime.js';
import type {RuntimeSemanticsDocument, RuntimeValue, SemanticHostBridge, SemanticSnapshot, SemanticSnapshotNode, DataSubscription} from '../interaction/runtime-types.js';
import {ProductionFrameError,type ProductionFrameStage,type ProductionFrameContext} from './FrameTransaction.js';
import type {ProductionLayoutFrame} from '../layout/production/types.js';
type Rect=readonly[number,number,number,number];
export type CompositionSemanticSnapshot=Omit<SemanticSnapshot,'nodes'>&{readonly nodes:readonly (SemanticSnapshotNode&{readonly bounds:Rect})[]};
export interface CompositionSemanticPorts {
  readonly host?: SemanticHostBridge;
  read(binding:string,prepared:boolean):RuntimeValue;
  geometry(target:string,layouts:Readonly<Record<string,ProductionLayoutFrame>>):Rect|undefined;
  action(target:string,action:string):void;
  diagnostic(error:unknown):void;
  invalidate():void;
}
function fail(path:string,message:string):never{throw new ProductionFrameError('E_HYA_RUNTIME_SEMANTICS',path,message);}
/** The original semantic tree resolves prepared data; only observable-commit reaches the borrowed host. */
export class ProductionCompositionSemanticsOwner {
  private readonly runtime:SemanticsRuntime;
  private readonly subscription:DataSubscription|undefined;
  private readonly queue:{node:string;action:string;bytes:number}[]=[];
  private queuedBytes=0;
  private valuesKey:string|undefined;
  private selected=0;
  private readonly bindings:readonly string[];
  private activeBindings:ReadonlyMap<string,RuntimeValue>|undefined;
  private key:string|undefined;
  private last:CompositionSemanticSnapshot|undefined;
  private disposed=false;
  constructor(readonly id:string,readonly document:RuntimeSemanticsDocument,private readonly ports:CompositionSemanticPorts){
    const bindings=new Set<string>();for(const node of document.nodes)for(const value of [node.label,node.value,node.hint,...Object.values(node.state??{})])if(value?.kind==='binding')bindings.add(value.binding!);this.bindings=Object.freeze([...bindings]);
    this.runtime=new SemanticsRuntime(document,{read:binding=>this.activeBindings?.has(binding)?this.activeBindings.get(binding)!:ports.read(binding,false)},{update(){}},{invoke:(target,action)=>ports.action(target,action)});
    try{this.subscription=ports.host?.subscribeActions?.((node,action)=>{
      try{if(this.disposed)return;const target=this.last?.nodes.find(value=>value.id===node);if(!target||target.state.disabled||!target.actions.includes(action))fail(node,'host action is absent or disabled in its committed snapshot');const bytes=new TextEncoder().encode(JSON.stringify([node,action])).byteLength;if(this.queue.length>=1_000_000||this.queuedBytes+bytes>64*1024*1024)fail('$.semantics.actions','original action/byte ceiling exceeded');this.queue.push(Object.freeze({node,action,bytes}));this.queuedBytes+=bytes;ports.invalidate();}catch(error){ports.diagnostic(error);}
    });}catch(error){this.runtime.dispose();throw error;}
  }
  /** Called after data and input checkpoints, before the atomic-data phase. */
  input():void{if(this.disposed)fail(this.id,'semantics owner is disposed');this.selected=this.queue.length;for(const item of this.queue.slice(0,this.selected))this.runtime.perform(item.node,item.action);}
  stage(layouts:(context:ProductionFrameContext)=>Readonly<Record<string,ProductionLayoutFrame>>,focus:()=>string|null):ProductionFrameStage{
    return{id:'semantics:'+this.id,phase:'geometry-draw',prepare:context=>{
      if(this.disposed)fail(this.id,'semantics owner is disposed');const token=this.runtime.captureFrame();let closed=false;
      const close=(commit:boolean)=>{if(closed)return;closed=true;if(!this.disposed){if(commit)this.runtime.releaseFrame(token);else this.runtime.restoreFrame(token);}};
      try{
        const values=new Map(this.bindings.map(binding=>[binding,this.ports.read(binding,true)])),frames=layouts(context),focused=focus();
        const valuesKey=JSON.stringify([...values]);let raw=this.runtime.snapshot;
        if(valuesKey!==this.valuesKey){this.activeBindings=values;try{raw=this.runtime.update();}finally{this.activeBindings=undefined;}}
        const geometry=new Map(raw.nodes.map(node=>{
          const rect=this.ports.geometry(node.target,frames);if(!rect||rect.length!==4||rect.some(value=>!Number.isFinite(value))||rect[2]<0||rect[3]<0)fail(node.id,'semantic bounds must come from the prepared geometry');return[node.id,Object.freeze([...rect]) as Rect] as const;
        }));
        const key=JSON.stringify([[...values],focused,[...geometry]]),changed=key!==this.key;let snapshot=this.last;
        if(changed){if(valuesKey===this.valuesKey){this.activeBindings=values;try{raw=this.runtime.update();}finally{this.activeBindings=undefined;}}snapshot=Object.freeze({...raw,nodes:Object.freeze(raw.nodes.map(node=>Object.freeze({...node,state:Object.freeze({...node.state,focused:focused===node.target}),bounds:geometry.get(node.id)!})))});}
        this.activeBindings=undefined;
        return{value:snapshot,commit:()=>{close(true);this.last=snapshot;this.key=key;this.valuesKey=valuesKey;for(const item of this.queue.splice(0,this.selected))this.queuedBytes-=item.bytes;this.selected=0;},rollback:()=>{this.activeBindings=undefined;close(false);},publish:()=>{if(changed&&snapshot)this.ports.host?.update(snapshot);}};
      }catch(error){this.activeBindings=undefined;close(false);throw error;}
    },dispose:()=>this.dispose()};
  }
  get snapshot():CompositionSemanticSnapshot|undefined{return this.last;}
  dispose():void{if(this.disposed)return;this.disposed=true;this.subscription?.unsubscribe();this.runtime.dispose();this.queue.length=0;this.queuedBytes=0;this.activeBindings=undefined;this.last=undefined;}
}
