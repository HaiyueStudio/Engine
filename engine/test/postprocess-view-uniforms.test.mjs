import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {PostProcessViewUniforms}=await importEngineSource('postprocess/PostProcessViewUniforms.ts');
const {setPostProcessSubmission}=await importEngineSource('postprocess/PostProcessSubmission.ts');
const frame=(viewKey,frameId=1)=>({viewKey,frameId}),data=n=>new Float32Array([n,2,3,4]).buffer;
const tick=async()=>{for(let i=0;i<6;i++)await Promise.resolve()};
function fixture(behaviors={}){
 const device=createAuditGpuDevice({behaviors}),audit=getAuditGpuDeviceState(device),owner=new PostProcessViewUniforms(),pass={label:'AO'},recordings=[];owner.prepare(device,'AO test parameters',16);
 return{device,audit,owner,pass,recordings,record(){const submit=[],cancel=[];setPostProcessSubmission(pass,cb=>submit.push(cb),cb=>cancel.push(cb));const r={submit:()=>submit.forEach(cb=>cb(device.queue)),cancel:()=>cancel.forEach(cb=>cb())};recordings.push(r);return r;}};
}
test('postprocess camera parameters stay view-local and changed pending values get immutable storage',async()=>{
 const f=fixture();try{
  const a=f.record(),wide=f.owner.write(f.pass,frame('wide'),data(1));
  const b=f.record(),tall=f.owner.write(f.pass,frame('tall'),data(2));assert.notEqual(wide,tall);
  const c=f.record();assert.equal(f.owner.write(f.pass,frame('wide'),data(1)),wide,'Unchanged pending values are safe to share');const uploads=f.audit.getCallCount('queue.writeBuffer');
  const d=f.record(),changed=f.owner.write(f.pass,frame('wide',2),data(3));assert.notEqual(changed,wide);assert.equal(f.audit.getCallCount('queue.writeBuffer'),uploads+1);
  f.owner.destroy();assert.equal(f.audit.snapshot().resources.buffer.live,3,'Unsubmitted uniforms must stay alive through owner teardown');
  a.submit();c.cancel();b.cancel();d.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);
 }finally{for(const r of f.recordings)r.cancel();f.owner.destroy();await tick();}
});
test('submitted view parameters reuse capacity without per-frame buffer allocation or unchanged upload',async()=>{
 const f=fixture();try{
  const a=f.record(),buffer=f.owner.write(f.pass,frame('wide'),data(1));a.submit();const allocated=f.audit.getCallCount('device.createBuffer'),uploads=f.audit.getCallCount('queue.writeBuffer');
  for(let i=2;i<15;i++){const r=f.record();assert.equal(f.owner.write(f.pass,frame('wide',i),data(1)),buffer);r.submit();}
  assert.equal(f.audit.getCallCount('device.createBuffer'),allocated);assert.equal(f.audit.getCallCount('queue.writeBuffer'),uploads);
  const changed=f.record();assert.equal(f.owner.write(f.pass,frame('wide',15),data(7)),buffer);changed.submit();assert.equal(f.audit.getCallCount('queue.writeBuffer'),uploads+1);
 }finally{f.owner.destroy();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);}
});
test('stale view eviction waits for cancellation and submitted queue fences',async()=>{
 let done;const wait=new Promise(resolve=>done=resolve),f=fixture({'queue.onSubmittedWorkDone':()=>wait});
 try{const a=f.record();f.owner.write(f.pass,frame('old',1),data(1));a.submit();const b=f.record();f.owner.write(f.pass,frame('current',122),data(2));assert.equal(f.audit.snapshot().resources.buffer.live,2);f.owner.destroy();b.cancel();assert.equal(f.audit.snapshot().resources.buffer.live,1);done();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);}
 finally{done();for(const r of f.recordings)r.cancel();f.owner.destroy();await tick();}
});
