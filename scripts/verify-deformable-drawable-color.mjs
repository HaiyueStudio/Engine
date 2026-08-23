import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const report = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/deformable-drawable-color-fixture.html',
  timeoutMs: 60_000,
});
assert.equal(report.status, 'passed');
assert.equal(report.suite, 'deformable-drawable-color-generated-shader-readback');
assert.equal(report.shaderOracle, 'generated-animation-2d');
assert.equal(report.colorSpaceBoundary, 'display-encoded-rgba8unorm');
assert.equal(report.firstRun.passCount, 3);
assert.equal(report.recoveryRun.passCount, 1);
assert.equal(new Set(report.firstRun.cacheCounts).size, 1);
assert.equal(new Set(report.firstRun.resourceCounts).size, 1);
assert.ok(report.firstRun.evidence.every(pass => pass.maximumError <= 2));
assert.ok(report.recoveryRun.evidence.every(pass => pass.maximumError <= 2));
assert.equal(report.browserDiagnostics.unclassifiedFailureCount, 0);
assert.ok(report.httpProvenance.files.some(file => file.sourcePath === 'extensions/src/shaders/generated/2d-ui-animation-2d.generated.wgsl'));
console.log(JSON.stringify(report, null, 2));
