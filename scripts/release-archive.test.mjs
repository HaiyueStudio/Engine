import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createDeterministicTar, listScannableFiles } from './release-archive.mjs';

test('release tar normalizes metadata and is byte-for-byte deterministic', () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-release-archive-test-'));
  try {
    const source = resolve(temporaryRoot, 'source');
    mkdirSync(resolve(source, 'nested'), { recursive: true });
    writeFileSync(resolve(source, 'nested/data.txt'), 'release candidate\n');
    const first = resolve(temporaryRoot, 'first.tar');
    const second = resolve(temporaryRoot, 'second.tar');
    const firstResult = createDeterministicTar(first, [{ source, prefix: 'app' }]);
    const secondResult = createDeterministicTar(second, [{ source, prefix: 'app' }]);
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(readFileSync(first), readFileSync(second));
    assert.deepEqual(listScannableFiles([{ source, prefix: 'app' }]).map(file => file.path), ['app/nested/data.txt']);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('release tar rejects symlinks that escape the archive root', () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'haiyue-release-archive-link-test-'));
  try {
    const source = resolve(temporaryRoot, 'source');
    mkdirSync(source, { recursive: true });
    symlinkSync('../../outside', resolve(source, 'escape'));
    assert.throws(
      () => createDeterministicTar(resolve(temporaryRoot, 'unsafe.tar'), [{ source, prefix: 'app' }]),
      /symlink escapes its archive root/,
    );
    assert.deepEqual(listScannableFiles([{ source, prefix: 'app' }]), [{ path: 'app/escape', contents: null }]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
