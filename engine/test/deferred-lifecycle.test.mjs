import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditGpuDevice, getAuditGpuDeviceState } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { DeferredReferenceBackend } = await importEngineSource('renderer/DeferredReferenceBackend.ts');
const { PbrRenderer } = await importEngineSource('renderer/PbrRenderer.ts');
const { disposeSceneFrameGpuArena } = await importEngineSource('renderer/SceneFrameGpuArena.ts');
const { validateDeferredDevice, validateDeferredViewConfiguration } = await importEngineSource('renderer/DeferredLightingCapabilities.ts');
const { TransientRenderTargetPool, acquireTransientAttachments, releaseTransientAttachments } = await importEngineSource('rtt/TransientRenderTargetPool.ts');
const { createDeferredReferenceProfile } = await importEngineSource('experimental/DeferredReferenceProfile.ts');
const { getDeferredLightingBackend, removeDeferredLightingBackend, installDeferredLightingBackend } = await importEngineSource('renderer/DeferredLightingBackendPort.ts');
const { Render3DSystem } = await importEngineSource('systems/Render3DSystem.ts');
const { Entity } = await importEngineSource('ecs/Entity.ts');
const limits = { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 32, maxStorageBuffersPerShaderStage: 8, maxComputeInvocationsPerWorkgroup: 256 };
function engine(device) { return { device, format:'rgba16float',width:32,height:32,defaults:{},getDepthFormat:()=> 'depth24plus' }; }
function context(device) { const callbacks=[];return { device,encoder:device.createCommandEncoder(),afterSubmit:cb=>callbacks.push(cb),async submit(){device.queue.submit([this.encoder.finish()]);for(const cb of callbacks)cb(device.queue);await device.queue.onSubmittedWorkDone();} }; }

test('actual device limits, dimensions and unchanged sample counts are checked explicitly', () => {
  const device = createAuditGpuDevice({limits});
  validateDeferredDevice(device); validateDeferredViewConfiguration(device,1280,720,1);
  assert.throws(()=>validateDeferredDevice(createAuditGpuDevice({limits:{...limits,maxColorAttachments:2}})),{reason:'device-limit:maxColorAttachments'});
  assert.throws(()=>validateDeferredViewConfiguration(device,1280,720,4),{reason:'sample-count'});
  assert.throws(()=>validateDeferredViewConfiguration(device,0,720,1),{reason:'texture-dimension'});
  assert.throws(()=>validateDeferredViewConfiguration(device,4096,4096,1),{reason:'view-gbuffer-bytes'});
});

test('MRT pooling reuses stable views and defers resize/profile retirement to submission completion', async () => {
  const device=createAuditGpuDevice({limits}),pool=new TransientRenderTargetPool(engine(device)),ctx=context(device);
  const formats=['rgba16float','rgba16float','rgba16float','depth32float'];
  const first=acquireTransientAttachments(pool,'a',32,32,formats,ctx);
  assert.equal(acquireTransientAttachments(pool,'a',32,32,formats,ctx),first);
  const second=acquireTransientAttachments(pool,'a',64,32,formats,ctx);
  const other=acquireTransientAttachments(pool,'b',32,32,formats,ctx);
  assert.notEqual(other.textures[0],first.textures[0]);
  assert.ok(first.textures.every(t=>!t.destroyed));
  pool.destroy();
  assert.ok(second.textures.every(t=>!t.destroyed));
  await ctx.submit();
  assert.ok([...first.textures,...second.textures,...other.textures].every(t=>t.destroyed));
});

test('device loss can abandon never-submitted MRT resources', () => {
  const device=createAuditGpuDevice({limits}),pool=new TransientRenderTargetPool(engine(device)),ctx=context(device);
  const targets=acquireTransientAttachments(pool,'a',32,32,['rgba16float','depth32float'],ctx);
  const resized=acquireTransientAttachments(pool,'a',64,32,['rgba16float','depth32float'],ctx);
  releaseTransientAttachments(pool,true);
  assert.ok([...targets.textures,...resized.textures].every(t=>t.destroyed));
});

