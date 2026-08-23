import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const report = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/deformable-blend-composition-fixture.html',
  timeoutMs: 60_000,
});
assert.equal(report.status, 'passed');
assert.equal(report.suite, 'deformable-blend-composition-texture-readback');
assert.equal(report.caseCount, 15);
assert.deepEqual(report.modes, ['normal', 'additive', 'multiplicative']);
assert.ok(report.textureCount >= 3);
assert.equal(report.strictValidation, true);
assert.deepEqual(report.runtimeExternalImageUpload.actual, report.runtimeExternalImageUpload.expected);
assert.ok(report.cases.every(item => item.maximumError <= 2));
assert.equal(report.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify(report, null, 2));
