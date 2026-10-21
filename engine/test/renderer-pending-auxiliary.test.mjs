import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {World,Entity,Camera3D,CartesianTransform3D,Geometry3D,BasicMaterial,NormalMaterial,getSceneFrameUniformSnapshot,disposeSceneFrameGpuArena} from '../dist/experimental.js';
import {NormalRenderer,OutlineMaskRenderer,PbrRenderer} from '../dist/renderer.js';
import {DirectionalLight} from '../dist/experimental.js';
import {PbrMaterial} from '../dist/material.js';
import {EnvironmentLight} from '../dist/lighting.js';
import {importEngineSource} from './helpers/internal-source.mjs';
const {PbrDirectionalShadowBinding}=await importEngineSource('renderer/PbrDirectionalShadowBinding.ts');
const {ShadowMapRenderer}=await importEngineSource('renderer/ShadowMapRenderer.ts');
const {RecordedGpuResources}=await importEngineSource('renderer/RecordedGpuResources.ts');
const {registerDirectionalShadowView}=await importEngineSource('renderer/DirectionalShadowResources.ts');
const {CurrentDeformationGpuCache}=await importEngineSource('renderer/CurrentDeformationGpuCache.ts');
const {PbrDeformationGpuCache}=await importEngineSource('renderer/PbrDeformationGpuCache.ts');
const tick=async()=>{for(let n=0;n<20;n++)await Promise.resolve();};
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
test('pending queries exclude only the selected recording and still retain every other reader',async()=>{
 const device=createAuditGpuDevice(),owner=new RecordedGpuResources(device),buffer=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM}),a=recording(device),b=recording(device);owner.own(buffer,()=>buffer.destroy());owner.retain(buffer,a);assert.equal(owner.pending(buffer),true);assert.equal(owner.pending(buffer,a),false);owner.retain(buffer,b);assert.equal(owner.pending(buffer,a),true);a.cancel();assert.equal(owner.pending(buffer,b),false);owner.retire(buffer);assert.equal(buffer.destroyed,false);b.cancel();await tick();assert.equal(buffer.destroyed,true);
});
function recording(device){const submitted=[],cancelled=[];let done=false;return{device,afterSubmit:cb=>submitted.push(cb),afterCancel:cb=>cancelled.push(cb),submit(){if(done)return;done=true;for(const cb of submitted)cb(device.queue);},cancel(){if(done)return;done=true;for(const cb of cancelled)cb();}};}
function auditDevice(){const contents=new Map(),device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args:[buffer,offset,data,dataOffset=0,size]})=>{const source=new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength),target=contents.get(buffer)??new Uint8Array(buffer.size);target.set(source.subarray(dataOffset,size===undefined?undefined:dataOffset+size),offset);contents.set(buffer,target);}}});return{device,audit:getAuditGpuDeviceState(device),contents};}
function geometry(){return new Geometry3D({positions:new Float32Array([-1,-1,0,1,-1,0,0,1,0]),skinning:{joints:new Float32Array(12),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),jointMatrices:identity()}});}
function fixture(mode){
 const f=auditDevice(),{device,audit,contents}=f,engine={device,format:'rgba8unorm',width:128,height:96,displayWidth:128,displayHeight:96,getDepthFormat:()=> 'depth24plus'},world=new World(),camera=new Entity().addComponent(new Camera3D()).addComponent(new CartesianTransform3D({position:[0,0,4]}));world.addEntity(camera);
 const renderer=mode==='normal'?new NormalRenderer():mode==='outline'?new OutlineMaskRenderer():new PbrRenderer();renderer.prepare(engine);const geo=geometry(),material=mode==='normal'?new NormalMaterial():mode==='outline'?new BasicMaterial():new PbrMaterial(),environment=new EnvironmentLight(),matrix=identity(),items=[{entityId:1,geometry:geo,material,worldMatrix:matrix,clippingPlanes:null}];let frame=0;
 function capture(n){const context=recording(device);world.frameData.begin(world,engine,++frame*16,16);const data=world.frameData.getCamera3D(camera,camera.getComponent(Camera3D),128,96),snapshot=getSceneFrameUniformSnapshot(data,null);
  if(mode==='normal')material.space=['local','world','view'][n%3];if(mode==='outline'){const m=identity();m[12]=n/300;geo.updateSkinningMatrices(m);}if(mode==='environment'){environment.intensity=n/300;renderer.updateFrame(snapshot,[],environment,null,0,context);}else renderer.beginView(snapshot,context);
  if(mode!=='outline'){renderer.prepareObjects(items);renderer.flushUploads();}const pass=device.createCommandEncoder().beginRenderPass({colorAttachments:[]});if(mode==='outline')renderer.render(pass,1,geo,matrix,{sourceMaterial:material});else renderer.render(pass,1,geo,material,matrix);pass.end();
  const buffer=mode==='normal'?renderer.matCache.get(material.id).paramsBuf:mode==='outline'?renderer.deformationCache.cache.get(geo.id).skinMatrixBuffer:renderer._environmentBuffer;renderer.endView();return{context,buffer,value:mode==='normal'?new Uint32Array(contents.get(buffer).buffer)[0]:new Float32Array(contents.get(buffer).buffer)[mode==='outline'?12:8]};
 }
 async function finish(disposed=false){if(!disposed)renderer.destroy();world.destroy();disposeSceneFrameGpuArena(device);await tick();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);}
 return{...f,renderer,capture,finish};
}
for(const mode of ['normal','outline','environment'])test(`${mode} keeps six pending states and reuses GPU capacity for 300 submitted updates`,async()=>{
 const f=fixture(mode),pending=Array.from({length:6},(_,n)=>f.capture(n));assert.equal(new Set(pending.map(r=>r.buffer)).size,6);
 for(let n=0;n<6;n++){const value=mode==='normal'?new Uint32Array(f.contents.get(pending[n].buffer).buffer)[0]:new Float32Array(f.contents.get(pending[n].buffer).buffer)[mode==='outline'?12:8];assert.ok(Math.abs(value-(mode==='normal'?n%3:n/300))<1e-6);}
 for(const n of [5,2,4,0,3,1])pending[n].context.submit();await tick();const stable=pending[5].buffer,created=f.audit.snapshot().resources.buffer.created;
 for(let n=0;n<300;n++){const r=f.capture(n);assert.equal(r.buffer,stable);r.context.submit();}assert.equal(f.audit.snapshot().resources.buffer.created,created);await f.finish();
});
test('PBR shadow sampling uniforms snapshot pending matrices and keep steady submitted capacity',async()=>{
 const f=auditDevice(),view={},sampler={},binding=new PbrDirectionalShadowBinding(f.device,view,sampler),pending=[];
 function capture(n){const matrix=identity();matrix[12]=n;binding.update([{enabled:true,view,sampler,lightViewProjection:matrix,mapSize:512,bias:.001,normalBias:.02}]);const context=recording(f.device);binding.retain(context);return{context,buffer:binding.buffer};}
 for(let n=0;n<6;n++)pending.push(capture(n));assert.equal(new Set(pending.map(r=>r.buffer)).size,6);for(let n=0;n<6;n++)assert.equal(new Float32Array(f.contents.get(pending[n].buffer).buffer)[12],n);
 for(const r of pending)r.context.submit();await tick();const stable=binding.buffer,created=f.audit.snapshot().resources.buffer.created;for(let n=0;n<300;n++){const r=capture(n);assert.equal(r.buffer,stable);r.context.submit();}assert.equal(f.audit.snapshot().resources.buffer.created,created);binding.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
test('a cached PBR shadow reader pins atlas storage even without a shadow-map producer in that context',async()=>{
 const f=auditDevice(),owner=new RecordedGpuResources(f.device),texture=f.device.createTexture({size:[4,4],format:'depth32float',usage:GPUTextureUsage.TEXTURE_BINDING}),view=texture.createView(),sampler=f.device.createSampler(),binding=new PbrDirectionalShadowBinding(f.device,view,sampler),context=recording(f.device);owner.own(texture,()=>texture.destroy());registerDirectionalShadowView(view,texture,owner);
 binding.update([{enabled:true,view,sampler,lightViewProjection:identity(),mapSize:4,bias:0,normalBias:0}]);binding.retain(context);owner.retire(texture);binding.destroy();assert.equal(texture.destroyed,false);context.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);assert.equal(f.audit.snapshot().resources.texture.live,0);
});
test('shadow dependencies allow another context in the same encoder, distinguish other encoders and reject cancelled history',async()=>{
 const f=auditDevice(),engine={device:f.device,format:'rgba8unorm',getDepthFormat:()=> 'depth24plus'},renderer=new ShadowMapRenderer();renderer.prepare(engine);const encoder=f.device.createCommandEncoder(),a={...recording(f.device),encoder},same={...recording(f.device),encoder},other={...recording(f.device),encoder:f.device.createCommandEncoder()},sun=new DirectionalLight({direction:[-.5,-.4,-1],shadow:{mapSize:64}});
 renderer.render(encoder,[],sun,a);assert.equal(renderer.hasPendingTargetRecords(same),false);assert.equal(renderer.hasPendingTargetWrites(same),false);assert.equal(renderer.hasPendingTargetRecords(other),true);assert.equal(renderer.hasPendingTargetWrites(other),true);a.cancel();assert.equal(renderer.hasPendingTargetRecords(other),false);assert.equal(renderer.hasPendingTargetWrites(other),true);renderer.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);assert.equal(f.audit.snapshot().resources.texture.live,0);
});
for(const pbr of [false,true])test(`${pbr?'normal':'outline'} morph replacement preserves old recorded buffers until cancellation`,async()=>{
 const f=auditDevice(),layout=f.device.createBindGroupLayout({entries:[]}),group=()=>f.device.createBindGroup({layout,entries:[]}),cache=pbr?new PbrDeformationGpuCache({device:f.device,getSceneBindingRevision:()=>0,getFallbackSceneBindGroup:group,createSceneBindGroup:group}):new CurrentDeformationGpuCache(f.device,layout,'pending-outline'),geo=geometry(),pending=[];
 for(let n=0;n<6;n++){geo.setMorphTargets([{positions:new Float32Array([n,0,0,n,0,0,n,0,0])}],[1]);const context=recording(f.device),data=cache.ensure(geo,context);pending.push({context,buffer:data.morphBuffers[0]});}
 assert.equal(new Set(pending.map(r=>r.buffer)).size,6);cache.destroy();for(const r of pending)assert.equal(r.buffer.destroyed,false);for(const r of pending)r.context.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});
test('disposing normal/outline/PBR before submission preserves held resources until cancellation',async()=>{
 for(const mode of ['normal','outline','environment']){const f=fixture(mode),a=f.capture(1),b=f.capture(2);f.renderer.destroy();assert.equal(a.buffer.destroyed,false);assert.equal(b.buffer.destroyed,false);a.context.cancel();b.context.cancel();await f.finish(true);}
});
