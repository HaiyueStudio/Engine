import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { comparePortablePixelRecords } from './portable-pixels.mjs';
const record = pixels => ({ hash: 'diagnostic', visual: { width: 100, height: 1, encoding: 'deflate-rgba8', rgba: deflateSync(Buffer.from(pixels)).toString('base64') } });
const source = Array.from({ length: 400 }, (_, i) => i % 4 === 3 ? 255 : 120);
test('pixel comparison ignores PNG encoding but checks every channel', () => {
  const base = record(source);
  assert.equal(comparePortablePixelRecords({ ...base, hash: 'different-compression' }, base).status, 'passed');
  assert.equal(comparePortablePixelRecords(record(source.map(v => v === 255 ? 255 : v + 1)), base).status, 'passed');
  for (const pixels of [source.map((v,i) => i % 4 === 3 ? v : 0), source.map((v,i) => i < 40 ? 255 : v), source.map((v,i) => i % 4 === 3 ? 0 : v)]) {
    assert.equal(comparePortablePixelRecords(record(pixels), base).status, 'failed');
  }
  assert.throws(() => comparePortablePixelRecords(base, {}), /baseline/);
  assert.throws(() => comparePortablePixelRecords(record([1,2]), base), /length/);
});
