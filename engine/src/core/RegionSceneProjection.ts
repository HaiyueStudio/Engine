import type {RenderViewSnapshot} from './RenderView';
import type {ScissorRect,ViewportRect} from './ViewportRect';
import {getRegionProjection,isRegionRenderTarget} from './RegionRenderTarget';

interface RegionSceneProjection {
  /** Hardware geometry viewport in the working raster; it may extend past the attachment. */
  readonly viewport:Readonly<ViewportRect>;
  /** Visible pixels in that raster; output coverage is stored in the view itself. */
  readonly crop:Readonly<ScissorRect>;
  /** Original camera geometry when an oversized raster uses a bounded window. */
  readonly cameraViewport?:Readonly<ViewportRect>;
  /** Original clip coordinates expressed relative to the retained hardware viewport. */
  readonly cameraTransform?:Readonly<ViewportRect>;
}
const projections=new WeakMap<RenderViewSnapshot,RegionSceneProjection>();
export function getRegionSceneProjection(view:RenderViewSnapshot|undefined):RegionSceneProjection|undefined {return view?projections.get(view):undefined;}
export function getRegionCameraViewport(view:RenderViewSnapshot):Readonly<ViewportRect>|undefined {
  const projection=getRegionSceneProjection(view);return projection?.cameraViewport??projection?.viewport;
}

/** Convert geometry clip coordinates to the working raster's NDC. */
export function writeRegionRasterProjection(out:Float32Array,matrix:ArrayLike<number>,view:RenderViewSnapshot|undefined):Float32Array {
  const projection=getRegionSceneProjection(view);
  if(!projection){for(let i=0;i<16;i++)out[i]=matrix[i]!;return out;}
  return writeViewportProjection(out,matrix,projection.viewport,view!.width,view!.height);
}

/** Apply only the oversized camera's window transform; ordinary regional cameras stay unchanged. */
export function writeRegionCameraProjection(out:Float32Array,matrix:ArrayLike<number>,view:RenderViewSnapshot):Float32Array {
  const projection=getRegionSceneProjection(view);
  if(!projection?.cameraViewport){for(let i=0;i<16;i++)out[i]=matrix[i]!;return out;}
  return writeViewportProjection(out,matrix,projection.cameraTransform??projection.cameraViewport,projection.viewport.width,projection.viewport.height);
}

function writeViewportProjection(out:Float32Array,matrix:ArrayLike<number>,r:Readonly<ViewportRect>,w:number,h:number):Float32Array {
  const sx=r.width/w,sy=r.height/h,tx=(2*r.x+r.width)/w-1,ty=1-(2*r.y+r.height)/h;
  for(let c=0;c<4;c++){const i=c*4,x=matrix[i]!,y=matrix[i+1]!,z=matrix[i+2]!,clipW=matrix[i+3]!;out[i]=sx*x+tx*clipW;out[i+1]=sy*y+ty*clipW;out[i+2]=z;out[i+3]=clipW;}
  return out;
}

