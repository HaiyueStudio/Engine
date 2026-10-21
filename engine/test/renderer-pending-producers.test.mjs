import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {Mesh3DRenderer,World,Entity,Camera3D,CartesianTransform3D,Geometry3D,BasicMaterial,ColorLinear,getSceneFrameUniformSnapshot,disposeSceneFrameGpuArena} from '../dist/experimental.js';
import {PbrMaterial} from '../dist/material.js';
import {PbrRenderer} from '../dist/renderer.js';
import {importEngineSource} from './helpers/internal-source.mjs';
const {SharedGeometry3DGPUCache}=await importEngineSource('renderer/SharedGeometry3DGPUCache.ts');
const {PbrDeformationGpuCache}=await importEngineSource('renderer/PbrDeformationGpuCache.ts');
const tick=async()=>{for(let n=0;n<16;n++)await Promise.resolve();};
function recording(device){const submitted=[],cancelled=[];let done=false;return{device,afterSubmit:cb=>submitted.push(cb),afterCancel:cb=>cancelled.push(cb),submit(){if(done)return;done=true;for(const cb of submitted)cb(device.queue);},cancel(){if(done)return;done=true;for(const cb of cancelled)cb();}};}
const identity=()=>new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function geometry(){return new Geometry3D({positions:new Float32Array([-1,-1,0,1,-1,0,0,1,0]),skinning:{joints:new Float32Array(12),weights:new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),jointMatrices:identity()}});}
function rendererFixture(pbr){
 const contents=new Map(),device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args:[buffer,offset,data,dataOffset=0,size]})=>{const source=new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength),target=contents.get(buffer)??new Uint8Array(buffer.size);target.set(source.subarray(dataOffset,size===undefined?undefined:dataOffset+size),offset);contents.set(buffer,target);}}}),audit=getAuditGpuDeviceState(device),engine={device,format:'rgba8unorm',width:128,height:96,displayWidth:128,displayHeight:96,getDepthFormat:()=> 'depth24plus'},world=new World(),camera=new Entity().addComponent(new Camera3D()).addComponent(new CartesianTransform3D({position:[0,0,4]}));world.addEntity(camera);
 const renderer=pbr?new PbrRenderer():new Mesh3DRenderer();renderer.prepare(engine);const geo=geometry(),material=pbr?new PbrMaterial():new BasicMaterial(),matrix=identity(),items=[{entityId:1,geometry:geo,material,worldMatrix:matrix,clippingPlanes:null}];let frame=0;
 function capture(n){const context=recording(device);if(pbr)material.emissiveFactor=[n/300,.2,.3];else{const m=identity();m[12]=n/300;geo.updateSkinningMatrices(m);}world.frameData.begin(world,engine,++frame*16,16);const cameraData=world.frameData.getCamera3D(camera,camera.getComponent(Camera3D),128,96),snapshot=getSceneFrameUniformSnapshot(cameraData,null);if(pbr)renderer.beginView(snapshot,context);else renderer.updateCamera(snapshot,0,context);renderer.prepareObjects(items);renderer.flushUploads();const pass=device.createCommandEncoder().beginRenderPass({colorAttachments:[]});renderer.render(pass,1,geo,material,matrix);pass.end();const stored=pbr?renderer._materials.get(material.id):renderer.geoCache.get(geo.id);renderer.endView();return{context,buffer:pbr?stored.buffer:stored.skinMatrixBuf};}
 async function destroy(){renderer.destroy();world.destroy();disposeSceneFrameGpuArena(device);await tick();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);}
 return{device,audit,renderer,geo,material,capture,destroy,values:b=>new Float32Array(contents.get(b).buffer)};
}

for(const pbr of [false,true])test(`${pbr?'PBR material':'Basic skin'} snapshots survive pending updates and 300 submitted changes reuse capacity`,async()=>{
 const f=rendererFixture(pbr),pending=Array.from({length:6},(_,n)=>f.capture(n));assert.equal(new Set(pending.map(r=>r.buffer)).size,6);
 for(let n=0;n<6;n++)assert.ok(Math.abs(f.values(pending[n].buffer)[pbr?4:12]-n/300)<1e-6);
 for(const n of [5,2,4,0,3,1])pending[n].context.submit();await tick();const stable=pending[5].buffer,created=f.audit.snapshot().resources.buffer.created;
 for(let n=0;n<300;n++){const r=f.capture(n);assert.equal(r.buffer,stable);r.context.submit();}assert.equal(f.audit.snapshot().resources.buffer.created,created);await f.destroy();
});

test('shared geometry replacement preserves every pending version until cancel or submitted queue completion',async()=>{
 const fences=[],device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>new Promise(resolve=>fences.push(resolve))}}),audit=getAuditGpuDeviceState(device),cache=new SharedGeometry3DGPUCache(device),geo=geometry(),owner={},a=recording(device),b=recording(device);
 const old=cache.ensure(geo,owner,a).positionBuf;geo.positions[0]=-.5;geo.markDirty();const next=cache.ensure(geo,owner,b).positionBuf;assert.notEqual(old,next);assert.equal(old.destroyed,false);cache.releaseOwner(owner);assert.equal(next.destroyed,false);
 a.cancel();assert.equal(old.destroyed,true);b.submit();assert.equal(next.destroyed,false);for(const finish of fences)finish();await tick();assert.equal(audit.snapshot().resources.buffer.live,0);
});

test('PBR deformation retains old skin and replacement arrays, reuses submitted storage and releases on cancellation',async()=>{
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),layout=device.createBindGroupLayout({entries:[]}),cache=new PbrDeformationGpuCache({device,getSceneBindingRevision:()=>0,getFallbackSceneBindGroup:()=>device.createBindGroup({layout,entries:[]}),createSceneBindGroup:(matrix,joints,weights)=>device.createBindGroup({layout,entries:[matrix,joints,weights].map((buffer,binding)=>({binding,resource:{buffer}}))})}),geo=geometry(),pending=[];
 for(let n=0;n<6;n++){const m=identity();m[12]=n;geo.updateSkinningMatrices(m);const context=recording(device),data=cache.ensure(geo,context);pending.push({context,data});}
 assert.equal(new Set(pending.map(r=>r.data.skinMatrixBuffer)).size,6);for(const row of pending)assert.equal(row.data.skinMatrixBuffer.destroyed,false);
 for(const row of pending)row.context.submit();await tick();const current=pending[5].data,created=audit.snapshot().resources.buffer.created;
 for(let n=0;n<300;n++){const m=identity();m[12]=n;geo.updateSkinningMatrices(m);const context=recording(device);assert.equal(cache.ensure(geo,context),current);context.submit();}assert.equal(audit.snapshot().resources.buffer.created,created);
 const cancelled=recording(device);cache.ensure(geo,cancelled);const m=identity();m[12]=999;geo.updateSkinningMatrices(m);const held=recording(device),replacement=cache.ensure(geo,held);assert.notEqual(replacement,current);cache.destroy();assert.equal(current.skinMatrixBuffer.destroyed,false);cancelled.cancel();held.cancel();await tick();assert.equal(audit.snapshot().resources.buffer.live,0);
});

test('renderer disposal keeps pending PBR and Basic resources alive through cancellation',async()=>{
 for(const pbr of [false,true]){const f=rendererFixture(pbr),a=f.capture(1),b=f.capture(2);f.renderer.destroy();assert.equal(a.buffer.destroyed,false);assert.equal(b.buffer.destroyed,false);a.context.cancel();b.context.cancel();await f.destroy();}
});
