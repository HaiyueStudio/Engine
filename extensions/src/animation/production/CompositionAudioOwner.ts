import {ProductionAudioOwner,type ProductionAudioCommand,type ProductionAudioTrace} from '../audio/ProductionAudioOwner.js';
import type {ProductionAudioHost} from '../audio/ProductionAudioHost.js';
import type {RuntimeAudioDocument,RuntimeClockSnapshot} from '../audio/runtime-types.js';
import {ProductionFrameError,type ProductionFrameContext,type ProductionFrameStage,type ProductionFrameTransport} from './FrameTransaction.js';

export class CompositionAudioPending extends ProductionFrameError {constructor(readonly ready:Promise<void>,part:string){super('E_HYA_RUNTIME_AUDIO_PENDING','$.audio.'+part,'wait for the actual gesture grant and silent clock alignment');}}

export interface CompositionAudioFrame {readonly armed:boolean;readonly clocks:RuntimeClockSnapshot;readonly commands:number;}
/** Joins the original owner/queue to the visual barrier; no scheduler, clock or token sampler is duplicated. */
export class ProductionCompositionAudioOwner {
  private readonly owner:ProductionAudioOwner;
  private armed=false;
  private lastClocks:RuntimeClockSnapshot|undefined;
  private lastTransport:ProductionFrameTransport|undefined;
  private unlocking:Promise<void>|undefined;
  private settled:Promise<void>=Promise.resolve();
  private fault:unknown;
  private failed=false;
  private disposed=false;
  constructor(readonly id:string,document:RuntimeAudioDocument,private readonly host:ProductionAudioHost,private readonly diagnostic:(error:unknown)=>void,signal?:AbortSignal){
    this.owner=new ProductionAudioOwner(document,host,signal?{signal}:{});
  }
  async prepare():Promise<void>{await this.owner.prepare();await this.owner.update({operation:'pause',domain:'composition',time:0,rate:1});}
  unlock(clocks:()=>RuntimeClockSnapshot,transport:()=>Readonly<{status:'running'|'paused'|'stopped';rate:number}>=()=>({status:'running',rate:1})):Promise<void>{
    this.live();if(this.unlocking)return this.unlocking;if(this.armed&&this.host.state==='running')return Promise.resolve();
    // owner.unlock enters the borrowed host synchronously within the actual caller gesture.
    const grant=this.owner.unlock();
    const job=grant.then(async()=>{
      this.live();const current=clocks(),intent=transport();
      for(const domain of ['composition','state','event'] as const)if(this.armed||Object.values(current).some(time=>time!==0))await this.owner.update({operation:'seek',domain,time:current[domain],rate:intent.rate});
      if(intent.status==='running')await this.owner.update({operation:'resume',domain:'composition',time:current.composition,rate:intent.rate});this.live();this.armed=true;
    }).finally(()=>{if(this.unlocking===job)this.unlocking=undefined;});
    this.unlocking=job;return job;
  }
  stage(clocks:(context:ProductionFrameContext)=>RuntimeClockSnapshot,commands:()=>readonly ProductionAudioCommand[],transport?:(context:ProductionFrameContext)=>ProductionFrameTransport|undefined):ProductionFrameStage{
    return{id:'audio:'+this.id,phase:'geometry-draw',prepare:context=>{
      this.live();if(this.unlocking)throw new CompositionAudioPending(this.unlocking,this.id);
      if(this.failed)throw new ProductionFrameError('E_HYA_RUNTIME_AUDIO_FAILED','$.audio.'+this.id,'a committed audio operation failed; inspect its diagnostic before replacing this player');
      const current=Object.freeze({...clocks(context)}),actions=commands(),intent=transport?.(context);
      if(intent)this.owner.assertRate(intent.rate);
      if(!this.armed&&actions.some(command=>command.kind!=='stop-cue'))throw new ProductionFrameError('E_AUDIO_RUNTIME_AUTOPLAY','$.audio.'+this.id,'unlock audio from the actual user gesture before invoking a cue');
      const clockChanged=this.armed&&(!this.lastClocks||(['composition','state','event'] as const).some(domain=>this.lastClocks![domain]!==current[domain])||!!intent&&(!!intent.relocation||this.lastTransport?.status!==intent.status||this.lastTransport?.rate!==intent.rate));
      if(!clockChanged&&!actions.length)return{value:Object.freeze({armed:this.armed,clocks:current,commands:0}),commit(){},rollback(){}};
      const batch=this.owner.prepareBatch([...(clockChanged?[intent?{kind:'transport' as const,clocks:current,rate:intent.rate,status:intent.status,...(intent.relocation?{relocation:intent.relocation}:{})}:{kind:'clock' as const,clocks:current,rate:1}]:[]),...actions],()=>{if(this.failed)throw this.fault;},intent?.status);
      let committed=false;
      return{value:Object.freeze({armed:this.armed,clocks:current,commands:Number(clockChanged)+actions.length}),commit:()=>{committed=true;if(clockChanged){this.lastClocks=current;this.lastTransport=intent;}},rollback:()=>batch.rollback(),publish:()=>{
        if(!committed)return;
        this.settled=batch.publish().catch(error=>{if(!this.disposed){this.failed=true;this.fault=error;this.diagnostic(error);}throw error;});
        // Synchronous frame users receive the diagnostic, without an unhandled rejection.
        void this.settled.catch(()=>undefined);
      }};
    },dispose:()=>this.dispose()};
  }
  assertRate(rate:number):void{this.live();this.owner.assertRate(rate);}
  whenSettled():Promise<void>{return this.settled;}
  get trace():readonly ProductionAudioTrace[]{return this.owner.trace;}
  get stats(){return Object.freeze({...this.owner.stats,armed:this.armed,failed:this.failed});}
  dispose():void{if(this.disposed)return;this.disposed=true;this.owner.dispose();}
  private live():void{if(this.disposed)throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED','$.audio.'+this.id,'audio composition owner is disposed');}
}
