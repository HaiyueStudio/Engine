import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createTarGzip } from './rive-g11-build-player-closure.mjs';

test('packed exact-HYA player tarball generation is deterministic', () => {
  const entries = [['package/player.js', Buffer.from('export const format = "HYA1";\n')]];
  const first = createTarGzip(entries);
  const second = createTarGzip(entries);
  assert.deepEqual(first, second);
  assert.match(gunzipSync(first).toString('utf8'), /HYA1/u);
});

test('packed player rejects traversal paths', () => {
  assert.throws(() => createTarGzip([['../escape', Buffer.from('x')]]), /Unsafe tar path/u);
});
