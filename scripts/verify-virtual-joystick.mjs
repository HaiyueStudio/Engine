import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'artifacts/virtual-joystick');
mkdirSync(output, { recursive: true });
for (const [name, width, height] of [['portrait', 430, 860], ['landscape', 960, 540]]) {
  const result = await runChromeWebGpuFixture({ root, fixture: 'examples/virtual-joystick/index.html',
    query: { verify: 1 }, timeoutMs: 90_000,
    visualCapture: { viewportWidth: width, viewportHeight: height, sampleWidth: 48, sampleHeight: 32 } });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.errors, []);
  assert.equal(result.browserDiagnostics.unclassifiedFailureCount, 0);
  for (const key of ['fixed', 'floatingGui', 'frameEvents', 'entityMovement', 'entityHeading', 'clamped', 'multitouch', 'release', 'cancellation', 'guiCleanup']) {
    assert.equal(result.checks[key], true, `${name}: ${key}`);
  }
  assert.ok(result.visualCapture.darkRatio < 0.98, `${name}: blank render`);
  writeFileSync(resolve(output, `${name}.png`), Buffer.from(result.visualCapture.pngBase64, 'base64'));
  delete result.visualCapture.pngBase64;
  writeFileSync(resolve(output, `${name}.json`), JSON.stringify({ ...result, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`${name}: fixed/floating GUI, movement, heading, frame events, multitouch and cleanup passed`);
}
