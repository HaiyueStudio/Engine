import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL('package.json', root), 'utf8'),
);
const slowChecks = await readFile(
  new URL('scripts/run-slow-checks.mjs', root),
  'utf8',
);
const releasePolicy = await readFile(
  new URL('scripts/release-gate-policy.mjs', root),
  'utf8',
);
const browserFixture = await readFile(
  new URL('scripts/webgpu-gate/lighting-scaling-fixture.mjs', root),
  'utf8',
);
const verifier = await readFile(
  new URL('scripts/verify-webgpu-lighting-scaling-fixture.mjs', root),
  'utf8',
);

test('lighting scaling gate keeps the reviewed representative WebGPU case', () => {
  const command = packageJson.scripts?.['verify:lighting-scaling'];
  assert.equal(typeof command, 'string');
  for (const token of [
    'scripts/verify-webgpu-lighting-scaling-fixture.mjs',
    '--lights=128',
    '--overlap=high',
    '--dynamic=1',
    '--views=4',
    '--resolution=720p',
    '--warmup=4',
    '--samples=8',
    '--gpu-samples=2',
  ]) {
    assert.match(command, new RegExp(escapeRegExp(token)));
  }
});

test('lighting scaling gate remains in slow and full release paths', () => {
  assert.match(
    packageJson.scripts?.['verify:render'] ?? '',
    /npm run verify:lighting-scaling/,
  );
  assert.match(slowChecks, /\['run', 'verify:render'\]/);
  assert.match(
    packageJson.scripts?.['release:check'] ?? '',
    /scripts\/release-gate\.mjs --global/,
  );
  assert.match(
    releasePolicy,
    /Object\.freeze\(\['run', 'check:slow', '--', '--content-tier=full'\]\)/,
  );
});

test('lighting browser gate fetches and validates the real scene before setup', () => {
  assert.match(browserFixture, /fetchAndParseBilliardsScene\(/);
  assert.match(browserFixture, /parseBilliards3DSceneDocument/);
  assert.match(browserFixture, /fetch\(url,\s*\{\s*cache:\s*'no-store'\s*\}\)/);
  assert.match(
    browserFixture,
    /await fetchAndParseBilliardsScene[\s\S]*if \(!navigator\.gpu\)/,
  );
  assert.match(
    browserFixture,
    /lightingFixture:\s*configuration,\s*lightingSceneDocument/,
  );
  assert.match(
    browserFixture,
    /performance\.getEntriesByName\(lightingSceneUrl\.href\)\.length/,
  );
});

test('lighting verifier writes the validated representative artifact', () => {
  assert.match(
    verifier,
    /artifacts\/webgpu\/lighting-scaling\.json/,
  );
  assert.match(
    verifier,
    /validateLightingScalingResult\(result\)[\s\S]*writeFileSync\(artifactPath/,
  );
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
