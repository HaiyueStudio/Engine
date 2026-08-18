import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('representative render gate retains decoded motion-blur pixel differences', async () => {
  const [packageJson, verifier] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('scripts/verify-motion-blur-example.mjs', root), 'utf8'),
  ]);
  assert.match(packageJson.scripts['verify:render'], /npm run verify:motion-blur/);
  assert.match(packageJson.scripts['verify:motion-blur'], /build:target -- example:motion-blur/);
  assert.match(packageJson.scripts['verify:motion-blur'], /verify-motion-blur-example\.mjs/);
  assert.match(verifier, /decodePng/);
  assert.match(verifier, /changedPixelRatio/);
  assert.match(verifier, /meanAbsoluteDifference/);
  assert.match(verifier, /centeredVsReconstructed/);
  assert.match(verifier, /pipelineWarmupMs/);
  assert.match(verifier, /p95Ms/);
});
