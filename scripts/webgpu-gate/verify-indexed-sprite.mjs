import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/indexed-sprite-fixture.html',
  timeoutMs: 90_000,
});
assert.equal(evidence.status, 'passed');
assert.equal(evidence.suite, 'indexed-sprite-generated-shader-readback');
assert.equal(evidence.strictValidation, true);
assert.deepEqual(evidence.firstRun.map(value => [value.width, value.height]), [[1280, 720], [1920, 1080]]);
assert.equal(evidence.recoveryRun.stats.generation, 1);
assert.equal(evidence.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify({
  status: 'passed',
  suite: evidence.suite,
  resolutions: evidence.firstRun.map(value => `${value.width}x${value.height}`),
  recoveryGeneration: evidence.recoveryRun.stats.generation,
  browser: evidence.browserEvidence,
  diagnostics: evidence.browserDiagnostics,
}, null, 2));
