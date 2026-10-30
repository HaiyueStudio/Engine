import type {RenderCommandContext} from '@haiyue/engine/extension-authoring';

interface BufferState {buffer:GPUBuffer;queue:GPUQueue;recordings:number;unfenced:boolean;retired:boolean;collecting:boolean;}
type Lifetime=Pick<RenderCommandContext,'afterSubmit'|'afterCancel'>;

/** Bounded vertex storage; queue writes precede submitted draws, open encoders use copy-on-write. */
export class LayoutGpuStorage {
  private readonly states=new Set<BufferState>();
  private current:BufferState|undefined;
  private source:Float32Array=new Float32Array();
  private disposed=false;
  constructor(private device:GPUDevice,private readonly maximum:number) {}
  upload(source:Float32Array):void {
    if(this.disposed)throw Error('E_LAYOUT_GPU_DISPOSED');
    if(source.byteLength>Math.min(this.maximum,this.device.limits.maxBufferSize))throw Error('E_LAYOUT_GPU_BUDGET');
    let first=0,last=source.length;
    if(this.source.length===source.length){while(first<last&&Object.is(source[first],this.source[first]))first++;while(last>first&&Object.is(source[last-1],this.source[last-1]))last--;}
    if(first===last&&this.current){return;}
    if(source.length===0){this.source=source;return;}
    const prior=this.current;
    if(prior&&prior.recordings===0&&!prior.unfenced&&prior.buffer.size>=source.byteLength){
      this.device.queue.writeBuffer(prior.buffer,first*4,source.subarray(first,last) as ArrayBufferView<ArrayBuffer>);
      this.source=new Float32Array(source);return;
    }
    let capacity=24;const limit=Math.min(this.maximum,this.device.limits.maxBufferSize);
    while(capacity<source.byteLength)capacity=Math.min(limit,capacity*2);
    if(this.bytes+capacity>this.maximum)throw Error('E_LAYOUT_GPU_BUDGET');
    const buffer=this.device.createBuffer({label:'Layout2D.vertices',size:capacity,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    try{this.device.queue.writeBuffer(buffer,0,source as ArrayBufferView<ArrayBuffer>);}catch(error){buffer.destroy();throw error;}
    const next:BufferState={buffer,queue:this.device.queue,recordings:0,unfenced:false,retired:false,collecting:false};
    this.states.add(next);this.current=next;this.source=new Float32Array(source);if(prior)this.retire(prior);
  }
  record(lifetime?:Lifetime):GPUBuffer|undefined {
    const value=this.current;if(!value)return undefined;
    if(!lifetime?.afterSubmit||!lifetime.afterCancel){value.unfenced=true;return value.buffer;}
    value.recordings++;let closed=false;
    const close=()=>{if(closed)return;closed=true;value.recordings--;this.collect(value);};
    try{lifetime.afterSubmit(close);lifetime.afterCancel(close);}catch(error){close();throw error;}
    return value.buffer;
  }
  lose():void {for(const value of this.states)value.buffer.destroy();this.states.clear();this.current=undefined;}
  recover(device:GPUDevice):void {this.lose();this.device=device;this.upload(this.source);}
  dispose():void {
    if(this.disposed)return;this.disposed=true;this.current=undefined;this.source=new Float32Array();
    for(const value of this.states){if(value.unfenced){value.buffer.destroy();this.states.delete(value);}else this.retire(value);}
  }
  private retire(value:BufferState):void {value.retired=true;this.collect(value);}
  private collect(value:BufferState):void {
    if(!this.states.has(value)||!value.retired||value.recordings||value.unfenced||value.collecting)return;
    value.collecting=true;
    // A legacy pass without terminal hooks stays retained until explicit
    // disposal/device loss. It cannot masquerade as a submitted recording.
    if(!value.queue.onSubmittedWorkDone){value.buffer.destroy();this.states.delete(value);return;}
    let fence:Promise<unknown>;try{fence=value.queue.onSubmittedWorkDone();}catch{fence=Promise.resolve();}
    void fence.catch(()=>{}).then(()=>{value.buffer.destroy();this.states.delete(value);});
  }
  get bytes():number {return [...this.states].reduce((sum,value)=>sum+value.buffer.size,0);}
  get count():number {return this.states.size;}
}
