import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

test('representative render gate retains clipping and first-person browser coverage', async () => {
  const [packageJson, clippingVerifier, firstPersonVerifier, clippingExample, firstPersonRegression] = await Promise.all([
    readFile(new URL('package.json', root), 'utf8').then(JSON.parse),
    readFile(new URL('scripts/verify-clipping-planes-example.mjs', root), 'utf8'),
    readFile(new URL('scripts/verify-navmesh-first-person-example.mjs', root), 'utf8'),
    readFile(new URL('examples/clipping-planes/main.ts', root), 'utf8'),
    readFile(new URL('examples/navmesh-first-person/browserRegression.ts', root), 'utf8'),
  ]);

  assert.match(packageJson.scripts['verify:render'], /npm run verify:clipping-planes/);
  assert.match(packageJson.scripts['verify:render'], /npm run verify:navmesh-first-person/);
  assert.match(packageJson.scripts['verify:clipping-planes'], /build:target -- example:clipping-planes/);
  assert.match(packageJson.scripts['verify:navmesh-first-person'], /build:target -- example:navmesh-first-person/);
  assert.match(clippingVerifier, /offVsThreePlanes/);
  assert.match(clippingVerifier, /threePlanesVsMovedPlane/);
  assert.match(clippingVerifier, /changedPixelRatio/);
  assert.match(clippingExample, /pushErrorScope\('validation'\)/);
  assert.match(firstPersonVerifier, /fellThroughHole/);
  assert.match(firstPersonVerifier, /disposeStoppedInput/);
  assert.match(firstPersonRegression, /new KeyboardEvent/);
  assert.match(firstPersonRegression, /controls\.dispose\(\)/);
});

test('shared Chrome runner bounds every DevTools call used by visual gates', async () => {
  const source = await readFile(new URL('scripts/webgpu-gate/chrome-runner.mjs', root), 'utf8');
  assert.match(source, /connectCdp\(page\.webSocketDebuggerUrl, Math\.min\(timeoutMs, 30_000\)\)/);
  assert.match(source, /Chrome DevTools call timed out after \$\{callTimeoutMs\}ms: \$\{method\}/);
  assert.match(source, /clearTimeout\(request\.timeout\)/);
});
