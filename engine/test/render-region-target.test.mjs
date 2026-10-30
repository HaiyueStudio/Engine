import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {RenderFrameContext,RenderPipeline,World} from '../dist/experimental.js';
try {execFileSync(process.execPath,[fileURLToPath(new URL('../../scripts/build-rollup-once.mjs',import.meta.url)),'rollup.region-tests.config.js','--expect','../artifacts/engine-0.2.2/g04/target-bundle'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',stdio:'pipe'});}
catch(error){throw Error(String(error.stdout??'')+String(error.stderr??''),{cause:error});}
const {RegionColorTarget,RegionColorTargets}=await import('../../artifacts/engine-0.2.2/g04/target-bundle/region-target.js');
const {getRegionCacheBudget}=await import('../../artifacts/engine-0.2.2/g04/target-bundle/region-budget.js');
const {RegionFrameTargets}=await import('../../artifacts/engine-0.2.2/g04/target-bundle/region-working.js');
const {getRegionAttachmentAccounting}=await import('../../artifacts/engine-0.2.2/g04/target-bundle/region-accounting.js');
const spec=(extra={})=>({width:320,height:720,displayWidth:320,displayHeight:720,format:'rgba8unorm',sampleCount:1,depthConvention:'standard',...extra});
const host=device=>({device,format:'rgba8unorm',displayWidth:800,displayHeight:720,width:800,height:720,reverseZ:false,msaaSamples:1,clearColor:{r:0,g:0,b:0,a:0},getDepthFormat:()=> 'depth24plus',getRenderPassDescriptor:()=>({colorAttachments:[]})});
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}};
const tick=async()=>{await Promise.resolve();await Promise.resolve()};

for(const samples of [1,4])test(`color version publication follows submissions and cancellation preserves committed history (${samples} samples)`,async()=>{
 const device=createAuditGpuDevice(),engine=host(device),audit=getAuditGpuDeviceState(device),owner=new RegionColorTargets(engine),token={},s=spec({width:64,height:64,sampleCount:samples});
 const record=(replace=false)=>{const context=new RenderFrameContext(engine),result=owner.acquire(token,'history',s,true,replace,context);assert.equal(result.accepted,true);result.target.encoded(context);owner.written(token,context);return {...result,context};};
 const first=record();first.context.submit();const original=first.target;
 const reader=new RenderFrameContext(engine);original.sample(reader);
 const earlier=record(true),later=record(true);assert.equal(earlier.history,original);assert.equal(later.history,original);assert.equal(earlier.resourceKey,first.resourceKey);assert.equal(later.resourceKey,first.resourceKey);
 // The unsubmitted newer target must never become another frame's history.
 assert.equal(owner.peek(token),original);later.context.submit();assert.equal(owner.peek(token),later.target);earlier.context.submit();assert.equal(owner.peek(token),earlier.target);
 const cancelled=record(true);assert.equal(cancelled.history,earlier.target);cancelled.context.cancel();assert.equal(owner.peek(token),earlier.target);assert.equal(original.valid,false,'retirement is immediate but physical destruction waits for its reader');
 reader.submit();await tick();assert.equal(getRegionCacheBudget(device).snapshot().retainedBytes,earlier.target.colorBytes);
 const created=audit.getCallCount('device.createTexture');const sequential=record();assert.equal(sequential.target,earlier.target);assert.equal(sequential.history,undefined);sequential.context.submit();assert.equal(audit.getCallCount('device.createTexture'),created);
 owner.dispose();await tick();assert.equal(audit.snapshot().resources.texture.live,0);assert.deepEqual(getRegionCacheBudget(device).snapshot(),{retainedBytes:0,retainedRegions:0});
});

test('retained color allocation uses exact region dimensions and stores MSAA/resolve; initialization precedes sampling',async()=>{
 const device=createAuditGpuDevice(),engine=host(device),audit=getAuditGpuDeviceState(device),budget=getRegionCacheBudget(device);
 const {target}=RegionColorTarget.create(engine,'tools',spec({sampleCount:4}));assert.equal(target.colorBytes,320*720*4*5);assert.equal(audit.snapshot().resources.texture.live,3);
 const first=target.updateDescriptor(true).colorAttachments[0];assert.equal(first.storeOp,'store');assert.ok(first.resolveTarget);assert.equal(first.view.texture.sampleCount,4);assert.equal(first.view.texture.width,320);
 const context=new RenderFrameContext(engine);assert.throws(()=>target.sample(context),/uninitialized/);assert.throws(()=>target.updateDescriptor(false),/initialized/);
 const pass=context.beginPass(target.updateDescriptor(true));context.endPass();target.encoded(context);assert.equal(target.valid,false);assert.ok(target.sample(context));context.submit();assert.equal(target.valid,true);assert.equal(target.contentGeneration,1);assert.equal(target.updateDescriptor(false).colorAttachments[0].loadOp,'load');
 target.retire();assert.equal(audit.snapshot().resources.texture.live,3);await tick();assert.equal(audit.snapshot().resources.texture.live,0);assert.deepEqual(budget.snapshot(),{retainedBytes:0,retainedRegions:0});void pass;
});

test('replacement retains old targets through unsubmitted recording, cancellation and final queue completion',async()=>{
 const done=defer(),device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>done.promise}}),engine=host(device),audit=getAuditGpuDeviceState(device),owner=new RegionColorTargets(engine),token={};
 const old=owner.acquire(token,'tools',spec()).target,context=new RenderFrameContext(engine);old.encoded(context);
 const next=owner.acquire(token,'tools',spec({width:400})).target;assert.notEqual(next,old);assert.equal(audit.snapshot().resources.texture.live,4);assert.equal(getRegionCacheBudget(device).snapshot().retainedBytes,(320+400)*720*4);
 context.submit();assert.equal(audit.snapshot().resources.texture.live,4);done.resolve();await tick();assert.equal(audit.snapshot().resources.texture.live,2);
 const unused=new RenderFrameContext(engine);next.encoded(unused);owner.dispose();assert.equal(audit.snapshot().resources.texture.live,2);unused.cancel();assert.equal(audit.snapshot().resources.texture.live,0);assert.throws(()=>unused.submit(),/cancelled/);assert.throws(()=>unused.beginPass(),/cancelled/);
});

