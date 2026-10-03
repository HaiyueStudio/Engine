import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInspectorCapture } from './framegraph-inspector-policy.mjs';
const valid = () => ({ schemaVersion: 1, scope: 'selected-system-command-context', status: 'submitted', error: null, truncated: false,
  overhead: { gpuReadbacks: 0, extraPasses: 0, retainedGpuBytes: 0 }, work: { renderPasses: 1, computePasses: 0, drawCalls: 1, dispatchCalls: 0, bundleExecutions: 0, copies: 0, resolves: 0, submissions: 1 },
  allocations: [{ intervalScope: 'allocation-local', mappings: [{ firstUse: 0, lastUse: 1, descriptor: '4x4 rgba8', decision: 'available' }] }], pools: [{ counters: { pendingBytes: 4, pendingPeakBytes: 8 } }] });
test('valid observer capture admits unavailable bundle draw totals without claiming performance', () => assert.deepEqual(validateInspectorCapture({ ...valid(), work: { ...valid().work, bundledDraws: null } }), []));
test('failed, truncated, readback or missing submission cannot be passed evidence', () => {
  const s = valid(); s.status = 'failed'; s.truncated = true; s.overhead.gpuReadbacks = 1; s.work.submissions = null;
  assert.equal(validateInspectorCapture(s).length, 5); assert.ok(validateInspectorCapture(null).length > 0);
});
test('physical intervals and pending high water must be explicit and consistent', () => {
  const s = valid(); s.allocations[0].intervalScope = 'global'; s.allocations[0].mappings[0].lastUse = -1; s.pools[0].counters.pendingPeakBytes = 0;
  assert.equal(validateInspectorCapture(s).length, 3);
});

test('physical reuse across released batches uses pool identity, not incomparable local intervals', async () => {
  const { findSequentialPoolReuses } = await import('./framegraph-inspector-policy.mjs');
  const allocation = (id, pool) => ({ id, pool, owner: 'postprocess', mappings: [{ physicalId: 1, firstUse: 0, lastUse: 1 }] });
  assert.deepEqual(findSequentialPoolReuses({ allocations: [allocation(0, 1), allocation(1, 2)] }, 'postprocess'), []);
  assert.deepEqual(findSequentialPoolReuses({ allocations: [allocation(0, 1), allocation(1, 1)] }, 'postprocess'), [{ physical: '1:1', batches: [0, 1] }]);
});
