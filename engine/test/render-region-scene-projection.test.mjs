import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {regionSceneView,getRegionSceneProjection}=await importEngineSource('core/RegionSceneProjection.ts');
const {registerRegionRenderTarget,isRegionRenderTarget,isRegionDisplayTarget,setRegionProjection}=await importEngineSource('core/RegionRenderTarget.ts');
const {SceneOutputCrop}=await importEngineSource('postprocess/SceneOutputCrop.ts');
const {setPostProcessSubmission}=await importEngineSource('postprocess/PostProcessSubmission.ts');

test('a clipped 3D destination preserves full fractional camera/HDR geometry and integer source crop',()=>{
 const target={width:161,height:101};registerRegionRenderTarget(target);
 const view={target,width:100,height:80,viewport:{x:0,y:0,width:100,height:80},scissor:{x:0,y:0,width:100,height:80}};
 setRegionProjection(view,{x:-20.25,y:-9.5,width:115.5,height:84.25});const scene=regionSceneView(view),p=getRegionSceneProjection(scene);
 assert.equal(scene.width,117);assert.equal(scene.height,85);assert.deepEqual(scene.viewport,{x:0,y:0,width:96,height:75});
 assert.deepEqual(p.viewport,{x:.75,y:.5,width:115.5,height:84.25});assert.deepEqual(p.crop,{x:21,y:10,width:96,height:75});
 assert.equal(regionSceneView(scene),scene);assert.equal(view.width,100);assert.equal(getRegionSceneProjection(view),undefined);
 assert.ok(Object.isFrozen(p.crop)&&Object.isFrozen(scene));
 assert.throws(()=>regionSceneView(view,64),/visible output exceeds/);
});

test('an oversized camera raster uses a visible window without changing its original aspect or fractional origin',()=>{
 const target={width:128,height:80};registerRegionRenderTarget(target);const view={target,width:128,height:80,viewport:{x:0,y:0,width:128,height:80}};
 setRegionProjection(view,{x:-192.25,y:-22.5,width:512.5,height:128.25});const scene=regionSceneView(view,256),p=getRegionSceneProjection(scene);
 assert.equal(scene.width,128);assert.equal(scene.height,129);assert.deepEqual(p.cameraViewport,{x:-192.25,y:.5,width:512.5,height:128.25});assert.deepEqual(p.crop,{x:0,y:23,width:128,height:80});assert.deepEqual(scene.viewport,{x:0,y:0,width:128,height:80});
 assert.deepEqual(p.viewport,{x:0,y:.5,width:128,height:128.25,minDepth:0,maxDepth:1});assert.deepEqual(p.cameraTransform,{x:-192.25,y:0,width:512.5,height:128.25});assert.equal(getRegionSceneProjection(view),undefined);assert.equal(regionSceneView(scene,256),scene);
 for(const bad of [0,-1,NaN,1.5])assert.throws(()=>regionSceneView(view,bad),/texture limit/);
});
test('cached fractional projection uses its full raster without compressing geometry or adding a crop',()=>{
 const target={width:117,height:85};registerRegionRenderTarget(target);const view={target,viewport:{x:.75,y:.5,width:115.5,height:84.25}};
 const scene=regionSceneView(view),p=getRegionSceneProjection(scene);assert.deepEqual(p.crop,{x:0,y:0,width:117,height:85});assert.equal(p.viewport.width,115.5);assert.equal(scene.viewport.width,117);
 const ordinary={target:{width:117,height:85},viewport:view.viewport};assert.equal(regionSceneView(ordinary),ordinary);
});

test('an overflowing axis keeps visible original clip ends and leaves a fitting axis on its fractional hardware viewport',()=>{
 for(const x of [10.25,-412.25]){
  const target={width:128,height:80};registerRegionRenderTarget(target);const view={target,width:128,height:80,viewport:null};setRegionProjection(view,{x,y:5.5,width:512.5,height:20.25});
  const scene=regionSceneView(view,256),p=getRegionSceneProjection(scene);
  assert.equal(scene.height,21);assert.equal(p.viewport.y,.5);assert.equal(p.viewport.height,20.25);assert.equal(p.cameraTransform.y,0);
  if(x>0){assert.equal(p.viewport.x,.25);assert.equal(p.cameraTransform.x,0);assert.equal(p.crop.x,0);assert.equal(scene.viewport.x,10);}
  else{assert.equal(p.viewport.x,0);assert.equal(p.viewport.width,100.25);assert.equal(scene.width,101);assert.equal(p.crop.width,101);assert.equal(p.cameraTransform.x,-412.25);}
 }
});

