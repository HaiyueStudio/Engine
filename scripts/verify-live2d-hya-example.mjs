import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const exampleRoot = resolve(root, 'examples/live2d-hya');
const bundle = await readFile(resolve(exampleRoot, 'bundle.js'), 'utf8');
for (const forbidden of ['Live2DCubismCore', 'Moc.fromArrayBuffer', '.moc3', '.model3.json', 'convertCubismCaptureToHya']) {
  assert.equal(bundle.includes(forbidden), false, `Browser bundle unexpectedly contains build-time Cubism token: ${forbidden}`);
}
const result = await runChromeWebGpuFixture({ root: exampleRoot, fixture: 'index.html', timeoutMs: 60_000 });
assert.equal(result.status, 'passed');
assert.equal(result.cubismRuntimeInBrowser, false);
assert.equal(result.runtime.state, 'ready');
assert.equal(result.runtime.drawableCount, 1);
assert.ok(result.renderer.visualCount >= 1);
assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify({ status: result.status, runtime: result.runtime, renderer: result.renderer, bundleBytes: Buffer.byteLength(bundle), browser: result.browserEvidence.product }, null, 2));
