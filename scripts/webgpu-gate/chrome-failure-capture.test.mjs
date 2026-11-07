import assert from 'node:assert/strict';
import test from 'node:test';
import { captureChromeFailureSnapshot } from './chrome-runner.mjs';

test('failure capture retains completed and in-flight sample arrays before browser cleanup', async () => {
  const snapshot = { cases: [{ id: '720p.low.r8unorm' }], currentCase: { rawSamples: { total: [1, 2] } } };
  const cdp = { async call(method, args) {
    assert.equal(method, 'Runtime.evaluate');
    assert.deepEqual(args, { expression: 'capture()', returnByValue: true, awaitPromise: true });
    return { result: { result: { value: snapshot } } };
  } };
  assert.equal(await captureChromeFailureSnapshot(cdp, 'capture()'), snapshot);
});

test('failure capture exposes script and transport errors for the original failure record', async () => {
  await assert.rejects(captureChromeFailureSnapshot({
    async call() { return { result: { exceptionDetails: { text: 'scope capture failed' } } }; },
  }, 'capture()'), /scope capture failed/);
  await assert.rejects(captureChromeFailureSnapshot({
    async call() { throw Error('connection closed'); },
  }, 'capture()'), /connection closed/);
});
