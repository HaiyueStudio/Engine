import test from 'node:test';
import assert from 'node:assert/strict';
import {mat4} from 'wgpu-matrix';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {regionSceneView,writeRegionRasterProjection,getRegionSceneProjection}=await importEngineSource('core/RegionSceneProjection.ts');
const {registerRegionRenderTarget,setRegionProjection}=await importEngineSource('core/RegionRenderTarget.ts');
const {RegionSceneFrameBinding}=await importEngineSource('renderer/regions/RegionSceneFrameBinding.ts');
const {SCENE_FRAME_UNIFORM_FLOATS}=await importEngineSource('frame/SceneFrameUniformLayout.ts');
const {getSceneFrameGpuArena,disposeSceneFrameGpuArena}=await importEngineSource('renderer/SceneFrameGpuArena.ts');
const {Render3DPostSceneFrameContext}=await importEngineSource('systems/Render3DPostSceneFrameContext.ts');
const {Render3DPostScenePasses}=await importEngineSource('systems/Render3DPostScenePasses.ts');
const {RenderView}=await importEngineSource('core/RenderView.ts');
const {RenderFrameContext}=await importEngineSource('core/RenderCommandContext.ts');
const {RttEngine}=await importEngineSource('rtt/RttEngine.ts');
const {Entity}=await importEngineSource('ecs/Entity.ts');
const {Camera3D}=await importEngineSource('components/Camera3D.ts');
const {PostProcessPass}=await importEngineSource('postprocess/PostProcessPass.ts');
const {TaaPass}=await importEngineSource('postprocess/TaaPass.ts');
const identity=()=>mat4.identity(),multiply=(m,p)=>Array.from({length:4},(_,r)=>p.reduce((n,v,c)=>n+v*m[c*4+r],0));
function regional(target={width:161,height:101}){registerRegionRenderTarget(target);const view={target,key:'region',viewport:{x:0,y:0,width:80,height:65},sampleCount:4};setRegionProjection(view,{x:-20.25,y:-9.5,width:99.5,height:74.25});return regionSceneView(view);}
function snapshot(){const data=new Float32Array(SCENE_FRAME_UNIFORM_FLOATS);data.set(identity());data.set(identity(),16);data.set(identity(),32);data.set([99.5,74.25,1/99.5,1/74.25],52);return{frameId:1,phaseRevision:1,cameraEntityId:1,data};}

for(const type of ['perspective','orthographic'])test(`regional ${type} raster matrices map pixels without modifying the camera projection`,()=>{
 const view=regional(),v=getRegionSceneProjection(view).viewport,p=type==='perspective'?mat4.perspective(Math.PI/3,99.5/74.25,.1,100):mat4.ortho(-2,2,-1,1,.1,100),original=[...p],out=new Float32Array(16);writeRegionRasterProjection(out,p,view);
 for(const point of [[0,0,-3,1],[.25,-.2,-2,1],[-.4,.3,-4,1]]){const a=multiply(p,point),b=multiply(out,point);const expected=[v.x+(a[0]/a[3]+1)*v.width/2,v.y+(1-a[1]/a[3])*v.height/2],actual=[(b[0]/b[3]+1)*view.width/2,(1-b[1]/b[3])*view.height/2];actual.forEach((n,i)=>assert.ok(Math.abs(n-expected[i])<.0001));}
 assert.deepEqual([...p],original);assert.deepEqual([...writeRegionRasterProjection(out,p,undefined)],original);
});

test('regional derived frame streams stay stable, preserve geometry matrices, and release only after cancellation',()=>{
 const device=createAuditGpuDevice(),arena=getSceneFrameGpuArena(device),entry=new RegionSceneFrameBinding(device),view=regional(),source=snapshot(),cancel=[],context={device,afterSubmit(){},afterCancel:cb=>cancel.push(cb)};
 const geometry=entry.update(source,view,'geometry',context);assert.deepEqual([...geometry.data.slice(0,16)],[...identity()]);assert.deepEqual([...geometry.data.slice(52,56)],[101,75,Math.fround(1/101),Math.fround(1/75)]);assert.equal(source.data[52],99.5);
 entry.binding.upload(geometry,context);const writes=getAuditGpuDeviceState(device).getCallCount('queue.writeBuffer');entry.binding.upload(entry.update(source,view,'geometry',context),context);assert.equal(getAuditGpuDeviceState(device).getCallCount('queue.writeBuffer'),writes);
 for(let frame=2;frame<102;frame++){source.frameId=frame;entry.binding.upload(entry.update(source,view,'raster',context),context);}
 assert.equal(arena.getStats().viewCount,1);const vp=entry.snapshot.data.slice(0,16),inv=entry.snapshot.data.slice(32,48),product=mat4.multiply(vp,inv);product.forEach((n,i)=>assert.ok(Math.abs(n-identity()[i])<1e-5));
 entry.destroy();assert.equal(arena.getStats().viewCount,1);cancel.forEach(cb=>cb());assert.equal(arena.getStats().viewCount,0);disposeSceneFrameGpuArena(device);
});

