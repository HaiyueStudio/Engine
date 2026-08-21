import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const exampleRoot = resolve(root, 'examples/hya-live2d-corpus-dashboard');
const bundle = await readFile(resolve(exampleRoot, 'bundle.js'), 'utf8');
for (const forbidden of ['Live2DCubismCore', 'Moc.fromArrayBuffer', '.moc3', '.model3.json', 'convertCubismCaptureToHya']) {
  assert.equal(bundle.includes(forbidden), false, `Dashboard bundle unexpectedly contains build-time Cubism token: ${forbidden}`);
}

const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/hya-live2d-corpus-dashboard/index.html',
  timeoutMs: 60_000,
  visualCapture: { viewportWidth: 1280, viewportHeight: 900, sampleWidth: 24, sampleHeight: 17 },
});
assert.equal(result.status, 'passed');
assert.equal(result.corpus, 'hya-live2d-public-v1');
assert.equal(result.bundledSamples, 1);
assert.ok(result.licenseGatedCandidates >= 1);
assert.equal(result.cubismRuntimeInBrowser, false);
assert.equal(result.runtime.state, 'ready');
assert.equal(result.runtime.drawableCount, result.metrics.drawableCount);
assert.ok(result.renderer.visualCount >= 1);
assert.ok(result.metrics.frameCount > 1);
assert.ok(result.metrics.hyaBytes > 0 && result.metrics.sidecarBytes > 0 && result.metrics.textureBytes > 0);
assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);

console.log(JSON.stringify({
  status: result.status,
  corpus: result.corpus,
  bundledSamples: result.bundledSamples,
  runtime: result.runtime,
  metrics: result.metrics,
  bundleBytes: Buffer.byteLength(bundle),
  browser: result.browserEvidence.product,
}, null, 2));
