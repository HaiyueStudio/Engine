import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { planDeferredTiles, DeferredTileResources } = await importEngineSource('renderer/DeferredTileResources.ts');
const limits = { maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupStorageSize: 16384,
  maxStorageBuffersPerShaderStage: 8, maxComputeWorkgroupsPerDimension: 65535 };
const gpu = overrides => createAuditGpuDevice({ limits: { ...limits, ...overrides } });
function context(device) { const callbacks=[]; return { device, encoder:device.createCommandEncoder(), afterSubmit:cb=>callbacks.push(cb),
  async submit(){ device.queue.submit([this.encoder.finish()]); for(const cb of callbacks.splice(0))cb(device.queue); await device.queue.onSubmittedWorkDone(); } }; }

test('fixed 16x16 records account for actual memory, partial edges and diagnostic exhaustion',()=>{
  const device=gpu();
  const full=planDeferredTiles(device,1280,720);
  assert.equal(full.tileCount,3600);assert.equal(full.byteSize,3600*528);assert.equal(full.fullListTiles,0);
  assert.equal(full.viewBytes,28*1280*720+3600*528+4096+32);
  assert.equal(planDeferredTiles(device,17,33).tileCount,6);
  const small=planDeferredTiles(device,17,33,{tileCapacity:1,maxTileRecords:2});
  assert.equal(small.byteSize,1056);assert.equal(small.fullListTiles,4);
  assert.equal(planDeferredTiles(device,16,16,{maxTileRecords:0}).byteSize,4);
  assert.ok(planDeferredTiles(device,1920,1080).viewBytes<64*1024*1024);
  for(const tileCapacity of [-1,129,NaN,1.5])assert.throws(()=>planDeferredTiles(device,16,16,{tileCapacity}));
  assert.throws(()=>planDeferredTiles(device,4096,4096),{reason:'view-deferred-bytes'});
  assert.throws(()=>planDeferredTiles(gpu({maxStorageBufferBindingSize:512}),16,16),{reason:'tile-buffer-bytes'});
  assert.throws(()=>planDeferredTiles(gpu({maxComputeWorkgroupsPerDimension:1}),32,16),{reason:'tile-dispatch'});
  for(const key of Object.keys(limits))assert.throws(()=>planDeferredTiles(gpu({[key]:0}),16,16));
});

test('views have isolated buffers, stable frames reuse, retirement waits for every encoder',async()=>{
  const device=gpu(),owner=new DeferredTileResources(device),plan=planDeferredTiles(device,32,32);
  const older=context(device),newer=context(device);
  const a=owner.acquire('a',plan,older),b=owner.acquire('b',plan,older);
  assert.notEqual(a.buffer,b.buffer);
  assert.equal(owner.acquire('a',plan,newer).buffer,a.buffer);
  await newer.submit(); owner.releaseView('a');assert.equal(a.buffer.destroyed,false);
  await older.submit();assert.equal(a.buffer.destroyed,true);assert.equal(b.buffer.destroyed,false);
  owner.destroy();assert.equal(b.buffer.destroyed,true);assert.equal(owner.stats.liveBuffers,0);
});

test('resize keeps two generations at most and protects out-of-order pending submissions',async()=>{
  const device=gpu(),owner=new DeferredTileResources(device),older=context(device),newer=context(device);
  const first=owner.acquire('a',planDeferredTiles(device,16,16),older);
  const second=owner.acquire('a',planDeferredTiles(device,32,32),newer);
  assert.notEqual(first.buffer,second.buffer);assert.equal(second.buffer.size,4*528);
  assert.throws(()=>owner.acquire('a',planDeferredTiles(device,64,64),newer),{reason:'tile-live-generations'});
  await newer.submit(); assert.equal(first.buffer.destroyed,false);
  await older.submit();assert.equal(first.buffer.destroyed,true);
  const final=context(device);owner.acquire('a',planDeferredTiles(device,64,64),final);
  owner.destroy();assert.equal(owner.stats.liveBuffers,1);await final.submit();assert.equal(owner.stats.liveBuffers,0);
});

test('pending retired scopes remain bounded; device loss abandons all generations',()=>{
  const device=gpu(),owner=new DeferredTileResources(device),ctx=context(device),plan=planDeferredTiles(device,16,16);
  for(let i=0;i<4;i++){owner.acquire(String(i),plan,ctx);owner.releaseView(String(i));}
  assert.throws(()=>owner.acquire('fifth',plan,ctx),{reason:'tile-view-count'});
  assert.throws(()=>owner.acquire('0',plan,{...ctx,device:gpu()}),/generation/);
  assert.throws(()=>owner.acquire('0',plan,{device,encoder:ctx.encoder}),/afterSubmit/);
  owner.destroy(true);assert.equal(owner.stats.liveBuffers,0);
  assert.throws(()=>owner.acquire('0',plan,ctx),/destroyed/);
});

test('full-list selection requires every light to enclose the entire near quad, not only the camera',async()=>{
  const {deferredTileBypassReason}=await importEngineSource('renderer/DeferredTileSelection.ts');
  const {DeferredLightTable,createDeferredReferenceView}=await importEngineSource('frame/DeferredLightTable.ts');
  const table=new DeferredLightTable(),frame={data:new Float32Array(68)};
  for(let i=0;i<4;i++)frame.data[32+i*5]=1;
  const light=(id,position,range)=>({id,shadow:null,info:{type:2,color:[1,1,1],intensity:1,position,range,direction:[0,-1,0]}});
  const check=candidates=>{const source=table.update(candidates,[]);return deferredTileBypassReason(source,createDeferredReferenceView(source),frame,false);};
  assert.equal(check([]),'empty-source');
  assert.equal(check([light(1,[0,0,0],2)]),'all-lights-cover-near-plane');
  assert.equal(check([light(1,[0,0,0],.5)]),null,'center containment alone is not sufficient');
  assert.equal(check([light(1,[0,0,0],2),light(2,[0,0,0],.5)]),null);
  assert.equal(check([light(1,[0,0,0],Math.sqrt(2))]),null,'tangent numerical boundary keeps GPU culling');
  frame.data[35]=NaN;assert.equal(check([light(1,[0,0,0],2)]),null);
});
