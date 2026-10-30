import type {PostProcessFrameContext,PostProcessPass} from './PostProcessPass';
import {getPostProcessRecording} from './PostProcessSubmission';
import {SubmissionLifetime} from '../rtt/SubmissionLifetime';

interface Binding {readonly buffer:GPUBuffer;readonly values:Uint8Array;readonly lifetime:SubmissionLifetime;written:boolean;lastFrame:number;}

/** View-local parameters. Changed values may not overwrite an unsubmitted use. */
export class PostProcessViewUniforms {
  private device:GPUDevice|undefined;
  private label='';
  private size=0;
  private spare:Binding|undefined;
  private readonly bindings=new Map<string,Binding>();
  prepare(device:GPUDevice,label:string,size:number):GPUBuffer {
    this.destroy();this.device=device;this.label=label;this.size=size;
    this.spare=this.create();return this.spare.buffer;
  }
  write(pass:PostProcessPass,frame:Pick<PostProcessFrameContext,'viewKey'|'frameId'>,data:ArrayBuffer):GPUBuffer {
    const device=this.device;if(!device||data.byteLength!==this.size)throw Error('Postprocess view parameters require matching prepared storage.');
    const bytes=new Uint8Array(data);
    for(const [key,binding]of this.bindings)if(key!==frame.viewKey&&frame.frameId-binding.lastFrame>120){this.bindings.delete(key);binding.lifetime.retire();}
    let binding=this.bindings.get(frame.viewKey);
    let changed=!binding||!binding.written||!equal(binding.values,bytes);
    if(binding&&changed&&binding.lifetime.hasPendingRecordings){binding.lifetime.retire();binding=undefined;}
    if(!binding){binding=this.spare??this.create();this.spare=undefined;this.bindings.set(frame.viewKey,binding);changed=true;}
    const recording=getPostProcessRecording(pass);
    if(recording)binding.lifetime.retainSubmission(recording,recording.afterSubmit,recording.afterCancel);
    if(changed){binding.values.set(bytes);device.queue.writeBuffer(binding.buffer,0,binding.values.buffer as ArrayBuffer);binding.written=true;}
    binding.lastFrame=frame.frameId;return binding.buffer;
  }
  private create():Binding {
    const buffer=this.device!.createBuffer({label:this.label,size:this.size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    return{buffer,values:new Uint8Array(this.size),lifetime:new SubmissionLifetime(this.device!,()=>buffer.destroy()),written:false,lastFrame:-1};
  }
  destroy():void {
    this.spare?.lifetime.retire();this.spare=undefined;
    for(const binding of this.bindings.values())binding.lifetime.retire();this.bindings.clear();this.device=undefined;
  }
}
function equal(a:Uint8Array,b:Uint8Array):boolean {for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
