import type {RenderCommandContext} from '../core/RenderCommandContext';
import {SubmissionLifetime} from '../rtt/SubmissionLifetime';

const owners=new WeakMap<GPUDevice,Set<RecordedGpuResources>>();
/** Private owner for immutable resources referenced by independently submitted recordings. */
export class RecordedGpuResources {
  private readonly resources=new Map<object,SubmissionLifetime>();
  constructor(private readonly device:GPUDevice) {}
  own<T extends object>(resource:T,destroy:()=>void):T {
    if(this.resources.has(resource))return resource;
    let live=owners.get(this.device);
    if(!live){live=new Set();owners.set(this.device,live);const selected=live;void this.device.lost?.then(()=>{for(const owner of [...selected])owner.abandon();selected.clear();});}
    live.add(this);
    this.resources.set(resource,new SubmissionLifetime(this.device,()=>{this.resources.delete(resource);destroy();if(!this.resources.size)owners.get(this.device)?.delete(this);}));
    return resource;
  }
  retain(resource:object,context:RenderCommandContext|undefined):void {
    if(!context?.afterSubmit)return;
    if(context.device&&context.device!==this.device)throw Error('Recorded GPU resource belongs to another device.');
    this.resources.get(resource)?.retainSubmission(context,callback=>context.afterSubmit!(callback),context.afterCancel?callback=>context.afterCancel!(callback):undefined);
  }
  pending(resource:object|undefined, exceptContext?:object):boolean {return !!resource&&!!this.resources.get(resource)?.hasPendingRecordingsOtherThan(exceptContext);}
  /** Only encoded writes can reuse storage within one encoder; queue writes still require pending(). */
  pendingOutsideEncoder(resource:object|undefined, context:RenderCommandContext|undefined):boolean {
    const encoder=context?.encoder;
    return !!resource&&!!this.resources.get(resource)?.hasPendingRecordingsNotMatching(token=>token===context||!!encoder&&(token as Partial<RenderCommandContext>).encoder===encoder);
  }
  retire(resource:object):void {this.resources.get(resource)?.retire();}
  retireAll():void {for(const lifetime of this.resources.values())lifetime.retire();}
  private abandon():void {for(const lifetime of this.resources.values())lifetime.abandon();}
}
