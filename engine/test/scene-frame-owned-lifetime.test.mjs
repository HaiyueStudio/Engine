import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera3D,Entity,World} from '../dist/experimental.js';
import {createAuditGpuDevice,getAuditGpuDeviceState} from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import {importEngineSource} from './helpers/internal-source.mjs';
const {Camera3DFrameSnapshots}=await importEngineSource('frame/Camera3DFrameSnapshots.ts');
const {getSceneFrameUniformSnapshot}=await importEngineSource('frame/SceneFrameUniformLayout.ts');
const {SceneFrameGpuArena}=await importEngineSource('renderer/SceneFrameGpuArena.ts');
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
function fixture(initial=2){
 const device=createAuditGpuDevice(),audit=getAuditGpuDeviceState(device),arena=new SceneFrameGpuArena(device,{maxViews:initial,framesInFlight:1}),binding=arena.createBinding(),owner=new Camera3DFrameSnapshots(),world=new World(),camera=new Entity().addComponent(new Camera3D());world.addEntity(camera);const pending=[];
 return{device,audit,arena,binding,owner,world,
  capture(key,width=160){const submitted=[],cancelled=[],context={device,afterSubmit:cb=>submitted.push(cb),afterCancel:cb=>cancelled.push(cb)},finish=owner.begin(context);world.frameData.begin(world,null,0,16);const data=owner.capture(key,world.frameData.getCamera3D(camera,camera.getComponent(Camera3D),width,80)),snapshot=owner.uniforms(data,null);const buffer=arena.buffer,offset=binding.upload(snapshot,context);finish();let done=false;const record={data,snapshot,buffer,offset,submit(){if(done)return;done=true;submitted.forEach(cb=>cb(device.queue))},cancel(){if(done)return;done=true;cancelled.forEach(cb=>cb())}};pending.push(record);return record;},
  async destroy(){owner.clear();binding.destroy();arena.destroy();for(const r of pending)r.cancel();world.destroy();await tick();assert.equal(audit.snapshot().resources.buffer.live,0);}
 };
}
test('alternating views keep two arena streams and stable allocation after warmup',async()=>{
 const f=fixture();try{f.capture('A').submit();f.capture('B').submit();await tick();const created=f.audit.snapshot().resources.buffer.created;for(let i=0;i<300;i++)f.capture(i%2?'B':'A').submit();await tick();assert.equal(f.owner.stats.views,2);assert.equal(f.arena.getStats().viewCount,2);assert.equal(f.audit.snapshot().resources.buffer.created,created);}
 finally{await f.destroy();}
});
test('idle-key eviction and 300 resize generations retire streams instead of accumulating arena capacity',async()=>{
 const f=fixture();try{for(let i=0;i<120;i++)f.capture('view-'+i).submit();await tick();assert.ok(f.owner.stats.views<=32);assert.ok(f.arena.getStats().viewCount<=32);assert.ok(f.arena.maxViews<=64);const capacity=f.arena.maxViews;for(let i=0;i<300;i++)f.capture('resized',120+i).submit();await tick();assert.ok(f.arena.getStats().viewCount<=32);assert.equal(f.arena.maxViews,capacity);assert.equal(f.arena.getStats().retiringGenerations,0);assert.equal(f.audit.snapshot().resources.buffer.live,1);}
 finally{await f.destroy();}
});
test('retired snapshot streams and destroyed bindings cannot recycle a slot still used by a pending encoder',async()=>{
 const f=fixture(4);try{const a=f.capture('A');f.owner.clear();f.binding.destroy();const next=f.arena.createBinding(),callbacks=[],context={device:f.device,afterSubmit:cb=>callbacks.push(cb),afterCancel:cb=>callbacks.push(cb)};f.world.frameData.begin(f.world,null,1,16);const source=f.world.frameData.getCamera3D(a.data.entity,a.data.camera,80,160),snapshot=getSceneFrameUniformSnapshot(source,null),offset=next.upload(snapshot,context);assert.notEqual(offset,a.offset);assert.equal(f.arena.getStats().viewCount,2);assert.throws(()=>next.upload(a.snapshot,context),/retired/);a.cancel();assert.equal(f.arena.getStats().viewCount,1);next.destroy();assert.equal(f.arena.getStats().viewCount,1);for(const cb of callbacks)cb(f.device.queue);assert.equal(f.arena.getStats().viewCount,0);}
 finally{await f.destroy();}
});
test('arena growth waits for every older recording even if the replacing recording is cancelled',async()=>{
 const f=fixture(1);try{const a=f.capture('A'),b=f.capture('B');assert.notEqual(a.buffer,f.arena.buffer);b.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,2,'older unsubmitted buffer must survive replacement cancellation');a.submit();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,1);}
 finally{await f.destroy();}
});
test('arena disposal preserves a pending generation until cancellation rather than untracking it early',async()=>{
 const f=fixture();try{const a=f.capture('A');f.owner.clear();f.binding.destroy();f.arena.destroy();assert.equal(f.audit.snapshot().resources.buffer.live,1);a.cancel();await tick();assert.equal(f.audit.snapshot().resources.buffer.live,0);}
 finally{await f.destroy();}
});
