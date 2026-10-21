import type {ScissorRect} from '../core/ViewportRect';
import {SubmissionLifetime} from '../rtt/SubmissionLifetime';
import type {PostProcessPass} from './PostProcessPass';
import {getPostProcessRecording} from './PostProcessSubmission';

interface CropTarget {readonly texture:GPUTexture;readonly lifetime:SubmissionLifetime;readonly bytes:number;lastFrame:number;}
/** Per-record working copies, never previous-frame pixel storage. Keeps the frozen output shader ABI. */
export class SceneOutputCrop {
  private readonly targets=new Map<string,CropTarget>();
  readonly stats={copies:0,copyBytes:0,workingBytes:0,retiringBytes:0};
  constructor(private readonly device:GPUDevice){}
  copy(owner:PostProcessPass,encoder:GPUCommandEncoder,source:GPUTexture,crop:Readonly<ScissorRect>,frameId:number):GPUTexture {
    if(crop.x===0&&crop.y===0&&crop.width===source.width&&crop.height===source.height)return source;
    if(![crop.x,crop.y,crop.width,crop.height].every(Number.isSafeInteger)||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>source.width||crop.y+crop.height>source.height)throw Error('Invalid scene output source crop.');
    if(source.format!=='rgba16float'||!(source.usage&GPUTextureUsage.COPY_SRC))throw Error('Scene output source crops require copyable linear HDR input.');
    const recording=getPostProcessRecording(owner);
    if(!recording?.afterCancel)throw Error('Scene output crops require submission and cancellation boundaries.');
    for(const [key,target]of this.targets)if(frameId-target.lastFrame>1){this.targets.delete(key);this.retire(target);}
    const key=`${source.format}:${crop.width}x${crop.height}`;
    let target=this.targets.get(key);
    if(!target){
      const texture=this.device.createTexture({label:`SceneOutput.sourceCrop.${key}`,size:[crop.width,crop.height],format:source.format,usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
      const bytes=crop.width*crop.height*8;
      target={texture,bytes,lastFrame:frameId,lifetime:new SubmissionLifetime(this.device,()=>{texture.destroy();this.stats.workingBytes-=bytes;this.stats.retiringBytes-=bytes;})};
      this.targets.set(key,target);this.stats.workingBytes+=bytes;
    }
    target.lastFrame=frameId;target.lifetime.retainSubmission(recording,recording.afterSubmit,recording.afterCancel);
    encoder.copyTextureToTexture({texture:source,origin:[crop.x,crop.y,0]},{texture:target.texture},[crop.width,crop.height,1]);
    this.stats.copies++;this.stats.copyBytes+=target.bytes;return target.texture;
  }
  private retire(target:CropTarget):void {this.stats.retiringBytes+=target.bytes;target.lifetime.retire();}
  destroy():void {for(const target of this.targets.values())this.retire(target);this.targets.clear();}
}