test('post-effect frame matrices use raster coordinates while source camera matrices remain intact',()=>{
 const view=regional(),p=mat4.perspective(Math.PI/3,99.5/74.25,.1,100),cameraFrame={projectionMatrix:p,viewProjectionMatrix:p,inverseViewProjectionMatrix:mat4.inverse(p),projectionJitter:new Float32Array([.25,-.3]),reverseZ:false,frameId:4};
 const frame=new Render3DPostSceneFrameContext().update({frameView:view,camera:{near:.1,far:100,projectionType:'perspective'},cameraEntityId:1,cameraFrame});
 const wanted=writeRegionRasterProjection(new Float32Array(16),p,view);assert.deepEqual([...frame.projectionMatrix],[...wanted]);assert.deepEqual([...frame.viewProjectionMatrix],[...wanted]);assert.equal(frame.width,101);assert.equal(frame.height,75);
 mat4.multiply(frame.viewProjectionMatrix,frame.inverseViewProjectionMatrix).forEach((n,i)=>assert.ok(Math.abs(n-identity()[i])<1e-5));assert.notEqual(frame.projectionMatrix,cameraFrame.projectionMatrix);
});

function setup(t){
 const viewports=[],device=createAuditGpuDevice({behaviors:{'renderPass.setViewport':({resource,args})=>viewports.push({label:resource.descriptor?.label,args})}}),engine={device,width:161,height:101,format:'rgba8unorm',clearColor:{r:0,g:0,b:0,a:0},getDepthFormat:()=> 'depth24plus'},target=new RttEngine(engine,161,101),camera=new Camera3D(),ownerView=new RenderView({key:'region',camera:new Entity('camera'),target,sampleCount:4}),view=regional(target),frameView=Object.freeze({...ownerView.snapshot(),...view});
 // Preserve the private projection on this exact snapshot rather than copying a WeakMap identity.
 setRegionProjection(frameView,{x:-20.25,y:-9.5,width:99.5,height:74.25});const normalized=regionSceneView(frameView),context=new RenderFrameContext(engine,{view:normalized}),post=new Render3DPostScenePasses(engine);
 t.after(async()=>{context.cancel();post.destroy();target.destroy();await device.queue.onSubmittedWorkDone();await Promise.resolve();disposeSceneFrameGpuArena(device)});
 return{view:normalized,context,post,camera,viewports};
}
class Probe extends PostProcessPass {label='aux probe';constructor(flags){super();Object.assign(this,flags)}prepare(){}apply(){}}
for(const [name,flags,labels]of [
 ['depth',{needsDepthTexture:true},['postDepthPass']],['normal',{needsNormalTexture:true},['postNormalPass']],['motion',{needsMotionTexture:true},['postMotionVectorPass']],['outline',{needsOutlineMask:true},['postOutlineMaskPass','postOutlineVisibleMaskPass']],
])test(`regional ${name} auxiliary surfaces share the original fractional hardware viewport`,t=>{
 const f=setup(t),requirements=f.post.prepare([new Probe(flags)],f.context,false),live=Object.fromEntries(['depthEntities','depthGeometries','depthMaterials','normalEntities','normalGeometries','normalMaterials','outlineEntities','outlineGeometries','motionGeometries'].map(k=>[k,new Set()]));
 f.post.renderAuxiliaryBuffers({encoder:f.context.encoder,items:[],motionItems:[],outlineItems:[],sceneFrameUniforms:snapshot(),camera:f.camera,reverseZ:false,sampleCount:4,viewKey:f.view.key,frameId:1,cameraId:1,motionHistoryRevision:0,projectionJitter:[0,0],context:f.context,requirements,live});
 for(const label of labels){const calls=f.viewports.filter(c=>c.label==='Render3DSystem.'+label);assert.equal(calls.length,1,label);assert.deepEqual(calls[0].args,[.75,.5,99.5,74.25,0,1]);}
 if(name==='motion'){const state=f.post._motionVectorRenderer._views.get(f.view.key);assert.equal(state.valid,true);f.context.cancel();assert.equal(state.valid,false);}
});

