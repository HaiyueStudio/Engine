import{EngineError,EngineErrorCode}from'@haiyue/engine/core';
import{getExtensionGPUResourceTracker,type IEngine,type RenderCommandContext}from'@haiyue/engine/extension-authoring';
export interface TileBuffer {buffer:GPUBuffer;bytes:number;leases:Set<RenderCommandContext>;pending:number;submitted:boolean;retired:boolean;destroyed:boolean;}
/** Uses the original frame's submit/cancel boundary and original GPUResourceTracker. */
export class TilemapGpuOwner {
  private readonly resources=new Set<TileBuffer>();
  private readonly tracker;
  private lost=false;
  private fenceScheduled=false;
  private readonly awaitingFence=new Set<TileBuffer>();
  private readonly device:GPUDevice;
  private readonly contexts=new WeakMap<RenderCommandContext,{resources:Set<TileBuffer>;closed:boolean}>();
  constructor(engine:IEngine){
    this.device=engine.device;this.tracker=getExtensionGPUResourceTracker(engine);
    const weak=new WeakRef(this),lost=()=>{const owner=weak.deref();if(!owner)return;owner.lost=true;for(const value of owner.resources)owner.finish(value);};
    void this.device.lost?.then(lost,lost);
  }
  create(bytes:number,usage:GPUBufferUsageFlags,label:string):TileBuffer {
    const buffer=this.device.createBuffer({size:Math.max(4,bytes),usage,label});this.tracker?.trackBuffer(buffer,label,Math.max(4,bytes));
    const value={buffer,bytes:Math.max(4,bytes),leases:new Set<RenderCommandContext>(),pending:0,submitted:false,retired:false,destroyed:false};this.resources.add(value);return value;
  }
  use(value:TileBuffer,context:RenderCommandContext):void {
    if(value.retired||value.destroyed)throw new EngineError(EngineErrorCode.ResourceOwnerReleased,'Tilemap buffer has retired.');
    if(!context.afterSubmit||!context.afterCancel){value.submitted=true;return;} // Legacy immediate recording: caller owns submit ordering.
    let frame=this.contexts.get(context);
    if(frame){if(frame.closed)throw new EngineError(EngineErrorCode.RenderCommandContextInvalid,'Tilemap recording already submitted or cancelled.');if(frame.resources.has(value))return;frame.resources.add(value);value.leases.add(context);return;}
    frame={resources:new Set([value]),closed:false};this.contexts.set(context,frame);value.leases.add(context);
    const current=frame;
    context.afterSubmit(queue=>{
      if(current.closed)return;current.closed=true;const resources=[...current.resources];current.resources.clear();
      for(const resource of resources){resource.leases.delete(context);resource.submitted=true;this.tryFinish(resource);}
    });
    context.afterCancel(()=>{if(current.closed)return;current.closed=true;for(const resource of current.resources){resource.leases.delete(context);this.tryFinish(resource);}current.resources.clear();});
    if(current.closed)throw new EngineError(EngineErrorCode.RenderCommandContextInvalid,'Tilemap context is already closed.');
  }
  private completed(value:TileBuffer):void {value.pending--;this.tryFinish(value);}
  retire(value:TileBuffer):void {value.retired=true;this.tryFinish(value);}
  private tryFinish(value:TileBuffer):void {
    if(!value.retired||value.destroyed||value.leases.size||value.pending)return;
    if(!value.submitted){this.finish(value);return;}
    this.awaitingFence.add(value);if(this.fenceScheduled)return;this.fenceScheduled=true;
    queueMicrotask(()=>{
      this.fenceScheduled=false;const values=[...this.awaitingFence].filter(v=>!v.destroyed&&!v.leases.size);this.awaitingFence.clear();if(!values.length)return;
      for(const resource of values){resource.pending++;resource.submitted=false;}
      const complete=()=>{for(const resource of values)this.completed(resource);};
      void this.device.queue.onSubmittedWorkDone().then(complete,complete);
    });
  }
  private finish(value:TileBuffer):void {if(value.destroyed)return;value.destroyed=true;this.tracker?.untrackBuffer(value.buffer);value.buffer.destroy();this.resources.delete(value);}
  destroy():void {for(const value of this.resources)this.retire(value);if(this.lost)for(const value of this.resources)this.finish(value);}
  get stats(){let activeBytes=0,retiredBytes=0,pendingRecordings=0;for(const r of this.resources){if(r.retired)retiredBytes+=r.bytes;else activeBytes+=r.bytes;pendingRecordings+=r.leases.size;}return {buffers:this.resources.size,activeBytes,retiredBytes,totalBytes:activeBytes+retiredBytes,pendingRecordings};}
}
