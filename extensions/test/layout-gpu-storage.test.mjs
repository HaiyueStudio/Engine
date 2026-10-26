import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {loadResponsiveLayoutModules} from './responsive-layout-fixture.mjs';
const {runtime:{LayoutGpuRenderer}}=await loadResponsiveLayoutModules();
globalThis.GPUBufferUsage??={VERTEX:32,COPY_DST:8};globalThis.GPUTextureUsage??={RENDER_ATTACHMENT:16};
const evaluation=(width=10)=>({viewport:[100,100],nodes:[{rect:{x:0,y:0,width,height:10},background:[1,0,0,1],opacity:1,borderWidth:[0,0,0,0],cornerRadius:[0,0,0,0]}]});
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function setup(){const fences=[],device=createAuditGpuDevice({behaviors:{'queue.onSubmittedWorkDone':()=>new Promise(resolve=>fences.push(resolve))}}),renderer=new LayoutGpuRenderer(device,'rgba8unorm',4096);return {device,renderer,fences,calls:()=>getAuditGpuDeviceState(device).snapshot().calls};}
test('diagnostic layout vertices retain capacity and skip static uploads',async()=>{
 const f=setup();f.renderer.upload(evaluation());const count=f.calls().filter(c=>c.method==='device.createBuffer').length,writes=f.calls().filter(c=>c.method==='queue.writeBuffer').length;
 f.renderer.upload(evaluation());assert.equal(f.calls().filter(c=>c.method==='queue.writeBuffer').length,writes);
 for(let i=0;i<20;i++)f.renderer.upload(evaluation(11+i));assert.equal(f.calls().filter(c=>c.method==='device.createBuffer').length,count);
 f.renderer.dispose();for(const finish of f.fences)finish();await settle();assert.equal(f.renderer.stats.allocatedBytes,0);
});
test('open encoder storage survives replacement and disposal through its terminal hook and queue fence',async()=>{
 const f=setup(),texture=f.device.createTexture({size:[100,100],format:'rgba8unorm',usage:16}),encoder=f.device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store'}]});
 const submits=[],cancels=[];f.renderer.upload(evaluation());f.renderer.render(pass,{afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb)});pass.end();
 f.renderer.upload(evaluation(20));assert.equal(f.renderer.stats.bufferCount,2);f.renderer.dispose();assert.ok(f.renderer.stats.bufferCount>0);f.device.queue.submit([encoder.finish()]);for(const cb of submits)cb(f.device.queue);for(const finish of f.fences)finish();await settle();assert.equal(f.renderer.stats.bufferCount,0);texture.destroy();
});
test('oversized candidate preserves committed layout storage',async()=>{
 const f=setup();f.renderer.upload(evaluation());const before=f.renderer.stats;
 const large=evaluation();large.nodes=Array.from({length:100},()=>large.nodes[0]);assert.throws(()=>f.renderer.upload(large),/E_LAYOUT_GPU_BUDGET/);assert.deepEqual(f.renderer.stats,before);
 f.renderer.dispose();for(const finish of f.fences)finish();await settle();assert.equal(f.renderer.stats.bufferCount,0);
});
