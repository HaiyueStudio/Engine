import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const [lottieBundle, live2dBundle] = await Promise.all([
  readFile(resolve(root, 'examples/lottie-hya-compare/bundle.js'), 'utf8'),
  readFile(resolve(root, 'examples/live2d-hya-compare/bundle.js'), 'utf8'),
]);
assert.equal(lottieBundle.includes('_expression_function'), false, 'The official light player must exclude expression eval support.');
assert.equal(live2dBundle.includes('Live2D Proprietary Software License Agreement'), false, 'The optional comparison bundle must not vendor Cubism Core.');

const [lottie, live2d] = await Promise.all([
  runChromeWebGpuFixture({ root: resolve(root, 'examples/lottie-hya-compare'), fixture: 'index.html', timeoutMs: 60_000, visualCapture: { viewportWidth: 1200, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15 } }),
  runChromeWebGpuFixture({ root: resolve(root, 'examples/live2d-hya-compare'), fixture: 'index.html', timeoutMs: 60_000, visualCapture: { viewportWidth: 1200, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15 } }),
]);
assert.equal(lottie.status, 'passed');
assert.equal(lottie.officialPlayer, 'lottie-web');
assert.ok(lottie.renderer.visualCount > 0);
assert.ok(lottie.bounds.width > 0 && lottie.bounds.height > 0);
assert.ok(lottie.bounds.width < 128 * 4 && lottie.bounds.height < 128 * 4, 'Lottie content bounds must stay near the 128x128 sample composition.');
assert.ok(lottie.autoZoom > 0.1, 'Automatic fitting must not collapse to its emergency minimum.');
assert.equal(lottie.browserDiagnostics.unclassifiedFailureCount, 0);
assert.equal(live2d.status, 'passed');
assert.equal(live2d.reference, 'captured-mesh-fixture');
assert.ok(live2d.hya.visualCount > 0);
assert.ok(live2d.bounds.width > 0 && live2d.bounds.height > 0);
assert.equal(live2d.browserDiagnostics.unclassifiedFailureCount, 0);
for (const file of live2d.httpProvenance.files) assert.ok(!/live2dcubismcore|\.moc3|\.model3\.json/iu.test(file.sourcePath), `Default fixture unexpectedly requested ${file.sourcePath}`);
console.log(JSON.stringify({
  status: 'passed',
  lottie: { visualCount: lottie.renderer.visualCount, bounds: lottie.bounds, autoZoom: lottie.autoZoom, bundleBytes: Buffer.byteLength(lottieBundle) },
  live2d: { visualCount: live2d.hya.visualCount, bounds: live2d.bounds, autoZoom: live2d.autoZoom, bundleBytes: Buffer.byteLength(live2dBundle) },
  browser: lottie.browserEvidence.product,
}, null, 2));
