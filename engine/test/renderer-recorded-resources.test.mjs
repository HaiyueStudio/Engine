import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {RendererObjectTable} from '../dist/renderer.js';
import {Mesh3DRenderer,World,Entity,Camera3D,CartesianTransform3D,Geometry3D,BasicMaterial,ColorLinear,getSceneFrameUniformSnapshot,disposeSceneFrameGpuArena} from '../dist/experimental.js';
import {importEngineSource} from './helpers/internal-source.mjs';
const {RecordedGpuResources}=await importEngineSource('renderer/RecordedGpuResources.ts');
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
function recording(device){const submitted=[],cancelled=[];let done=false;return{device,afterSubmit:cb=>submitted.push(cb),afterCancel:cb=>cancelled.push(cb),submit(){if(done)return;done=true;for(const cb of submitted)cb(device.queue);},cancel(){if(done)return;done=true;for(const cb of cancelled)cb();}};}
function tableFixture(auxiliary=false){
 const contents=new Map(),device=createAuditGpuDevice({behaviors:{'queue.writeBuffer':({args:[buffer,offset,data,dataOffset=0,size]})=>{const source=new Uint8Array(data.buffer??data,data.byteOffset??0,data.byteLength),target=contents.get(buffer)??new Uint8Array(buffer.size);target.set(source.subarray(dataOffset,size===undefined?undefined:dataOffset+size),offset);contents.set(buffer,target);}}}),audit=getAuditGpuDeviceState(device),layout=device.createBindGroupLayout({entries:[]}),table=new RendererObjectTable({device,bindGroupLayout:layout,label:'recorded-object-test',floatsPerSlot:4,...auxiliary?{auxiliary:{binding:1,floatsPerSlot:4}}:{}});
 return{device,audit,table,values:buffer=>Array.from(new Float32Array(contents.get(buffer).buffer))};
}

test('sparse pending table versions preserve both changed slots and the untouched recorded values',async()=>{
 const f=tableFixture(),a=recording(f.device),b=recording(f.device),c=recording(f.device);f.table.allocateSlot();f.table.allocateSlot();
 f.table.beginUploads(a);f.table.data[0]=1;f.table.data[4]=11;f.table.writeSlot(0);f.table.writeSlot(1);f.table.flushUploads();const first=f.table.buffer;
 f.table.beginUploads(b);f.table.data[4]=22;f.table.writeSlot(1);f.table.flushUploads();const second=f.table.buffer;
 f.table.beginUploads(c);f.table.data[0]=3;f.table.writeSlot(0);f.table.flushUploads();const third=f.table.buffer;
 assert.notEqual(first,second);assert.notEqual(second,third);assert.deepEqual(f.values(first),[1,0,0,0,11,0,0,0]);assert.deepEqual(f.values(second),[1,0,0,0,22,0,0,0]);assert.deepEqual(f.values(third),[3,0,0,0,22,0,0,0]);
 c.submit();a.submit();b.submit();await tick();f.table.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('unchanged pending tables share storage; disposal waits for every recording and the queue fence',async()=>{
 const fences=[],device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>new Promise(resolve=>fences.push(resolve))}}),audit=getAuditGpuDeviceState(device),table=new RendererObjectTable({device,bindGroupLayout:device.createBindGroupLayout({entries:[]}),label:'shared',floatsPerSlot:4}),a=recording(device),b=recording(device);
 table.beginUploads(a);table.data[0]=5;table.writeSlot(0);table.flushUploads();const first=table.buffer;void table.bindGroup;const uploads=audit.getCallCount('queue.writeBuffer');
 table.beginUploads(b);table.writeSlot(0);table.flushUploads();assert.equal(table.buffer,first);void table.bindGroup;assert.equal(audit.getCallCount('queue.writeBuffer'),uploads);
 table.destroy();a.cancel();assert.equal(first.destroyed,false);b.submit();await tick();assert.equal(first.destroyed,false);assert.ok(fences.length>0);for(const finish of fences)finish();await tick();assert.equal(audit.snapshot().resources.buffer.live,0);
});

