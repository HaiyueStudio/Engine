import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {DeferredAllocationBudget,DeferredSharedAllocationLease,getDeferredAllocationBudget}=await importEngineSource('renderer/DeferredAllocationBudget.ts');
const {deferredAoStorage,planDeferredViewMemory}=await importEngineSource('renderer/DeferredViewMemory.ts');
const {DeferredTileResources,planDeferredTiles}=await importEngineSource('renderer/DeferredTileResources.ts');
const {TransientRenderTargetPool,acquireTransientAttachments,releaseTransientAttachments}=await importEngineSource('rtt/TransientRenderTargetPool.ts');
const {DeferredAmbientOcclusion}=await importEngineSource('renderer/DeferredAmbientOcclusion.ts');
const {registerLightingAmbientOcclusion}=await importEngineSource('postprocess/LightingAmbientOcclusion.ts');
const limits={maxStorageBuffersPerShaderStage:8,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupStorageSize:16384,maxComputeWorkgroupsPerDimension:65535};
function context(device){const callbacks=[];return {device,encoder:device.createCommandEncoder(),callbacks,afterSubmit:cb=>callbacks.push(cb)};}
function input(device){const source={},normal=device.createTexture({size:[1,1],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING}),depth=device.createTexture({size:[1,1],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING});registerLightingAmbientOcclusion(source,{composite:()=>true,create:()=>({prepare(){},setSceneTextures(){},apply(){},destroy(){}}),configure(){}});return {passes:[source],prepare:()=>({normal,depth,frame:{}}),destroy(){normal.destroy();depth.destroy();}};}
test('R16F row packing preserves alignment; joint 1080p plan fits without truncating per-tile capacity',()=>{
 assert.deepEqual(deferredAoStorage(129,3,1),{bytesPerRow:512,bufferBytes:1792,textureBytes:774,bytes:2566});
 assert.equal(deferredAoStorage(1920,1080,1).bytes,8294656);
 const d=createAuditGpuDevice({limits}),m=planDeferredViewMemory(1920,1080,1),p=planDeferredTiles(d,1920,1080,{},m);
 assert.equal(p.tileCapacity,128);assert.equal(p.storedTiles,433);assert.equal(p.memoryLimitedTiles,7727);assert.equal(p.fullListTiles,7727);assert.ok(p.viewBytes<=67108864);
 assert.equal(planDeferredTiles(d,1280,720,{},planDeferredViewMemory(1280,720,1)).memoryLimitedTiles,0);
 assert.throws(()=>planDeferredViewMemory(1920,1080,2),{reason:'view-deferred-bytes'});
});
test('shared budget refuses excess without charging, is per-device, and retains unsubmitted shared allocations',async()=>{
 const d=createAuditGpuDevice({limits});assert.equal(getDeferredAllocationBudget(d),getDeferredAllocationBudget(d));assert.notEqual(getDeferredAllocationBudget(d),getDeferredAllocationBudget(createAuditGpuDevice({limits})));
 const b=new DeferredAllocationBudget(100),release=b.reserve(60);assert.throws(()=>b.reserve(41),{reason:'deferred-target-bytes'});assert.equal(b.bytes,60);release();release();assert.equal(b.bytes,0);
 const lease=new DeferredSharedAllocationLease(b,80),c=context(d),done=[];lease.retain(c);lease.retain(c);lease.destroy();assert.equal(b.bytes,80);assert.equal(c.callbacks.length,1);
 c.callbacks[0]({onSubmittedWorkDone:()=>new Promise(resolve=>done.push(resolve))});assert.equal(b.bytes,80);done[0]();await Promise.resolve();assert.equal(b.bytes,0);
 const abandoned=new DeferredSharedAllocationLease(b,50);abandoned.retain(context(d));abandoned.destroy(true);assert.equal(b.bytes,0);
});
test('AO toggling shrinks tile storage while protecting the old submitted buffer',async()=>{
 const d=createAuditGpuDevice({limits}),budget=new DeferredAllocationBudget(),tiles=new DeferredTileResources(d,budget),a=context(d),b=context(d);
 const before=tiles.acquire('v',planDeferredTiles(d,1920,1080),a),plan=planDeferredTiles(d,1920,1080,{},planDeferredViewMemory(1920,1080,1)),after=tiles.acquire('v',plan,b);
 assert.notEqual(after.buffer,before.buffer);assert.equal(after.buffer.size,plan.byteSize);assert.equal(budget.bytes,before.buffer.size+after.buffer.size);assert.equal(tiles.stats.liveBuffers,2);
 tiles.destroy();assert.equal(budget.bytes,before.buffer.size+after.buffer.size);
 d.queue.submit([a.encoder.finish(),b.encoder.finish()]);for(const c of [a,b])for(const cb of c.callbacks)cb(d.queue);await d.queue.onSubmittedWorkDone();await Promise.resolve();assert.equal(budget.bytes,0);assert.equal(tiles.stats.liveBuffers,0);
});
test('global pending budget is shared by MRT/tile/AO owners, and failed allocation cannot leak a reservation',async()=>{
 const d=createAuditGpuDevice({limits}),budget=new DeferredAllocationBudget(100000),pool=new TransientRenderTargetPool({device:d}),tiles=new DeferredTileResources(d,budget),ao=new DeferredAmbientOcclusion(d,budget),c=context(d),i=input(d);
 try{
  acquireTransientAttachments(pool,'v',32,32,['rgba16float','rgba16float','rgba16float','depth32float'],c,{maxViews:4,maxLiveGenerations:2,reserveBytes:n=>budget.reserve(n)});
  tiles.acquire('v',planDeferredTiles(d,32,32),c);ao.record(c,'v',32,32,i);const held=budget.bytes;assert.ok(held>0);
  const calls=getAuditGpuDeviceState(d).calls.length;
  assert.throws(()=>acquireTransientAttachments(pool,'v2',128,128,['rgba16float'],c,{maxViews:4,maxLiveGenerations:2,reserveBytes:n=>budget.reserve(n)}),{reason:'deferred-target-bytes'});
  assert.equal(budget.bytes,held);assert.equal(getAuditGpuDeviceState(d).calls.length,calls);
  pool.destroy();tiles.destroy();ao.destroy();assert.ok(budget.bytes>0);
  d.queue.submit([c.encoder.finish()]);for(const cb of c.callbacks)cb(d.queue);await d.queue.onSubmittedWorkDone();await Promise.resolve();assert.equal(budget.bytes,0);
 }finally{releaseTransientAttachments(pool,true);tiles.destroy(true);ao.destroy(true);i.destroy();}
});
test('AO bounds same-view pending slots and releases failed preparation charges',()=>{
 const d=createAuditGpuDevice({limits}),budget=new DeferredAllocationBudget(),ao=new DeferredAmbientOcclusion(d,budget),i=input(d);
 try{
  ao.record(context(d),'v',17,9,i);ao.record(context(d),'v',17,9,i);const before=budget.bytes;
  assert.throws(()=>ao.record(context(d),'v',17,9,i),{reason:'ao-live-generations'});assert.equal(budget.bytes,before);
  const bad={};registerLightingAmbientOcclusion(bad,{composite:()=>true,create:()=>({prepare(){throw Error('prepare failed');},destroy(){}}),configure(){}});
  assert.throws(()=>ao.record(context(d),'other',17,9,{...i,passes:[bad]}),/prepare failed/);assert.equal(budget.bytes,before);
 }finally{ao.destroy(true);i.destroy();}assert.equal(budget.bytes,0);
});
