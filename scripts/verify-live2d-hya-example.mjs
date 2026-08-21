import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseAnimation } from '@haiyue/animation-spec';
import { createDeformableMesh2DFormatRegistry } from '@haiyue/animation-spec/deformable2d';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(import.meta.dirname, '..');
const exampleRoot = resolve(root, 'examples/live2d-hya');
const bundle = await readFile(resolve(exampleRoot, 'bundle.js'), 'utf8');
for (const forbidden of ['Live2DCubismCore', 'Moc.fromArrayBuffer', '.moc3', '.model3.json', 'convertCubismCaptureToHya']) {
  assert.equal(bundle.includes(forbidden), false, `Browser bundle unexpectedly contains build-time Cubism token: ${forbidden}`);
}
assert.match(
  bundle,
  /HYA deformable mesh runtime'\)\.addComponent\(new Transform2D\(\)\)/u,
  'The bundled deformable runtime must preserve the owner Transform2D chain.',
);
assert.match(
  bundle,
  /label: `DeformableMesh2D:\$\{resource\.id\}`,[\s\S]{0,500}?format: 'rgba8unorm'/u,
  'The bundled deformable runtime must preserve display-encoded Live2D texture colors.',
);

const compareRoot = resolve(root, 'examples/live2d-hya-compare/samples');
const [offlineHya, compareHya, offlineData, compareData, offlineTexture, compareTexture] = await Promise.all([
  readFile(resolve(exampleRoot, 'assets/mascot.hya')),
  readFile(resolve(compareRoot, 'mascot.hya')),
  readFile(resolve(exampleRoot, 'assets/mascot.hydm')),
  readFile(resolve(compareRoot, 'mascot.hydm')),
  readFile(resolve(exampleRoot, 'assets/mascot.png')),
  readFile(resolve(compareRoot, 'mascot.png')),
]);
assert.deepEqual(offlineData, compareData, 'Offline and comparison examples must share identical HYDM data.');
assert.deepEqual(offlineTexture, compareTexture, 'Offline and comparison examples must share identical texture bytes.');
assert.deepEqual(
  normalizedHya(offlineHya),
  normalizedHya(compareHya),
  'Offline and comparison HYA documents may differ only by relative resource directory.',
);
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/live2d-hya/index.html',
  timeoutMs: 60_000,
});
assert.equal(result.status, 'passed');
assert.equal(result.cubismRuntimeInBrowser, false);
assert.equal(result.runtime.state, 'ready');
assert.equal(result.runtime.drawableCount, 1);
assert.ok(result.renderer.visualCount >= 1);
assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
console.log(JSON.stringify({ status: result.status, runtime: result.runtime, renderer: result.renderer, bundleBytes: Buffer.byteLength(bundle), browser: result.browserEvidence.product }, null, 2));

function normalizedHya(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const animation = parseAnimation(buffer, { extensions: createDeformableMesh2DFormatRegistry() });
  return JSON.parse(JSON.stringify({
    ...animation,
    resources: animation.resources.map(resource => ({ ...resource, uri: basename(resource.uri) })),
  }));
}
