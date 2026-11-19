import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('physical device startup reaches its explicit Chrome prerequisite from an unrelated directory', {
  skip: !['win32', 'darwin'].includes(process.platform),
}, () => {
  const folder = mkdtempSync(join(tmpdir(), 'g07-device-startup-'));
  try {
    const kit = join(folder, 'device kit');
    mkdirSync(join(kit, 'dist'), { recursive: true });
    writeFileSync(join(kit, 'manifest.json'), JSON.stringify({ diagnostic: false, revision: 'a'.repeat(40), files: {} }));
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dirname, '../../verify-visual-novel-acceptance.mjs'),
      'device', '--host', process.platform === 'win32' ? 'windows' : 'mac', '--artifact', kit,
    ], { cwd: folder, encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, CHROME_PATH: join(folder, 'chrome-not-installed') } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set CHROME_PATH to the installed Chrome executable/);
    assert.doesNotMatch(result.stderr, /ReferenceError|before initialization/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
