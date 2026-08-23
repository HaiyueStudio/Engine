import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const report = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/deformable-culling-fixture.html',
  timeoutMs: 60_000,
});
assert.equal(report.status, 'passed');
assert.equal(report.suite, 'deformable-culling-texture-readback');
assert.equal(report.sourceFrontFace, 'ccw');
assert.equal(report.frontFace, 'ccw');
assert.equal(report.strictValidation, true);
assert.equal(report.firstRun.passCount, 3);
assert.equal(report.recoveryRun.passCount, 1);
assert.ok(report.firstRun.evidence.every(pass => pass.cases.every(item => item.drawn === item.expectedDrawn)));
assert.ok(report.recoveryRun.evidence.every(pass => pass.cases.every(item => item.drawn === item.expectedDrawn)));
assert.equal(new Set(report.firstRun.cacheCounts).size, 1);
assert.equal(report.browserDiagnostics.unclassifiedFailureCount, 0);
const rice = JSON.parse(await readFile(resolve(root, 'review/candidates/live2d-culling-rice-candidate.json'), 'utf8'));
assert.equal(rice.formalEvidence, false);
assert.equal(rice.sampleCount, 1);
assert.ok(rice.samples[0].featureCoverage.cullingDrawableCount > 0);
assert.equal(rice.samples[0].conversionDiagnostics.some(item => item.code === 'W_CUBISM_CULLING_IGNORED'), false);
assert.equal(rice.samples[0].recoverySmoke, true);
assert.equal(rice.samples[0].browserDiagnostics.unclassifiedFailureCount, 0);
assert.ok(rice.samples[0].surfaceReadback.meanAbsoluteError <= 1);
assert.ok(rice.samples[0].surfaceReadback.mismatchRatio <= 0.025);
console.log(JSON.stringify({ ...report, riceCandidate: {
  runtimeDirectoryHash: rice.samples[0].runtimeDirectoryHash,
  cullingDrawableCount: rice.samples[0].featureCoverage.cullingDrawableCount,
  conversionDiagnosticCount: rice.samples[0].conversionDiagnostics.length,
  surfaceReadback: rice.samples[0].surfaceReadback,
} }, null, 2));
