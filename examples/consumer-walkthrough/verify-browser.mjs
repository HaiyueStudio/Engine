import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../../scripts/webgpu-gate/chrome-runner.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
if (!existsSync(resolve(root, 'examples/consumer-walkthrough/bundle.js'))) {
  throw new Error('Build example:consumer-walkthrough before browser verification.');
}

const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/consumer-walkthrough/index.html',
  query: { regression: 1 },
  timeoutMs: 60_000,
  visualCapture: { viewportWidth: 960, viewportHeight: 640 },
});

assert.equal(result.status, 'passed');
assert.equal(result.installed, true);
assert.equal(result.rendered, true);
assert.equal(result.assetLoaded, true);
assert.equal(result.animated, true);
assert.equal(result.disposed, true);
assert.ok(result.renderedFrames >= 8);
assert.equal(result.browserEvidence.nativeBackend, true);
assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
assert.ok(result.httpProvenance.requestCount >= 4);
for (const required of [
  'examples/consumer-walkthrough/index.html',
  'examples/shared/engine.js',
  'examples/consumer-walkthrough/bundle.js',
  'animation-spec/samples/assets/sprite1.png',
]) {
  assert.ok(
    result.httpProvenance.files.some(file => file.sourcePath === required),
    `HTTP evidence is missing ${required}.`,
  );
}
assert.ok(result.visualCapture.signature.length > 0);

console.log(JSON.stringify({
  status: result.status,
  browser: result.browserEvidence.product,
  backend: result.browserEvidence.angleBackend,
  renderedFrames: result.renderedFrames,
  disposed: result.disposed,
  httpFiles: result.httpProvenance.files.map(file => file.sourcePath),
  visual: {
    meanRgb: result.visualCapture.meanRgb,
    darkRatio: result.visualCapture.darkRatio,
    brightRatio: result.visualCapture.brightRatio,
  },
}, null, 2));
