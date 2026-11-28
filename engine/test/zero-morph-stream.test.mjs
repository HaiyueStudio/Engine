import test from 'node:test';
import assert from 'node:assert/strict';
import {Geometry3D} from '../dist/index.js';
import {Mesh3DRenderer} from '../dist/experimental.js';
import {getSharedGeometry3DGPUCache,disposeSharedGeometry3DGPUCache} from '../dist/renderer.js';
import {createAuditGpuDevice} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
globalThis.GPUBufferUsage??={VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(count){const device=createAuditGpuDevice(),renderer=new Mesh3DRenderer(),geo=new Geometry3D({positions:new Float32Array(count*3),indices:new Uint16Array([0,1,2])});renderer.engine={device};renderer.sharedGeoCache=getSharedGeometry3DGPUCache(device);const data=renderer._uploadGeometry(geo);return{renderer,device,geo,data,async close(){renderer._destroyGeoData(data);disposeSharedGeometry3DGPUCache(device);await settle();}};}
test('four default morph bindings share one immutable zero allocation',async()=>{const f=setup(100000);try{const unique=new Set(f.data.morphPositionBufs);assert.equal(unique.size,1);assert.equal([...unique][0].size,1200000);assert.equal(f.renderer._localGeometryBuffers(f.data).length,1);}finally{await f.close();}});
test('growth replaces one zero stream and retires the old allocation after both recordings close',async()=>{
 const f=setup(3),recording=()=>{const submits=[],cancels=[];return{device:f.device,afterSubmit:cb=>submits.push(cb),afterCancel:cb=>cancels.push(cb),submit(){submits.forEach(cb=>cb(f.device.queue));},cancel(){cancels.forEach(cb=>cb());}};};
 try{const old=f.data.morphPositionBufs[0];let destroyed=0;const original=old.destroy.bind(old);old.destroy=()=>{destroyed++;original();};const a=recording(),b=recording();f.renderer.submissionContext=a;f.renderer._retainGeometry(f.geo,f.data);f.renderer.submissionContext=b;f.renderer._retainGeometry(f.geo,f.data);f.geo.positions=new Float32Array(90);f.renderer._updateGeometryBuffers(f.geo,f.data);assert.equal(new Set(f.data.morphPositionBufs).size,1);assert.equal(destroyed,0);a.cancel();await settle();assert.equal(destroyed,0);b.submit();await settle();assert.equal(destroyed,1);}finally{await f.close();}
});
test('actual morph target data stays distinct from shared missing target slots',async()=>{const f=setup(3);try{f.geo.setMorphTargets([{positions:new Float32Array(9).fill(1)}]);f.renderer._updateGeometryBuffers(f.geo,f.data);assert.equal(new Set(f.data.morphPositionBufs).size,2);assert.notEqual(f.data.morphPositionBufs[0],f.data.morphPositionBufs[1]);assert.equal(f.data.morphPositionBufs[1],f.data.morphPositionBufs[3]);}finally{await f.close();}});
