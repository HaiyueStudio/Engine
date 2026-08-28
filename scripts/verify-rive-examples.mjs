import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const path of [
  'examples/shared/engine.js',
  'examples/rive-feature-corpus/bundle.js',
  'examples/rive-hya-compare/bundle.js',
]) if (!existsSync(resolve(root, path))) throw new Error(`Build Rive examples before verification: missing ${path}.`);

const samples = JSON.parse(readFileSync(resolve(root, 'examples/rive-hya-compare/samples.json'), 'utf8'));
const corpus = JSON.parse(readFileSync(resolve(root, 'examples/rive-feature-corpus/corpus.json'), 'utf8'));
assert.equal(samples.oracle.package, '@rive-app/webgl2@2.40.0');
assert.equal(samples.samples.length, 8);
assert.equal(corpus.recordCount, 1_317);

const corpusResult = await runChromeWebGpuFixture({
  root, fixture: 'examples/rive-feature-corpus/index.html', timeoutMs: 60_000,
  acceptedStatuses: ['passed'], visualCapture: { viewportWidth: 1440, viewportHeight: 900, sampleWidth: 24, sampleHeight: 15 },
});
const compareResult = await runChromeWebGpuFixture({
  root, fixture: 'examples/rive-hya-compare/index.html', timeoutMs: 120_000,
  acceptedStatuses: ['official-only'], visualCapture: { viewportWidth: 1280, viewportHeight: 760, sampleWidth: 24, sampleHeight: 15 },
  crossOriginIsolation: false,
});
assert.equal(corpusResult.recordCount, 1_317);
assert.equal(compareResult.oracle, '@rive-app/webgl2@2.40.0');
assert.equal(compareResult.hyaLoaded, false);
assert.match(compareResult.rivSha256, /^[a-f0-9]{64}$/u);
console.log(`[rive-examples] browser passed; corpus=${corpusResult.recordCount}; official=${compareResult.assetId}; hyaLoaded=${compareResult.hyaLoaded}.`);