test('a bounded prefix preserves original sample coordinates using reciprocal power-of-two viewport/camera scales',()=>{
 const target={width:128,height:80};registerRegionRenderTarget(target);const view={target,width:128,height:80,viewport:null,sampleCount:4};setRegionProjection(view,{x:-4160.5,y:-22.5,width:8449.5,height:128.25});
 const scene=regionSceneView(view,8192,838860),p=getRegionSceneProjection(scene);
 assert.equal(scene.width,4289);assert.equal(scene.height,129);assert.deepEqual(p.crop,{x:4161,y:23,width:128,height:80});
 assert.equal(p.cameraViewport.width/p.viewport.width,2);assert.equal(p.cameraViewport.height/p.viewport.height,1);
 assert.equal(p.viewport.x+p.viewport.width/2,p.cameraViewport.x+p.cameraViewport.width/2);assert.equal(p.viewport.y+p.viewport.height/2,p.cameraViewport.y+p.cameraViewport.height/2);
 assert.ok(p.viewport.x+p.viewport.width>scene.width,'The original raster center must not be translated just to fit an attachment');assert.ok(scene.width*scene.height<=838860);
});

test('precision-prefix admission never creates an enormous two-axis allocation or caps ordinary working rasters',()=>{
 const make=rect=>{const target={width:128,height:80};registerRegionRenderTarget(target);const view={target,width:128,height:80,viewport:null,sampleCount:4};setRegionProjection(view,rect);return regionSceneView(view,8192,838860);};
 const both=make({x:-4160.5,y:-4184.25,width:8449.5,height:8449.5});assert.equal(both.width,128);assert.equal(both.height,80);
 const tall=make({x:-4160.5,y:-3500.5,width:8449.5,height:7200.25});assert.equal(tall.width,128);assert.equal(tall.height,7201);assert.ok(tall.width*tall.height>838860,'The precision-prefix policy is not a cap on ordinary work');
});
test('scene crop workspaces copy every recording, reuse GPU-ordered capacity, and retire after cancel/queue completion',async()=>{
 let finish;const done=new Promise(resolve=>{finish=resolve}),device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>done}}),store=new SceneOutputCrop(device),owner={},submitted=[],cancelled=[];
 const bind=()=>setPostProcessSubmission(owner,cb=>submitted.push(cb),cb=>cancelled.push(cb));
 const source=device.createTexture({size:[128,80],format:'rgba16float',usage:GPUTextureUsage.COPY_SRC}),rect={x:12,y:8,width:96,height:64};
 bind();const first=store.copy(owner,device.createCommandEncoder(),source,rect,1);bind();const second=store.copy(owner,device.createCommandEncoder(),source,rect,1);
 assert.equal(first,second);assert.equal(store.stats.copies,2);assert.equal(store.stats.copyBytes,96*64*8*2);assert.equal(store.stats.workingBytes,96*64*8);
 assert.equal(store.copy(owner,device.createCommandEncoder(),source,{x:0,y:0,width:128,height:80},1),source);
 assert.throws(()=>store.copy(owner,device.createCommandEncoder(),source,{...rect,x:100},1),/Invalid/);
 const notCopyable=device.createTexture({size:[128,80],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING});assert.throws(()=>store.copy(owner,device.createCommandEncoder(),notCopyable,rect,1),/copyable linear HDR/);notCopyable.destroy();
 store.destroy();assert.equal(first.destroyed,false);cancelled[0]();assert.equal(first.destroyed,false);submitted[1](device.queue);assert.equal(first.destroyed,false);
 finish();await done;await Promise.resolve();assert.equal(first.destroyed,true);assert.equal(store.stats.workingBytes,0);assert.equal(store.stats.retiringBytes,0);
 source.destroy();setPostProcessSubmission(owner);assert.equal(getAuditGpuDeviceState(device).snapshot().resources.texture.live,0);
});


test('regional HDR geometry remains branded independently of display versus scene-radiance output meaning',()=>{
 const display={width:80,height:60},hdr={width:80,height:60};registerRegionRenderTarget(display);registerRegionRenderTarget(hdr,false);assert.equal(isRegionDisplayTarget(display),true);assert.equal(isRegionDisplayTarget(hdr),false);assert.equal(isRegionRenderTarget(hdr),true);assert.equal(isRegionDisplayTarget({}),false);assert.throws(()=>registerRegionRenderTarget(hdr),/immutable/);
 const view=regionSceneView({target:hdr,viewport:{x:0,y:0,width:80,height:60}});assert.equal(getRegionSceneProjection(view).crop.width,80);assert.equal(isRegionDisplayTarget(view.target),false);
});