/** Separate camera/HDR geometry from the clipped destination. GUI keeps its own projection. */
export function regionSceneView(view:RenderViewSnapshot,maximumDimension=Infinity,maximumPrecisionPixels=0):RenderViewSnapshot {
  if(!isRegionRenderTarget(view.target))return view;
  if(projections.has(view))return view;
  const projection=getRegionProjection(view)??view.viewport;
  if(!projection)return view;
  if(!(maximumDimension>0)||(!Number.isSafeInteger(maximumDimension)&&maximumDimension!==Infinity))throw RangeError('Invalid regional scene texture limit.');
  const left=Math.floor(projection.x),top=Math.floor(projection.y),right=Math.ceil(projection.x+projection.width),bottom=Math.ceil(projection.y+projection.height);
  const x=Math.max(0,left),y=Math.max(0,top),endX=Math.min(view.target.width,right),endY=Math.min(view.target.height,bottom);
  if(![left,top,right,bottom].every(Number.isSafeInteger)||right<=left||bottom<=top||endX<=x||endY<=y)throw Error('Invalid regional scene projection.');
  if(right-left>maximumDimension||bottom-top>maximumDimension){
    const original=Object.freeze({...projection,x:projection.x-left,y:projection.y-top});
    const factorX=2**Math.max(0,Math.ceil(Math.log2(original.width/maximumDimension))),factorY=2**Math.max(0,Math.ceil(Math.log2(original.height/maximumDimension)));
    const precisionViewport=Object.freeze({x:original.x+original.width/2-original.width/factorX/2,y:original.y+original.height/2-original.height/factorY/2,width:original.width/factorX,height:original.height/factorY,minDepth:projection.minDepth??0,maxDepth:projection.maxDepth??1});
    const prefixWidth=right-left>maximumDimension?endX-left:right-left,prefixHeight=bottom-top>maximumDimension?endY-top:bottom-top;
    const prefixCrop=Object.freeze({x:x-left,y:y-top,width:endX-x,height:endY-y});
    if(prefixWidth<=maximumDimension&&prefixHeight<=maximumDimension&&prefixWidth*prefixHeight<=maximumPrecisionPixels&&prefixCrop.x>=precisionViewport.x&&prefixCrop.y>=precisionViewport.y&&prefixCrop.x+prefixCrop.width<=precisionViewport.x+precisionViewport.width&&prefixCrop.y+prefixCrop.height<=precisionViewport.y+precisionViewport.height){
      // A power-of-two camera scale and reciprocal hardware viewport scale keep
      // the original viewport center and sample-grid coordinates. This avoids
      // changing large-raster edge coverage just to translate a small crop.
      const output=Object.freeze({x,y,width:prefixCrop.width,height:prefixCrop.height}),next=Object.freeze({...view,width:prefixWidth,height:prefixHeight,viewport:output,scissor:output});
      const cameraTransform=Object.freeze({x:(1-factorX)*precisionViewport.width/2,y:(1-factorY)*precisionViewport.height/2,width:precisionViewport.width*factorX,height:precisionViewport.height*factorY});
      projections.set(next,Object.freeze({viewport:precisionViewport,cameraViewport:original,cameraTransform,crop:prefixCrop}));return next;
    }
    const boundedX=right-left>maximumDimension,boundedY=bottom-top>maximumDimension;
    const originX=boundedX?x:left,originY=boundedY?y:top,width=boundedX?endX-x:right-left,height=boundedY?endY-y:bottom-top;
    if(width>maximumDimension||height>maximumDimension)throw RangeError('Regional scene visible output exceeds the device texture limit.');
    // Keep fitting axes and their fractional hardware viewport unchanged. Only
    // an overflowing axis becomes a camera window; this also preserves the
    // original clip boundary when an end of that viewport is visible.
    const cameraViewport=Object.freeze({...projection,x:projection.x-originX,y:projection.y-originY});
    const vx=boundedX?Math.max(0,cameraViewport.x):cameraViewport.x,vy=boundedY?Math.max(0,cameraViewport.y):cameraViewport.y;
    const vw=boundedX?Math.min(width,cameraViewport.x+cameraViewport.width)-vx:cameraViewport.width,vh=boundedY?Math.min(height,cameraViewport.y+cameraViewport.height)-vy:cameraViewport.height;
    const viewport=Object.freeze({x:vx,y:vy,width:vw,height:vh,minDepth:projection.minDepth??0,maxDepth:projection.maxDepth??1});
    const cameraTransform=Object.freeze({x:cameraViewport.x-vx,y:cameraViewport.y-vy,width:cameraViewport.width,height:cameraViewport.height});
    const crop=Object.freeze({x:x-originX,y:y-originY,width:endX-x,height:endY-y}),output=Object.freeze({x,y,width:crop.width,height:crop.height});
    const next=Object.freeze({...view,width,height,viewport:output,scissor:output});
    projections.set(next,Object.freeze({viewport,cameraViewport,cameraTransform,crop}));return next;
  }
  const viewport=Object.freeze({...projection,x:projection.x-left,y:projection.y-top});
  const crop=Object.freeze({x:x-left,y:y-top,width:endX-x,height:endY-y});
  const output=Object.freeze({x,y,width:crop.width,height:crop.height});
  const next=Object.freeze({...view,width:right-left,height:bottom-top,viewport:output,scissor:output});
  projections.set(next,Object.freeze({viewport,crop}));return next;
}
