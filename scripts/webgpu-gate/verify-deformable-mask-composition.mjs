import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidence = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/deformable-mask-composition-fixture.html',
  timeoutMs: 60_000,
});
assert.equal(evidence.status, 'passed');
assert.equal(evidence.suite, 'deformable-mask-composition-texture-readback');
assert.equal(evidence.caseCount, 8);
assert.equal(evidence.strictValidation, true);
assert.ok(evidence.cases.every(item => item.error <= 1));
assert.equal(evidence.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify({
  status: 'passed',
  suite: evidence.suite,
  cases: evidence.cases,
  browser: evidence.browserEvidence,
  diagnostics: evidence.browserDiagnostics,
}, null, 2));