test('a changed clipping channel replaces its binding without overwriting an older auxiliary snapshot',async()=>{
 const f=tableFixture(true),a=recording(f.device),b=recording(f.device);f.table.allocateSlot();
 f.table.beginUploads(a);f.table.auxiliaryData[0]=1;f.table.writeAuxiliarySlot(0);f.table.flushUploads();const first=f.table.bindGroup,main=first.descriptor.entries[0].resource.buffer,aux=first.descriptor.entries[1].resource.buffer;
 f.table.beginUploads(b);f.table.auxiliaryData[0]=2;f.table.writeAuxiliarySlot(0);f.table.flushUploads();const second=f.table.bindGroup;
 assert.notEqual(first,second);assert.equal(second.descriptor.entries[0].resource.buffer,main);assert.notEqual(second.descriptor.entries[1].resource.buffer,aux);assert.equal(f.values(aux)[0],1);assert.equal(f.values(second.descriptor.entries[1].resource.buffer)[0],2);
 a.submit();b.cancel();f.table.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('cancelled growth releases old and current table versions without requiring a submission callback',async()=>{
 const f=tableFixture(true),a=recording(f.device),b=recording(f.device);f.table.beginUploads(a);const old=f.table.buffer;void f.table.bindGroup;
 f.table.beginUploads(b);f.table.ensureCapacity(32);const current=f.table.buffer;void f.table.bindGroup;f.table.destroy();assert.equal(old.destroyed,false);assert.equal(current.destroyed,false);b.cancel();assert.equal(old.destroyed,false);a.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('300 submitted table updates reuse the same allocation and a second unchanged view does not upload again',async()=>{
 const f=tableFixture();let first;
 for(let n=0;n<300;n++){const a=recording(f.device);f.table.beginUploads(a);f.table.data[0]=n;f.table.writeSlot(0);f.table.flushUploads();first??=f.table.buffer;assert.equal(f.table.buffer,first);void f.table.bindGroup;a.submit();const uploads=f.audit.getCallCount('queue.writeBuffer'),b=recording(f.device);f.table.beginUploads(b);f.table.writeSlot(0);f.table.flushUploads();assert.equal(f.table.buffer,first);void f.table.bindGroup;b.submit();assert.equal(f.audit.getCallCount('queue.writeBuffer'),uploads);}
 assert.equal(f.audit.snapshot().resources.buffer.created,1);f.table.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
});

test('device loss abandons recorded GPU resources and releases an owned asset handle once',async()=>{
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device);let lose;device.lost=new Promise(resolve=>lose=resolve);const owner=new RecordedGpuResources(device),context=recording(device),buffer=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM}),handle={};let releases=0;
 owner.own(buffer,()=>buffer.destroy());owner.own(handle,()=>releases++);owner.retain(buffer,context);owner.retain(handle,context);owner.retireAll();assert.equal(buffer.destroyed,false);lose({reason:'destroyed'});await tick();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(releases,1);context.cancel();owner.retireAll();assert.equal(releases,1);
});

test('Basic material uniforms retain pending colors and reuse submitted capacity for 300 changes',async()=>{
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),engine={device,format:'rgba8unorm',width:128,height:96,displayWidth:128,displayHeight:96,getDepthFormat:()=> 'depth24plus'},world=new World(),camera=new Entity().addComponent(new Camera3D()).addComponent(new CartesianTransform3D({position:[0,0,4]}));world.addEntity(camera);
 const renderer=new Mesh3DRenderer();renderer.prepare(engine);const geometry=new Geometry3D({positions:new Float32Array([-1,-1,0,1,-1,0,0,1,0])}),material=new BasicMaterial(),matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),items=[{entityId:1,geometry,material,worldMatrix:matrix,clippingPlanes:null}];let frame=0;
 function capture(n){const context=recording(device);material.color=new ColorLinear(n/300,.2,.3);world.frameData.begin(world,engine,++frame*16,16);const data=world.frameData.getCamera3D(camera,camera.getComponent(Camera3D),128,96);renderer.updateCamera(getSceneFrameUniformSnapshot(data,null),0,context);renderer.prepareObjects(items);renderer.flushUploads();const pass=device.createCommandEncoder().beginRenderPass({colorAttachments:[]});renderer.render(pass,1,geometry,material,matrix);pass.end();const stored=renderer.matCache.get(material.id);renderer.endView();return{context,buffer:stored.colorBuf};}
 const pending=Array.from({length:6},(_,n)=>capture(n));assert.equal(new Set(pending.map(v=>v.buffer)).size,6);for(const n of [5,2,4,0,3,1])pending[n].context.submit();await tick();const stable=renderer.matCache.get(material.id).colorBuf,created=audit.snapshot().resources.buffer.created;
 for(let n=0;n<300;n++){const record=capture(n);assert.equal(record.buffer,stable);record.context.submit();}assert.equal(audit.snapshot().resources.buffer.created,created);
 renderer.destroy();world.destroy();disposeSceneFrameGpuArena(device);await tick();assert.equal(audit.snapshot().resources.buffer.live,0);assert.equal(audit.snapshot().resources.texture.live,0);
});