test('MRT capacity is bounded across pending resizes and view-local fallback preserves other views', async () => {
  const device=createAuditGpuDevice({limits}),pool=new TransientRenderTargetPool(engine(device)),ctx=context(device);
  const formats=['rgba16float','rgba16float','rgba16float','depth32float'];
  const bounds={maxViews:4,maxLiveGenerations:2};
  const first=acquireTransientAttachments(pool,'a',32,32,formats,ctx,bounds);
  acquireTransientAttachments(pool,'a',64,32,formats,ctx,bounds);
  assert.throws(()=>acquireTransientAttachments(pool,'a',96,32,formats,ctx,bounds),{reason:'live-target-generations',observed:3,supported:2});
  const other=acquireTransientAttachments(pool,'b',32,32,formats,ctx,bounds);
  acquireTransientAttachments(pool,'c',32,32,formats,ctx,bounds);
  acquireTransientAttachments(pool,'d',32,32,formats,ctx,bounds);
  assert.throws(()=>acquireTransientAttachments(pool,'e',32,32,formats,ctx,bounds),{reason:'view-count',observed:5,supported:4});
  releaseTransientAttachments(pool,false,'a');
  await ctx.submit();
  assert.ok(first.textures.every(t=>t.destroyed));
  assert.ok(other.textures.every(t=>!t.destroyed));
  const next=context(device);
  acquireTransientAttachments(pool,'e',32,32,formats,next,bounds);
  await next.submit();pool.destroy();
});

test('destroy while asynchronous initialization is pending never installs a live provider', async t => {
  const device=createAuditGpuDevice({limits}),host=engine(device),renderer=new PbrRenderer();renderer.prepare(host);
  t.after(()=>{renderer.destroy();disposeSceneFrameGpuArena(device);});
  const backend=new DeferredReferenceBackend(host,{failurePolicy:'strict'});
  const pending=backend.initialize(renderer);backend.destroy();
  await assert.rejects(pending,/cancelled/);
  assert.throws(()=>backend.record({}),/destroyed/);
});

test('private factory installs only after initialization and cancels on owner teardown', async t => {
  const device=createAuditGpuDevice({limits}),host=engine(device),renderer=new PbrRenderer();renderer.prepare(host);
  const owner={setRenderProfile(){removeDeferredLightingBackend(this);},_requirePbrRenderer(){return renderer;}};
  t.after(()=>{removeDeferredLightingBackend(owner,true);renderer.destroy();disposeSceneFrameGpuArena(device);});
  const profile=await createDeferredReferenceProfile(owner,host);
  assert.equal(profile.name,'batched');assert.equal(profile.lightingStrategy,'deferred-reference');
  assert.equal(getDeferredLightingBackend(owner),profile.backend);
  const next=createDeferredReferenceProfile(owner,host);removeDeferredLightingBackend(owner);
  await assert.rejects(next,/cancelled/);assert.equal(getDeferredLightingBackend(owner),undefined);
});

test('unsupported device with Forward policy reports restricted fallback without initializing Deferred', async () => {
  const device=createAuditGpuDevice({limits:{...limits,maxColorAttachments:2}}),host=engine(device);
  const owner={setRenderProfile(){removeDeferredLightingBackend(this);},_requirePbrRenderer(){throw new Error('must remain lazy');}};
  const profile=await createDeferredReferenceProfile(owner,host,{failurePolicy:'forward'});
  assert.equal(profile.backend.diagnostics.effective,'forward');
  assert.equal(profile.backend.diagnostics.completeCoverage,false);
  assert.equal(profile.backend.record({}),false);
  removeDeferredLightingBackend(owner);
});

