import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuditGpuDevice} from './real-renderer-audit-device.mjs';
import {createRealRendererGpuTimestampProbe} from './real-renderer-scenario.mjs';

test('G03 opt-in timing includes compute and reports elapsed GPU span separately from summed pass durations',async()=>{
  const device=createAuditGpuDevice({features:['timestamp-query'],behaviors:{'buffer.getMappedRange':()=>new BigUint64Array([1_000_000n,2_000_000n,4_000_000n,7_000_000n,8_000_000n,10_000_000n]).buffer}});
  const probe=createRealRendererGpuTimestampProbe({device},{includeCompute:true});
  probe.beginFrame();
  const a=probe.decorateRenderPass({label:'gbuffer'}),b=probe.decorateComputePass({label:'cull'}),c=probe.decorateRenderPass({label:'resolve'});
  assert.equal(a.timestampWrites.beginningOfPassWriteIndex,0);
  assert.equal(b.timestampWrites.beginningOfPassWriteIndex,2);
  assert.equal(c.timestampWrites.beginningOfPassWriteIndex,4);
  probe.resolve(device.createCommandEncoder());const timing=await probe.readFrame();
  assert.equal(timing.scope,'render-and-compute-span-v1');
  assert.equal(timing.totalMs,6);assert.equal(timing.spanMs,9);
  assert.deepEqual(timing.passes.map(p=>p.kind),['render','compute','render']);
  assert.deepEqual(timing.passes.map(p=>p.durationMs),[1,3,2]);
  probe.destroy();
});
test('existing timing population remains render-only unless compute is explicitly enabled',()=>{
  const device=createAuditGpuDevice({features:['timestamp-query']}),probe=createRealRendererGpuTimestampProbe({device});
  probe.beginFrame();const compute={label:'cull'};
  assert.equal(probe.decorateComputePass(compute),compute);assert.equal(probe.queryCount,0);
  probe.decorateRenderPass({label:'resolve'});assert.equal(probe.queryCount,2);assert.deepEqual(probe.passLabels,['resolve']);probe.destroy();
});
