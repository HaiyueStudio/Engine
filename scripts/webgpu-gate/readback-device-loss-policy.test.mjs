import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReadbackDeviceLoss } from './readback-device-loss-policy.mjs';
const evidence = () => ({ schemaVersion: 1, status: 'passed', scope: 'readback-device-loss-lifecycle', performanceQualified: false,
  cases: ['reserved', 'mapping', 'disposed-reservation'].map((mode, i) => ({ mode, status: i === 2 ? 'cancelled' : 'failed', bytes: null,
    stats: { pending: 0, completed: 0, failed: i === 2 ? 0 : 1, cancelled: i === 2 ? 1 : 0 }, errors: [],
    adapter: { vendor: 'intel', architecture: 'gen-9', isFallbackAdapter: false } })) });
test('loss evidence requires every lifecycle and rejects leaked slots, late bytes and wrong devices', () => {
  validateReadbackDeviceLoss(evidence());
  for (const mutate of [r => r.cases.pop(), r => { r.cases[0].stats.pending = 1; }, r => { r.cases[1].bytes = [0]; },
    r => { r.cases[1].stats.completed = 1; }, r => { r.cases[2].status = 'failed'; },
    r => { r.cases[0].adapter.isFallbackAdapter = true; }, r => { r.performanceQualified = true; }]) {
    const r = evidence(); mutate(r); assert.throws(() => validateReadbackDeviceLoss(r));
  }
  const changed = evidence(); changed.cases[1].adapter.vendor = 'amd';
  assert.throws(() => validateReadbackDeviceLoss(changed));
});
