import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('build-target validates game ids against the migrated Games manifest', () => {
  const result = spawnSync(process.execPath, ['scripts/build-target.mjs', 'game:not-a-real-game'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown game target "not-a-real-game"/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ENOENT/);
});

test('build-target still validates example ids in the Engine manifest', () => {
  const result = spawnSync(process.execPath, ['scripts/build-target.mjs', 'example:not-a-real-example'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown example target "not-a-real-example"/);
});
