import {mat4} from 'wgpu-matrix';
import {Frustum} from '../culling/Frustum';
import type {Camera3DFrameData} from '../frame/FrameData';
import type {RenderViewSnapshot} from './RenderView';
import {getRegionSceneProjection,writeRegionCameraProjection} from './RegionSceneProjection';

interface CameraWindow {
  readonly data:Camera3DFrameData;
  sourceFrame:number;
  sourceRevision:number;
  revision:number;
}
const cameras=new WeakMap<Camera3DFrameData,Map<string,CameraWindow>>();

/** A camera keeps its original aspect while geometry/culling use the selected work window.
 * The source frame is borrowed and never mutated. This CPU-only cache owns no GPU resources. */
export function regionCameraFrame(source:Camera3DFrameData,view:RenderViewSnapshot):Camera3DFrameData {
  const projection=getRegionSceneProjection(view);
  if(!projection?.cameraViewport)return source;
  const r=projection.cameraViewport,key=JSON.stringify([source.entity.id,r.x,r.y,r.width,r.height,view.width,view.height,source.width,source.height,source.reverseZ]);
  let windows=cameras.get(source);if(!windows){windows=new Map();cameras.set(source,windows);}
  let window=windows.get(key);
  if(!window){
    // Bound CPU camera variants independently of retained color admission.
    if(windows.size>=32)windows.delete(windows.keys().next().value!);
    window={sourceFrame:-1,sourceRevision:-1,revision:0,data:{...source,projectionMatrix:new Float32Array(16),viewProjectionMatrix:new Float32Array(16),inverseViewProjectionMatrix:new Float32Array(16),frustum:new Frustum(),frustumPlanes:new Float32Array(24),projectionJitter:new Float32Array(2)}};
    windows.set(key,window);
  }
  if(window.sourceFrame===source.frameId&&window.sourceRevision===source.phaseRevision)return window.data;
  const data=window.data;
  data.entity=source.entity;data.camera=source.camera;data.viewMatrix=source.viewMatrix;data.worldMatrix=source.worldMatrix;data.position=source.position;
  data.width=view.width;data.height=view.height;data.reverseZ=source.reverseZ;data.frameId=source.frameId;data.phaseRevision=++window.revision;data.projectionJitter.set(source.projectionJitter);
  writeRegionCameraProjection(data.projectionMatrix,source.projectionMatrix,view);
  writeRegionCameraProjection(data.viewProjectionMatrix,source.viewProjectionMatrix,view);
  mat4.inverse(data.viewProjectionMatrix,data.inverseViewProjectionMatrix);
  data.frustum.setFromViewProjection(data.viewProjectionMatrix).copyPlanesTo(data.frustumPlanes);
  window.sourceFrame=source.frameId;window.sourceRevision=source.phaseRevision;return data;
}
