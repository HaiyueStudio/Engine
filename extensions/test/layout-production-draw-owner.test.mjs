import test from 'node:test';
import assert from 'node:assert/strict';
import {World} from '@haiyue/engine/ecs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {buildProductionDrawCandidate} from './layout-production-draw-fixture.mjs';
const candidate=await buildProductionDrawCandidate(),{ProductionDrawOwner}=await candidate.load();
globalThis.GPUBufferUsage??={MAP_READ:1,COPY_DST:8,INDEX:16,VERTEX:32,UNIFORM:64};
globalThis.GPUTextureUsage??={TEXTURE_BINDING:4,RENDER_ATTACHMENT:16};globalThis.GPUShaderStage??={VERTEX:1,FRAGMENT:2,COMPUTE:4};
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve()};
const frame=(color=[1,0,0,1],source)=>({revision:1,viewport:[100,100],dpr:1,instances:[],nodes:[{part:'p',instance:'r',artboard:'a',node:'n',kind:'leaf',rect:[10,20,30,40],opacity:1,background:color,borderWidth:[0,0,0,0],cornerRadius:[0,0,0,0],...(source?{source}: {})}]});
function setup(options={}){
 const fences=[],device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>{const value=defer();fences.push(value);return value.promise;}}});
 const loss=defer();Object.defineProperty(device,'lost',{value:loss.promise});
 const engine={device,width:100,height:100,displayWidth:100,displayHeight:100,format:'rgba8unorm',msaaSamples:1,reverseZ:false,getDepthFormat:()=> 'depth24plus'},world=new World();world.frameData.begin(world,engine,0,0);
 const asset=device.createTexture({size:[8,8],format:'rgba8unorm',usage:4});let acquired=0,released=0;const diagnostics=[];
 const textures=options.textures??{image(){acquired++;return {texture:asset,alphaMode:'premultiplied',release(){released++;if(options.releaseFailure)throw Error('release failed');}}},bitmap(){throw Error('unexpected bitmap')}};
 const owner=new ProductionDrawOwner(engine,textures,{...options,diagnostic:error=>diagnostics.push(error)}),color=device.createTexture({size:[100,100],format:'rgba8unorm',usage:16});
 const context=()=>{const submits=[],cancels=[];let closed=false;return {device,encoder:device.createCommandEncoder(),frameData:world.frameData,descriptor:{colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store'}]},afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb),submit(){assert.equal(closed,false);closed=true;device.queue.submit([this.encoder.finish()]);for(const cb of submits)cb(device.queue)},cancel(){assert.equal(closed,false);closed=true;for(const cb of cancels)cb()}}};
 return {device,engine,owner,world,context,fences,diagnostics,notifyLoss:()=>loss.resolve({reason:'destroyed',message:'controlled audit loss notification'}),commit(value,revision){const step=owner.prepare([value],revision);step.commit();step.finalize?.();return step},get acquired(){return acquired},get released(){return released},snapshot:()=>getAuditGpuDeviceState(device).snapshot()};
}

test('submitted paint-only generations reuse geometry and object buffers; open recordings keep immutable storage',async()=>{
 const f=setup();f.commit(frame());let context=f.context();f.owner.record(f.world,context);context.submit();
 const allocated=()=>f.snapshot().calls.filter(call=>call.method==='device.createBuffer').length;
 const initial=allocated();
 for(let i=0;i<12;i++){f.commit(frame([i/12,0,1,1]));context=f.context();f.owner.record(f.world,context);context.submit();assert.equal(allocated(),initial,'unchanged topology must reuse physical buffers');}
 for(let i=0;i<12;i++){const changed=frame();changed.nodes[0].rect=[10,20,41+i,40];f.commit(changed);context=f.context();f.owner.record(f.world,context);context.submit();assert.equal(allocated(),initial,'changed vertices within capacity must reuse physical buffers');}
 const pending=f.context();f.owner.record(f.world,pending);f.commit(frame([0,1,0,1]));const next=f.context();f.owner.record(f.world,next);assert.ok(allocated()>initial,'unsubmitted generation needs its own immutable storage');pending.cancel();next.submit();
 f.owner.dispose();for(const fence of f.fences)fence.resolve();await settle();assert.equal(f.owner.stats.retainedGenerations,0);
});

test('uncommitted and rolled-back plans cannot draw or replace the last committed generation',async()=>{
 const f=setup(),a=frame(),before=f.owner.prepare([a]);assert.throws(()=>f.owner.record(f.world,f.context()),e=>e.code==='E_HYA_RUNTIME_DRAW');before.rollback();assert.equal(f.owner.stats.retainedGenerations,0);
 f.commit(a);const committed=f.owner.stats.generation,candidate=f.owner.prepare([frame([0,1,0,1])]);candidate.rollback();assert.equal(f.owner.stats.generation,committed);assert.equal(f.owner.stats.retainedGenerations,1);f.owner.dispose();await settle();assert.equal(f.owner.stats.retainedGenerations,0);
});
test('two pending immutable views share uploads and keep their old texture leases through the last close and fence',async()=>{
 const f=setup(),source={kind:'asset',id:'image'};f.commit(frame([1,0,0,1],source));const a=f.context(),b=f.context();f.owner.record(f.world,a);const writes=f.snapshot().calls.filter(call=>call.method==='queue.writeBuffer').length;f.owner.record(f.world,b);assert.equal(f.owner.stats.renderers,1);assert.equal(f.snapshot().calls.filter(call=>call.method==='queue.writeBuffer').length,writes);assert.equal(f.owner.stats.recordings,2);
 f.commit(frame([0,1,0,1],source));assert.equal(f.released,0);a.cancel();assert.equal(f.released,0);assert.equal(f.fences.length,0);b.submit();assert.equal(f.released,0);assert.equal(f.fences.length,1);f.fences[0].resolve();await settle();assert.equal(f.released,1);assert.equal(f.owner.stats.retainedGenerations,1);f.owner.dispose();assert.equal(f.released,2);
});
test('a cancelled new generation retains its queued uploads until queue completion',async()=>{
 const f=setup();f.commit(frame([1,0,0,1],{kind:'asset',id:'image'}));const a=f.context();f.owner.record(f.world,a);a.cancel();f.owner.dispose();assert.equal(f.owner.stats.recordings,0);assert.equal(f.released,0);assert.equal(f.fences.length,1);f.fences[0].resolve();await settle();assert.equal(f.released,1);assert.equal(f.owner.stats.retainedGenerations,0);assert.equal(f.snapshot().resources.buffer.live,0);
});
test('a submitted immutable generation reuses its original buffers without static uniform uploads',async()=>{
 const f=setup(),value=frame();f.commit(value);const a=f.context();f.owner.record(f.world,a);a.submit();const count=()=>f.snapshot().calls.filter(call=>call.method==='queue.writeBuffer').length,first=count(),id=f.owner.stats.generation;
 f.commit({...value,revision:2});assert.equal(f.owner.stats.generation,id);const b=f.context();f.owner.record(f.world,b);b.submit();assert.equal(f.owner.stats.renderers,1);assert.equal(count(),first,'a static frame must not upload camera or object uniforms');f.owner.dispose();for(const fence of f.fences)fence.resolve();await settle();
});
test('closed recording contexts cannot be resurrected after a changed frame commits',async()=>{
 const f=setup();f.commit(frame());const a=f.context();f.owner.record(f.world,a);a.cancel();f.commit(frame([0,1,0,1]));assert.throws(()=>f.owner.record(f.world,a),e=>e.code==='E_HYA_RUNTIME_DRAW');assert.equal(f.owner.stats.recordings,0);f.owner.dispose();for(const fence of f.fences)fence.resolve();await settle();
});
test('a retained closed context no longer roots a retired world through the owner cache',async()=>{
 const f=setup();f.commit(frame());const context=f.context();f.owner.record(f.world,context);context.cancel();f.owner.dispose();for(const fence of f.fences)fence.resolve();await settle();
 assert.equal(f.owner.stats.retainedGenerations,0);assert.equal(f.owner.recordings.has(context),false,'closed context cache still owns retired generation/world');assert.equal(f.snapshot().resources.buffer.live,0);
});
test('first-use terminal contexts close synchronously before GPU buffers or passes are recorded',async()=>{
 const f=setup();f.commit(frame());const context=f.context();context.afterCancel=callback=>callback();context.afterSubmit=()=>{};
 const before=f.snapshot().calls.filter(call=>call.method==='device.createBuffer'||call.method==='commandEncoder.beginRenderPass').length;
 assert.throws(()=>f.owner.record(f.world,context),e=>e.code==='E_HYA_RUNTIME_DRAW');assert.equal(f.owner.stats.recordings,0);
 assert.equal(f.snapshot().calls.filter(call=>call.method==='device.createBuffer'||call.method==='commandEncoder.beginRenderPass').length,before);f.owner.dispose();for(const fence of f.fences)fence.resolve();await settle();
});
test('a stale device context fails before any resources can cross the device boundary',()=>{
 const f=setup();f.commit(frame());const context=f.context();f.engine.device=createAuditGpuDevice();assert.throws(()=>f.owner.record(f.world,context),e=>e.code==='E_HYA_RUNTIME_HOST_PORT');assert.equal(f.owner.stats.recordings,0);assert.equal(f.owner.stats.renderers,0);f.owner.dispose();
});
test('retained geometry is checked before publication and failed staging releases only its candidate leases',async()=>{
 const f=setup({maxGeometryBytes:200}),source={kind:'asset',id:'x'};f.commit(frame([1,0,0,1],source));const current=f.owner.stats.generation;
 assert.throws(()=>f.owner.prepare([frame([0,1,0,1],source)]),e=>e.code==='E_HYA_RUNTIME_LIMIT');assert.equal(f.owner.stats.generation,current);assert.equal(f.acquired,2);assert.equal(f.released,1);f.owner.dispose();assert.equal(f.released,2);
});
test('device loss abandons cancelled-host recordings without retaining frame owners forever',async()=>{
 const f=setup();f.commit(frame([1,0,0,1],{kind:'asset',id:'x'}));const a=f.context();f.owner.record(f.world,a);f.owner.dispose();assert.equal(f.released,0);f.notifyLoss();await f.device.lost;await settle();assert.equal(f.owner.stats.recordings,0);for(const fence of f.fences)fence.reject(Error('lost queue'));await settle();assert.equal(f.released,1);assert.equal(f.owner.stats.retainedGenerations,0);
});
test('queue rejection and throwing release hooks clean each generation once and report failures',async()=>{
 const f=setup({releaseFailure:true});f.commit(frame([1,0,0,1],{kind:'asset',id:'x'}));const a=f.context();f.owner.record(f.world,a);a.submit();f.owner.dispose();f.fences[0].reject(Error('lost queue'));await settle();assert.equal(f.released,1);assert.equal(f.owner.stats.retainedGenerations,0);assert.equal(f.owner.stats.cleanupErrors,1);assert.equal(f.diagnostics.length,1);f.owner.dispose();assert.equal(f.released,1);
});
test('host disposal during texture acquisition unwinds staging and stale commits cannot resurrect the owner',()=>{
 let owner,released=0;const device=createAuditGpuDevice(),texture=device.createTexture({size:[8,8],format:'rgba8unorm',usage:4});
 owner=new ProductionDrawOwner({device},{image(){owner.dispose();return {texture,alphaMode:'premultiplied',release(){released++}}},bitmap(){throw Error('unused')}});
 assert.throws(()=>owner.prepare([frame([1,0,0,1],{kind:'asset',id:'x'})]),e=>e.code==='E_HYA_RUNTIME_DISPOSED');assert.equal(released,1);assert.equal(owner.stats.retainedGenerations,0);
 const f=setup(),step=f.owner.prepare([frame()]);f.owner.dispose();step.commit();assert.equal(f.owner.stats.generation,0);assert.equal(f.owner.stats.retainedGenerations,0);
});