test('a cancelled managed TAA record immediately invalidates history and can be destroyed without registering submission on a dead frame',t=>{
 const f=setup(t),taa=new TaaPass(),requirements=f.post.prepare([taa],f.context,false),frame={frameId:1,viewKey:f.view.key,width:101,height:75,cameraId:1,reverseZ:false,near:.1,far:100,isOrthographic:true,projectionJitter:new Float32Array(2),projectionMatrix:identity(),viewProjectionMatrix:identity(),inverseViewProjectionMatrix:identity()};
 f.post.runPostProcess(f.context.encoder,[taa],f.view.target.getOutputView(),requirements,frame);assert.equal(taa.stats.validHistoryCount,1);f.context.cancel();assert.equal(taa.stats.validHistoryCount,0);assert.equal(f.post._postRenderer._afterSubmit,undefined);assert.doesNotThrow(()=>f.post.destroy());
});


test('real frame cancellation never reopens its encoder while retiring Deferred and scratch resources',async()=>{
 const {TransientTextureAllocator}=await importEngineSource('rtt/TransientTextureAllocator.ts');
 const {acquireSequentialAttachments,releaseSequentialAttachments,getSequentialAttachmentAllocator}=await importEngineSource('rtt/TransientAttachmentSequence.ts');
 const {TransientRenderTargetPool,acquireTransientAttachments,releaseTransientAttachments}=await importEngineSource('rtt/TransientRenderTargetPool.ts');
 const {DeferredAllocationBudget,DeferredSharedAllocationLease}=await importEngineSource('renderer/DeferredAllocationBudget.ts');
 const {DeferredImmutableBufferArena}=await importEngineSource('renderer/DeferredLightGpuTable.ts');
 const {DeferredTileResources,planDeferredTiles}=await importEngineSource('renderer/DeferredTileResources.ts');
 const {DeferredAmbientOcclusion}=await importEngineSource('renderer/DeferredAmbientOcclusion.ts');
 const device=createAuditGpuDevice({limits:{maxComputeInvocationsPerWorkgroup:64,maxComputeWorkgroupSizeX:64,maxComputeWorkgroupStorageSize:260,maxStorageBuffersPerShaderStage:3,maxComputeWorkgroupsPerDimension:65535}}),engine={device,width:32,height:16,format:'rgba8unorm',getRenderPassDescriptor:()=>({colorAttachments:[]})},context=new RenderFrameContext(engine),pool=new TransientTextureAllocator(device),owner={},legacy=new TransientRenderTargetPool(engine),budget=new DeferredAllocationBudget(),lease=new DeferredSharedAllocationLease(budget,100),arena=new DeferredImmutableBufferArena(device,'cancel-test',16,GPUBufferUsage.UNIFORM),tiles=new DeferredTileResources(device,budget),ao=new DeferredAmbientOcclusion(device,budget);
 const scratch=pool.acquire([{name:'scratch',firstUse:0,lastUse:1,descriptor:{size:[32,16],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT}}],context);scratch.release();
 acquireSequentialAttachments(owner,'view',32,16,['rgba16float'],context,{firstUse:0,lastUse:1},false,()=>()=>{});
 acquireTransientAttachments(legacy,'view',32,16,['rgba16float'],context);lease.retain(context);const binding=arena.acquire({},new Uint8Array(16),context);tiles.acquire('view',planDeferredTiles(device,32,16),context);ao.record(context,'view',32,16);
 pool.destroy();releaseSequentialAttachments(owner);releaseTransientAttachments(legacy);lease.destroy();arena.destroy();tiles.destroy();ao.destroy();assert.doesNotThrow(()=>context.cancel());assert.equal(pool.stats.physicalBytes,0);assert.equal(getSequentialAttachmentAllocator(owner).stats.physicalBytes,0);assert.equal(binding.buffer.destroyed,true);assert.equal(budget.bytes,0);assert.throws(()=>context.encoder,/cancelled/);
});

test('outline mask pipelines distinguish actual attachment formats across views',async()=>{
 const {OutlineMaskRenderer}=await importEngineSource('renderer/OutlineMaskRenderer.ts');const device=createAuditGpuDevice(),renderer=new OutlineMaskRenderer();renderer.prepare({device,format:'rgba8unorm',getDepthFormat:()=> 'depth24plus'});
 const geometry={topology:'triangle-list',doubleSided:false};renderer.colorFormat='rgba16float';const hdr=renderer._getPipeline(geometry,true);renderer.colorFormat='rgba8unorm';const display=renderer._getPipeline(geometry,true);assert.notEqual(hdr,display);assert.equal(hdr.descriptor.fragment.targets[0].format,'rgba16float');assert.equal(display.descriptor.fragment.targets[0].format,'rgba8unorm');renderer.colorFormat='rgba16float';assert.equal(renderer._getPipeline(geometry,true).descriptor.fragment.targets[0].format,'rgba16float');renderer.destroy();disposeSceneFrameGpuArena(device);
});
