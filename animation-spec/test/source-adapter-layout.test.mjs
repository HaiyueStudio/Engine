import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('source adapters expose focused lottie/live2d package facades', async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.exports['./lottie'].source, './src/lottie.ts');
  assert.equal(packageJson.exports['./live2d'].source, './src/live2d.ts');
  assert.equal(packageJson.exports['./cubism'].source, './src/cubism.ts');
  assert.equal(packageJson.bin['hya-lottie-convert'], './lottie/bin/hya-lottie-convert.mjs');
  assert.equal(packageJson.bin['hya-live2d-convert'], './live2d/bin/hya-live2d-convert.mjs');

  await Promise.all([
    access(resolve(root, 'src/lottie/index.ts')),
    access(resolve(root, 'src/lottie/merge-path.ts')),
    access(resolve(root, 'src/live2d/index.ts')),
    access(resolve(root, 'lottie/bin/hya-lottie-convert.mjs')),
    access(resolve(root, 'live2d/bin/hya-live2d-convert.mjs')),
  ]);
});

test('legacy cubism subpath remains an exact compatibility facade', async () => {
  const [live2d, cubism] = await Promise.all([
    import('../dist/live2d.js'),
    import('../dist/cubism.js'),
  ]);
  assert.deepEqual(Object.keys(cubism).sort(), Object.keys(live2d).sort());
  for (const key of Object.keys(live2d)) assert.equal(cubism[key], live2d[key], key);
});
