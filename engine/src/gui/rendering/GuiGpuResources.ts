import type {RenderCommandContext} from '../../core/RenderCommandContext';
import {SubmissionLifetime} from '../../rtt/SubmissionLifetime';
import {writeBuffer} from '../../renderer/utils';

interface BufferSlot {readonly buffer:GPUBuffer;readonly size:number;version:unknown;}
type Resource=GPUBuffer|GPUTexture;
const deviceOwners=new WeakMap<GPUDevice,Set<GuiGpuResources>>();
/** Mutable CPU batches may change while an older encoder still references their
 * GPU data. Keep changed pending versions immutable; reuse submitted capacity. */
export class GuiGpuResources {
 private buffers=new WeakMap<object,BufferSlot>();
 private readonly resources=new Map<Resource,SubmissionLifetime>();
 private readonly retiring=new Set<Resource>();
 private readonly managedResources=new Set<Resource>();
 private readonly legacyResources=new Set<Resource>();
 private disposed=false;
 constructor(private readonly device:GPUDevice){}
 own<T extends Resource>(resource:T):T {
  if(this.disposed)throw Error('GUI GPU resources have been disposed.');
  if(this.resources.has(resource))return resource;
  let owners=deviceOwners.get(this.device);
  if(!owners){owners=new Set();deviceOwners.set(this.device,owners);const live=owners;void this.device.lost?.then(()=>{for(const owner of [...live])owner.abandon();live.clear();});}
  owners.add(this);
  this.resources.set(resource,new SubmissionLifetime(this.device,()=>{this.resources.delete(resource);this.legacyResources.delete(resource);this.managedResources.delete(resource);this.retiring.delete(resource);resource.destroy();if(!this.resources.size)deviceOwners.get(this.device)?.delete(this);}));return resource;
 }
 reserve(key:object,size:number,usage:GPUBufferUsageFlags,label:string):GPUBuffer {
  const slot=this.buffers.get(key);if(slot&&slot.size>=size)return slot.buffer;
  const buffer=this.own(this.device.createBuffer({label,size:Math.max(4,Math.ceil(size/4)*4),usage}));
  this.buffers.set(key,{buffer,size:buffer.size,version:undefined});if(slot)this.retire(slot.buffer);return buffer;
 }
 upload(key:object,version:unknown,data:Float32Array,size:number,usage:GPUBufferUsageFlags,label:string,context?:RenderCommandContext):GPUBuffer {
  let slot=this.buffers.get(key);
  if(slot&&slot.version!==version&&this.resources.get(slot.buffer)?.hasPendingRecordings){this.buffers.delete(key);this.retire(slot.buffer);slot=undefined;}
  const buffer=this.reserve(key,size,usage,label);slot=this.buffers.get(key)!;
  if(slot.version!==version){writeBuffer(this.device.queue,buffer,0,data,0,size);slot.version=version;}
  this.retain(buffer,context);return buffer;
 }
 retain(resource:Resource,context:RenderCommandContext|undefined):void {
  const lifetime=this.resources.get(resource);
  if(lifetime&&!context?.afterSubmit)this.legacyResources.add(resource);
  if(lifetime&&context?.afterSubmit){this.managedResources.add(resource);lifetime.retainSubmission(context,callback=>context.afterSubmit!(callback),context.afterCancel?callback=>context.afterCancel!(callback):undefined);}
 }
 release(key:object):void {const slot=this.buffers.get(key);if(slot){this.buffers.delete(key);this.retire(slot.buffer);}}
 retire(resource:Resource,legacyQueueFence=false):void {
  const lifetime=this.resources.get(resource);if(!lifetime||this.disposed||this.retiring.has(resource))return;this.retiring.add(resource);
  // Legacy direct drawing has no recording callbacks. Preserve its submitted
  // queue-fence retirement for replaced atlases/images; managed recordings
  // always use their actual boundaries and can never be abandoned here.
  if(legacyQueueFence&&this.legacyResources.has(resource)&&!lifetime.hasPendingRecordings)lifetime.retainSubmission({},callback=>callback(this.device.queue));
  lifetime.retire();
 }
 destroy():void {if(this.disposed)return;this.disposed=true;this.buffers=new WeakMap();for(const [resource,lifetime]of this.resources)if(this.legacyResources.has(resource)&&!this.managedResources.has(resource)&&!lifetime.hasPendingRecordings)lifetime.abandon();else lifetime.retire();}
 private abandon():void {this.disposed=true;this.buffers=new WeakMap();for(const lifetime of this.resources.values())lifetime.abandon();}
}