test('submission failure cancels leases without consuming cached initialization',()=>{
 const device=createAuditGpuDevice({behaviors:{'queue.submit':()=>{throw Error('submit failed')}}}),engine=host(device),audit=getAuditGpuDeviceState(device);
 const target=RegionColorTarget.create(engine,'tools',spec()).target,context=new RenderFrameContext(engine);target.encoded(context);target.retire();assert.throws(()=>context.submit(),/submit failed/);assert.equal(target.valid,false);assert.equal(audit.snapshot().resources.texture.live,0);
});

test('queue failure after submission retires once; cancelled callbacks cannot run after accepted submission',async()=>{
 const device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>Promise.reject(Error('device lost'))}}),engine=host(device),audit=getAuditGpuDeviceState(device),target=RegionColorTarget.create(engine,'tools',spec()).target;
 const context=new RenderFrameContext(engine);let cancelled=0;context.afterCancel(()=>cancelled++);target.encoded(context);context.submit();context.cancel();assert.equal(cancelled,0);target.retire();target.retire();await tick();assert.equal(audit.snapshot().resources.texture.live,0);
});

test('budget is shared across owners and rejection neither creates GPU objects nor discards valid old contents',async()=>{
 const device=createAuditGpuDevice(),engine=host(device),audit=getAuditGpuDeviceState(device),one=new RegionColorTargets(engine),two=new RegionColorTargets(engine),token={};
 const old=one.acquire(token,'same-label',spec({width:2048,height:2048,format:'rgba16float'})).target;
 const other=two.acquire({},'same-label',spec({width:2048,height:2048,format:'rgba16float'})).target;
 assert.equal(getRegionCacheBudget(device).snapshot().retainedBytes,64*1024*1024);const before=audit.getCallCount('device.createTexture');
 assert.equal(one.acquire(token,'same-label',spec({width:2100,height:2048,format:'rgba16float'})).reason,'color-bytes');assert.equal(audit.getCallCount('device.createTexture'),before);assert.equal(one.acquire(token,'same-label',old.spec).target,old);assert.ok(other);
 one.dispose();two.dispose();await tick();assert.equal(audit.snapshot().resources.texture.live,0);
});

test('partial RTT allocation failures release all colors, depth and budget; invalid or oversized targets do not allocate',()=>{
 for(const fail of ['msaa','depth','color-view']){
  const device=createAuditGpuDevice(),engine=host(device),audit=getAuditGpuDeviceState(device),create=device.createTexture.bind(device);
  device.createTexture=descriptor=>{
   if(descriptor.label.endsWith('.'+fail)||(fail==='depth'&&descriptor.label.includes('.depth.')))throw Error('allocation failed');
   const texture=create(descriptor);if(fail==='color-view'&&descriptor.label.endsWith('.color'))texture.createView=()=>{throw Error('color-view failed')};return texture;
  };
  assert.throws(()=>RegionColorTarget.create(engine,'tools',spec({sampleCount:4})),/failed/);assert.equal(audit.snapshot().resources.texture.live,0,fail);assert.equal(getRegionCacheBudget(device).snapshot().retainedBytes,0);
 }
 const device=createAuditGpuDevice(),engine=host(device),audit=getAuditGpuDeviceState(device);assert.equal(RegionColorTarget.create(engine,'too-large',spec({width:8193})).reason,'device-size');assert.throws(()=>RegionColorTarget.create(engine,'invalid',spec({sampleCount:2})));assert.equal(audit.getCallCount('device.createTexture'),0);
});

