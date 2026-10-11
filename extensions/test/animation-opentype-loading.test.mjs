import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const scenario of ['idle', 'shared', 'failure', 'destroy', 'face-failure', 'unsupported', 'late-visual']) {
  test(`OpenType font preparation: ${scenario}`, () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./fixtures/animation-opentype-loading.mjs', import.meta.url)),
      scenario,
    ], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
