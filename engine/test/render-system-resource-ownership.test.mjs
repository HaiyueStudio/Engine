import test from 'node:test';
import assert from 'node:assert/strict';
import {importEngineSource} from './helpers/internal-source.mjs';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
const {RenderSystemResourceOwnership}=await importEngineSource('renderer/RenderSystemResourceOwnership.ts');
const {GPUResourceTracker,createGPUResourceOwner}=await importEngineSource('core/GPUResourceTracker.ts');
function setup(){const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),tracker=new GPUResourceTracker({debug:true});tracker.instrumentDevice(device,createGPUResourceOwner('system','Owner regression'));return{device,audit,tracker};}
function allocate(f,boundary,system){const token=boundary.enter(system);try{return f.device.createBuffer({label:'shared renderer vertices',size:64,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});}finally{boundary.leave(token);}}

test('retiring one pipeline preserves a renderer buffer still registered by another pipeline',()=>{
 const f=setup(),system={name:'Persistent GUI'},first=new RenderSystemResourceOwnership(f.tracker),next=new RenderSystemResourceOwnership(f.tracker);
 try{first.add(system);const buffer=allocate(f,first,system);next.add(system);first.remove(system);assert.equal(f.audit.snapshot().resources.buffer.live,1);f.device.queue.writeBuffer(buffer,0,new Uint8Array(16));next.remove(system);assert.equal(f.audit.snapshot().resources.buffer.live,0);assert.equal(f.tracker.getDebugSnapshot().releasedOwnerResiduals,0);}finally{first.clear();next.clear();}
});

test('300 overlapping handoffs and duplicate registration keep one allocation then release it once',()=>{
 const f=setup(),system={name:'Persistent GUI'};let active=new RenderSystemResourceOwnership(f.tracker);active.add(system);const buffer=allocate(f,active,system);
 try{for(let i=0;i<300;i++){const next=new RenderSystemResourceOwnership(f.tracker);next.add(system);next.add(system);active.clear();active.clear();active=next;f.device.queue.writeBuffer(buffer,0,new Uint8Array([i%256]));assert.equal(f.audit.snapshot().resources.buffer.live,1);}assert.equal(f.audit.snapshot().resources.buffer.created,1);}finally{active.clear();assert.equal(f.audit.snapshot().resources.buffer.live,0);}
});

test('shared renderer owners are isolated by tracker and releasing another renderer remains immediate',()=>{
 const a=setup(),b=setup(),system={name:'Same identity'},other={name:'Other'},first=new RenderSystemResourceOwnership(a.tracker),next=new RenderSystemResourceOwnership(b.tracker);
 try{first.add(system);first.add(other);next.add(system);allocate(a,first,system);const otherBuffer=allocate(a,first,other),foreign=allocate(b,next,system);first.remove(system);assert.equal(a.audit.snapshot().resources.buffer.live,1);assert.equal(b.audit.snapshot().resources.buffer.live,1);a.device.queue.writeBuffer(otherBuffer,0,new Uint8Array(4));b.device.queue.writeBuffer(foreign,0,new Uint8Array(4));first.remove(system);first.clear();assert.equal(a.audit.snapshot().resources.buffer.live,0);assert.equal(b.audit.snapshot().resources.buffer.live,1);}finally{first.clear();next.clear();assert.equal(b.audit.snapshot().resources.buffer.live,0);}
});