test('RenderPipeline record failure cancels every borrowed frame lease before propagating',()=>{
 const device=createAuditGpuDevice(),engine=host(device),context=new RenderFrameContext(engine),pipeline=new RenderPipeline(engine);let cancellations=0;
 context.afterCancel(()=>{cancellations++});pipeline.add({record(){throw Error('producer failed')}});assert.throws(()=>pipeline.execute(new World(),0,16,{context}),/producer failed/);assert.equal(cancellations,1);assert.throws(()=>context.submit(),/cancelled/);
});

test('cancellation drains every lease even when one cleanup fails; an abandoned encoder cannot be revived',()=>{
 const engine=host(createAuditGpuDevice()),context=new RenderFrameContext(engine),calls=[];
 context.afterCancel(()=>{calls.push('first');throw Error('cleanup failed')});context.afterCancel(()=>calls.push('second'));
 assert.throws(()=>context.cancel(),AggregateError);assert.deepEqual(calls,['first','second']);context.cancel();assert.equal(calls.length,2);
 assert.throws(()=>context.afterSubmit(()=>{}),/cancelled/);assert.throws(()=>context.finish(),/cancelled/);assert.throws(()=>context.submit(),/cancelled/);
});

test('1080p working color is separate from the unchanged cache cap and cannot reuse earlier frame contents',async()=>{
 const device=createAuditGpuDevice(),engine=host(device),owner=new RegionFrameTargets(engine),accounting=getRegionAttachmentAccounting(device);
 const target=owner.acquire(spec({width:1920,height:1080,format:'rgba16float',sampleCount:4}));
 assert.equal(target.colorBytes,82944000);assert.deepEqual(getRegionCacheBudget(device).snapshot(),{retainedBytes:0,retainedRegions:0});
 const first=new RenderFrameContext(engine);target.encoded(first);target.sample(first);first.submit();
 const next=new RenderFrameContext(engine);assert.throws(()=>target.sample(next),/uninitialized/);assert.throws(()=>target.updateDescriptor(false,next),/initialized/);next.cancel();
 assert.equal(accounting.snapshot().workingColorBytes,82944000);assert.equal(accounting.snapshot().regionDepthBytes,1920*1080*4*4);
 assert.equal(accounting.snapshot().totalRegionAttachmentBytes,82944000+1920*1080*4*4);
 assert.equal(RegionColorTarget.create(engine,'oversized-cache',target.spec).reason,'color-bytes');
 owner.dispose();await tick();assert.equal(accounting.snapshot().totalRegionAttachmentBytes,0);assert.equal(getAuditGpuDeviceState(device).snapshot().resources.texture.live,0);
});

test('working replacement counts unsubmitted and queue-retiring overlap across owners until safe release',async()=>{
 const done=defer(),device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>done.promise}}),engine=host(device),one=new RegionFrameTargets(engine),two=new RegionFrameTargets(engine),accounting=getRegionAttachmentAccounting(device);
 const old=one.acquire(spec()),recording=new RenderFrameContext(engine);old.encoded(recording);
 const next=one.acquire(spec({width:400})),other=two.acquire(spec({width:100}));
 assert.equal(accounting.snapshot().workingColorBytes,(320+400+100)*720*4);assert.equal(accounting.snapshot().workingRetiringColorBytes,320*720*4);
 recording.submit();await tick();assert.equal(accounting.snapshot().workingRetiringColorBytes,320*720*4);
 done.resolve();await tick();assert.equal(accounting.snapshot().workingColorBytes,(400+100)*720*4);assert.equal(accounting.snapshot().workingRetiringColorBytes,0);
 const cancelled=new RenderFrameContext(engine);next.encoded(cancelled);one.dispose();assert.equal(accounting.snapshot().workingRetiringColorBytes,400*720*4);cancelled.cancel();assert.equal(accounting.snapshot().workingColorBytes,other.colorBytes);
 two.dispose();assert.equal(accounting.snapshot().totalRegionAttachmentBytes,0);
});

test('working allocation failure rolls back accounting and preserves the previous allocation',()=>{
 const device=createAuditGpuDevice(),engine=host(device),owner=new RegionFrameTargets(engine),accounting=getRegionAttachmentAccounting(device),initial=spec(),old=owner.acquire(initial),before=accounting.snapshot(),create=device.createTexture.bind(device);
 device.createTexture=descriptor=>{if(descriptor.label.includes('.depth.'))throw Error('depth allocation failed');return create(descriptor)};
 assert.throws(()=>owner.acquire(spec({width:400})),/failed/);assert.deepEqual(accounting.snapshot(),before);assert.equal(owner.acquire(initial),old);
 assert.throws(()=>owner.acquire(spec({width:8193})),/device-size/);assert.deepEqual(accounting.snapshot(),before);
 owner.dispose();assert.equal(accounting.snapshot().totalRegionAttachmentBytes,0);assert.equal(getAuditGpuDeviceState(device).snapshot().resources.texture.live,0);
});
