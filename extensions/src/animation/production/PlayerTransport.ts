import {ProductionCompositionOwner,type ProductionCompositionFrame} from './CompositionOwner.js';
import {ProductionFrameError,snapshotProductionFrameRequest,type ProductionFrameRequest,type ProductionFrameTransport} from './FrameTransaction.js';
/** Internal transport owns downstream sequence identities; it is not the public Player facade. */
export class ProductionPlayerTransport {
  private sequence=0;
  private statusValue:'running'|'paused'|'stopped'|'disposed'='running';
  private rateValue=1;
  private version=0;
  private viewport:readonly[number,number];
  private dpr:number;
  private active=false;
  private attempted:Readonly<{key:string;version:number;request:ProductionFrameRequest;intent:ProductionFrameTransport;external:number}>|undefined;
  constructor(private readonly owner:ProductionCompositionOwner,viewport:readonly[number,number],dpr=1){
    const request=snapshotProductionFrameRequest({sequence:0,deltaSeconds:0,viewport,dpr});this.viewport=request.viewport;this.dpr=request.dpr;
  }
  get status(){return this.statusValue;}
  get rate(){return this.rateValue;}
  get lastFrame(){return this.owner.lastFrame;}
  advance(input:ProductionFrameRequest):ProductionCompositionFrame{
    this.idle();const publicRequest=snapshotProductionFrameRequest(input),key=JSON.stringify(publicRequest),previous=this.attempted;
    if(previous&&publicRequest.sequence<=previous.external){
      if(publicRequest.sequence!==previous.external||key!==previous.key||previous.version!==this.version)throw new ProductionFrameError('E_HYA_RUNTIME_SEQUENCE','$.sequence','repeat the exact frame or use a newer sequence after a transport control');
      return this.execute(previous.request,previous.intent);
    }
    const current=this.owner.lastFrame?.time??0,delta=this.statusValue==='running'?publicRequest.deltaSeconds*this.rateValue:0,next=Math.max(0,current+delta);
    if(!Number.isFinite(delta)||!Number.isFinite(next))throw new ProductionFrameError('E_HYA_RUNTIME_TIME','$.time','transport arithmetic must remain finite');
    const intent=Object.freeze({time:next,deltaSeconds:Math.max(0,next-current),rate:this.rateValue,status:this.statusValue as 'running'|'paused'|'stopped',...(next<current?{relocation:'seek' as const}:{})});
    const request=Object.freeze({...publicRequest,sequence:this.nextSequence()});
    this.attempted=Object.freeze({key,version:this.version,request,intent,external:publicRequest.sequence});
    return this.execute(request,intent);
  }
  seek(time:number):ProductionCompositionFrame{this.idle();if(!Number.isFinite(time)||time<0)throw new ProductionFrameError('E_HYA_RUNTIME_TIME','$.seek','seek requires finite nonnegative time');return this.control(this.statusValue as 'running'|'paused'|'stopped',this.rateValue,time,'seek');}
  setRate(rate:number):void{this.idle();this.owner.assertRate(rate);if(rate===this.rateValue)return;this.control(this.statusValue as 'running'|'paused'|'stopped',rate,this.owner.lastFrame?.time??0);}
  pause():void{this.idle();if(this.statusValue==='running')this.control('paused',this.rateValue,this.owner.lastFrame?.time??0);}
  resume():void{this.idle();if(this.statusValue!=='running')this.control('running',this.rateValue,this.owner.lastFrame?.time??0);}
  stop():void{this.idle();this.control('stopped',this.rateValue,0,'stop');}
  play():void{this.idle();this.control('running',this.rateValue,0,'restart');}
  unlockAudio():Promise<void>{this.idle();return this.owner.unlockAudio();}
  dispose():void{if(this.statusValue==='disposed')return;this.statusValue='disposed';this.owner.dispose();this.attempted=undefined;}
  private control(status:'running'|'paused'|'stopped',rate:number,time:number,relocation?:'seek'|'restart'|'stop'):ProductionCompositionFrame{
    const intent=Object.freeze({time,deltaSeconds:0,rate,status,...(relocation?{relocation}:{})}),request=Object.freeze({sequence:this.nextSequence(),deltaSeconds:0,viewport:this.viewport,dpr:this.dpr});
    const frame=this.execute(request,intent);this.statusValue=status;this.rateValue=rate;this.version++;return frame;
  }
  private execute(request:ProductionFrameRequest,intent:ProductionFrameTransport):ProductionCompositionFrame{this.active=true;try{return this.owner.advance(request,intent);}finally{this.active=false;if(this.owner.lastFrame?.sequence===request.sequence){this.viewport=request.viewport;this.dpr=request.dpr;}}}
  private nextSequence():number{if(!Number.isSafeInteger(this.sequence+1))throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT','$.sequence','transport sequence exhausted');return++this.sequence;}
  private idle():void{if(this.statusValue==='disposed')throw new ProductionFrameError('E_HYA_RUNTIME_DISPOSED','$.player','transport is disposed');if(this.active)throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT','$.player','transport is already advancing');}
}
