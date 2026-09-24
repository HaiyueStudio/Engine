import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('PDF worker output does not invalidate the build, but its real input and example sources do', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'example-fingerprint-'));
  const write = async (path, value) => {
    await mkdir(resolve(root, path, '..'), { recursive: true });
    await writeFile(resolve(root, path), value);
  };
  try {
    await write('engine/package.json', JSON.stringify({ name: '@haiyue/engine', exports: { '.': { import: './dist/index.js' } } }));
    await write('engine/src/index.ts', 'export const value = 1;');
    await write('examples/page-turn-book/main.ts', 'export const page = 1;');
    await write('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'worker-v1');
    await mkdir(resolve(root, 'examples/scripts'), { recursive: true });
    for (const name of ['example-build-fingerprint.mjs', 'shared-engine-bundle.mjs']) {
      await copyFile(new URL(`../examples/scripts/${name}`, import.meta.url), resolve(root, 'examples/scripts', name));
    }
    const { computeExampleSourceFingerprint } = await import(pathToFileURL(resolve(root, 'examples/scripts/example-build-fingerprint.mjs')));
    const before = await computeExampleSourceFingerprint();
    await write('examples/page-turn-book/pdf.worker.min.mjs', 'generated-worker-output');
    assert.deepEqual(await computeExampleSourceFingerprint(), before);
    await write('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'worker-v2');
    const changedWorker = await computeExampleSourceFingerprint();
    assert.notEqual(changedWorker.hash, before.hash);
    await write('examples/page-turn-book/helper.mjs', 'real-source');
    assert.notEqual((await computeExampleSourceFingerprint()).hash, changedWorker.hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