test('profile reactivation reuses immutable shader compilation checks', async t => {
  let checks=0;
  const device=createAuditGpuDevice({limits}),createModule=device.createShaderModule.bind(device);
  device.createShaderModule=descriptor=>{
    const module=createModule(descriptor);
    if(descriptor.label?.startsWith('GeneratedShader.deferred-'))module.getCompilationInfo=async()=>{checks++;return {messages:[]};};
    return module;
  };
  const host=engine(device),renderer=new PbrRenderer();renderer.prepare(host);
  t.after(()=>{renderer.destroy();disposeSceneFrameGpuArena(device);});
  for(let i=0;i<2;i++) {
    const backend=new DeferredReferenceBackend(host,{failurePolicy:'strict'});
    await backend.initialize(renderer);backend.destroy();
  }
  assert.equal(checks,2,'exactly one compilation check for each of the two immutable modules');
});

test('destroy cancels initialization even when native compilation diagnostics never resolve', async t => {
  let checks=0;const device=createAuditGpuDevice({limits}),createModule=device.createShaderModule.bind(device);
  device.createShaderModule=descriptor=>{
    const module=createModule(descriptor);
    if(descriptor.label?.startsWith('GeneratedShader.deferred-'))module.getCompilationInfo=()=>{checks++;return new Promise(()=>{});};
    return module;
  };
  const host=engine(device),renderer=new PbrRenderer();renderer.prepare(host);
  t.after(()=>{renderer.destroy();disposeSceneFrameGpuArena(device);});
  const backend=new DeferredReferenceBackend(host,{failurePolicy:'strict'});
  const pending=backend.initialize(renderer);backend.destroy();
  await assert.rejects(pending,/cancelled/);
  assert.equal(checks,1);
});

test('Render3D owner destruction abandons pending Deferred work before dropping the provider', () => {
  const device=createAuditGpuDevice({limits}),owner=new Render3DSystem(engine(device),new Entity('camera'));
  const modes=[];
  installDeferredLightingBackend(owner,{record:()=>true,destroy:abandon=>modes.push(abandon)});
  owner.destroy();
  assert.deepEqual(modes,[true]);
  assert.equal(getDeferredLightingBackend(owner),undefined);
});


test('Tiled compute limits honor strict and explicit whole-view Forward failure policies before allocation', async () => {
  const device=createAuditGpuDevice({limits:{...limits,maxComputeWorkgroupSizeX:32}}),host=engine(device),owner=new Render3DSystem(host,new Entity('camera'));
  try {
    await assert.rejects(createDeferredReferenceProfile(owner,host,{tiled:{}}),{reason:'device-limit:maxComputeWorkgroupSizeX'});
    const profile=await createDeferredReferenceProfile(owner,host,{tiled:{},failurePolicy:'forward'});
    assert.equal(profile.backend.diagnostics.requested,'deferred-tiled');
    assert.equal(profile.backend.diagnostics.effective,'forward');
    assert.equal(profile.backend.diagnostics.completeCoverage,false);
    assert.equal(profile.backend.record({}),false);
  } finally {owner.destroy();disposeSceneFrameGpuArena(device);}
});

test('Tiled initialization compiles only its active resolve pipelines, while Reference stays independent', async t => {
  const device=createAuditGpuDevice({limits:{...limits,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupStorageSize:16384,maxComputeWorkgroupsPerDimension:65535}}),host=engine(device),renderer=new PbrRenderer();renderer.prepare(host);
  t.after(()=>{renderer.destroy();disposeSceneFrameGpuArena(device);});
  for(const tiled of [true,false]){
    const audit=getAuditGpuDeviceState(device),start=audit.calls.length;
    const backend=new DeferredReferenceBackend(host,{failurePolicy:'strict',...(tiled?{tiled:{}}:{})});
    await backend.initialize(renderer);
    const pipelines=audit.calls.slice(start).filter(call=>call.method==='device.createRenderPipelineAsync');
    assert.deepEqual(pipelines.map(call=>call.label),['depth24plus','depth32float'].map(format=>`${tiled?'DeferredTiles':'DeferredReference'}.resolve:${format}`));
    backend.destroy();
  }
});
