import {mat4} from 'wgpu-matrix';
import type {RenderCommandContext} from '../../core/RenderCommandContext';
import type {RenderViewSnapshot} from '../../core/RenderView';
import {writeRegionRasterProjection} from '../../core/RegionSceneProjection';
import {SCENE_FRAME_UNIFORM_FLOATS,SceneFrameUniformLayout,type SceneFrameUniformSnapshot} from '../../frame/SceneFrameUniformLayout';
import {SubmissionLifetime} from '../../rtt/SubmissionLifetime';
import {getSceneFrameGpuArena} from '../SceneFrameGpuArena';

const offset=(name:string)=>SceneFrameUniformLayout.fields.find(f=>f.name===name)!.offset/4;
const vp=offset('viewProjection'),inverse=offset('inverseViewProjection'),viewport=offset('viewport');
/** A stable, view-owned arena stream. Geometry and full-raster consumers keep distinct coordinate contracts. */
export class RegionSceneFrameBinding {
  readonly binding;
  readonly snapshot={frameId:-1,phaseRevision:0,cameraEntityId:-1,data:new Float32Array(SCENE_FRAME_UNIFORM_FLOATS)};
  private readonly next=new Float32Array(SCENE_FRAME_UNIFORM_FLOATS);
  private readonly lifetime:SubmissionLifetime;
  constructor(device:GPUDevice){this.binding=getSceneFrameGpuArena(device).createBinding();this.lifetime=new SubmissionLifetime(device,()=>this.binding.destroy());}
  update(source:SceneFrameUniformSnapshot,view:RenderViewSnapshot,coordinates:'geometry'|'raster',context:RenderCommandContext):SceneFrameUniformSnapshot {
    this.lifetime.retain(context);
    this.next.set(source.data.subarray(0,SCENE_FRAME_UNIFORM_FLOATS));
    this.next.set([view.width,view.height,1/view.width,1/view.height],viewport);
    if(coordinates==='raster'){
      writeRegionRasterProjection(this.next.subarray(vp,vp+16),source.data.subarray(vp,vp+16),view);
      mat4.inverse(this.next.subarray(vp,vp+16),this.next.subarray(inverse,inverse+16));
    }
    const snapshot=this.snapshot;
    if(snapshot.frameId!==source.frameId||snapshot.cameraEntityId!==source.cameraEntityId||this.next.some((n,i)=>n!==snapshot.data[i])){
      snapshot.frameId=source.frameId;snapshot.cameraEntityId=source.cameraEntityId;snapshot.phaseRevision++;snapshot.data.set(this.next);
    }
    return snapshot;
  }
  destroy(abandon=false):void {if(abandon)this.lifetime.abandon();else this.lifetime.retire();}
}
