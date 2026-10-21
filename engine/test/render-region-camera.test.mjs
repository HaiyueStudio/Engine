import test from 'node:test';
import assert from 'node:assert/strict';
import {mat4} from 'wgpu-matrix';
import {importEngineSource} from './helpers/internal-source.mjs';
const {regionSceneView,writeRegionRasterProjection,writeRegionCameraProjection,getRegionSceneProjection}=await importEngineSource('core/RegionSceneProjection.ts');
const {registerRegionRenderTarget,setRegionProjection}=await importEngineSource('core/RegionRenderTarget.ts');
const {regionCameraFrame}=await importEngineSource('core/RegionSceneCamera.ts');
const project=(m,[x,y,z])=>{const w=m[3]*x+m[7]*y+m[11]*z+m[15];return [0,1,2].map(i=>(m[i]*x+m[i+4]*y+m[i+8]*z+m[i+12])/w);};

function fixture(){
 const target={width:128,height:80};registerRegionRenderTarget(target);const view={target,width:128,height:80,viewport:{x:0,y:0,width:128,height:80}};
 setRegionProjection(view,{x:-192.25,y:-22.5,width:512.5,height:128.25});
 const source={entity:{id:1},camera:{},projectionMatrix:Float32Array.from(mat4.perspective(Math.PI/3,512.5/128.25,.1,100)),viewMatrix:Float32Array.from(mat4.identity()),worldMatrix:Float32Array.from(mat4.identity()),position:new Float32Array(3),width:512.5,height:128.25,reverseZ:false,projectionJitter:new Float32Array(2),frameId:1,phaseRevision:1};source.viewProjectionMatrix=source.projectionMatrix.slice();source.inverseViewProjectionMatrix=Float32Array.from(mat4.inverse(source.viewProjectionMatrix));return {source,view:regionSceneView(view,256)};
}
test('bounded camera packing preserves source data and maps original viewport pixel positions exactly',()=>{
 const {source,view}=fixture(),before=source.projectionMatrix.slice(),bounded=regionCameraFrame(source,view);
 assert.notEqual(bounded,source);assert.deepEqual(source.projectionMatrix,before);assert.equal(source.width,512.5);assert.equal(bounded.width,128);assert.equal(bounded.height,129);const p=getRegionSceneProjection(view),v=p.viewport;
 for(const x of [-.5,0,.5])for(const y of [-.5,0,.5]){
  const original=project(source.projectionMatrix,[x,y,-3]),cropped=project(bounded.projectionMatrix,[x,y,-3]);
  const expectedX=-192.25+(original[0]+1)*512.5/2,expectedY=-22.5+(1-original[1])*128.25/2;
  assert.ok(Math.abs(v.x+(cropped[0]+1)*v.width/2-p.crop.x-expectedX)<.0001);assert.ok(Math.abs(v.y+(1-cropped[1])*v.height/2-p.crop.y-expectedY)<.0001);assert.ok(Math.abs(cropped[2]-original[2])<1e-7);
 }
 const identity=mat4.multiply(bounded.viewProjectionMatrix,bounded.inverseViewProjectionMatrix);for(let i=0;i<16;i++)assert.ok(Math.abs(identity[i]-(i%5===0?1:0))<1e-5);
 const raster=writeRegionRasterProjection(new Float32Array(16),bounded.viewProjectionMatrix,view);for(let c=0;c<4;c++)assert.equal(raster[c*4],bounded.viewProjectionMatrix[c*4],'Do not apply the horizontal camera transform twice');
 for(const point of [[0,0,-3],[.1,.2,-2]]){const a=project(bounded.viewProjectionMatrix,point),b=project(raster,point);assert.ok(Math.abs((b[1]+1)*view.height/2-((a[1]+1)*v.height/2+view.height-v.y-v.height))<1e-4);}
});
test('bounded camera streams reuse only an unchanged source phase and keep separate window/camera identities',()=>{
 const {source,view}=fixture(),first=regionCameraFrame(source,view);assert.equal(regionCameraFrame(source,view),first);
 const revision=first.phaseRevision;source.frameId++;source.phaseRevision++;source.viewProjectionMatrix[12]=.2;const changed=regionCameraFrame(source,view);assert.equal(changed,first);assert.ok(changed.phaseRevision>revision);assert.notEqual(changed.viewProjectionMatrix[12],0);
 source.entity={id:2};assert.notEqual(regionCameraFrame(source,view),first);assert.equal(regionCameraFrame(source,{target:{}}),source);
});

test('precision camera changes only the overflowing matrix row by an exact power of two',()=>{
 for(const [x,width]of [[-4160.5,8449.5],[-4160.1,8449.1]]){
  const target={width:128,height:80};registerRegionRenderTarget(target);const original={target,width:128,height:80,viewport:null};setRegionProjection(original,{x,y:-22.5,width,height:128.25});const view=regionSceneView(original,8192,838860);
  for(const matrix of [Float32Array.from({length:16},(_,i)=>(i-7)*.0173),Float32Array.from(mat4.identity())]){const transformed=writeRegionCameraProjection(new Float32Array(16),matrix,view);for(let i=0;i<16;i++)assert.equal(transformed[i],i%4===0?matrix[i]*2:matrix[i]);}
 }
});
