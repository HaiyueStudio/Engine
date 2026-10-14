import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReviewArchive } from './review-archive-policy.mjs';
const base = new URL('../review/archive/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('engine-021-history-20261012.json', base)));
const bytes = readFileSync(new URL(manifest.archive, base));

test('the retained archive matches its complete checksum and inventory', () => {
  assert.equal(validateReviewArchive(manifest, bytes).files, manifest.files.length);
});
test('archive truncation or byte corruption cannot silently remove recoverable history', () => {
  assert.throws(() => validateReviewArchive(manifest, bytes.subarray(1)), /mismatch/);
  const bad = Buffer.from(bytes); bad[100] ^= 1;
  assert.throws(() => validateReviewArchive(manifest, bad), /mismatch/);
});
test('archive inventory rejects escape, duplicate and missing file identities', () => {
  for (const path of ['Engine/../../outside', 'Engine/C:/outside', 'Engine/a\\b', '/absolute', 'Engine//empty']) {
    const bad = structuredClone(manifest); bad.files[0].path = path;
    assert.throws(() => validateReviewArchive(bad, bytes), /path/);
  }
  const duplicate = structuredClone(manifest); duplicate.files[1].path = duplicate.files[0].path;
  assert.throws(() => validateReviewArchive(duplicate, bytes), /duplicate/);
  assert.throws(() => validateReviewArchive({ ...manifest, files: [] }, bytes), /inventory/);
});
