import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const url = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return collectTypeScriptFiles(url);
    return entry.name.endsWith('.ts') ? [url] : [];
  }));
  return nested.flat();
}

test('examples use Render3DSystem instead of the deprecated BlinnPhongRenderSystem', async () => {
  const examplesDirectory = new URL('../../examples/', import.meta.url);
  const files = await collectTypeScriptFiles(examplesDirectory);
  const offenders = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (source.includes('BlinnPhongRenderSystem')) {
      offenders.push(file.pathname);
    }
  }

  assert.deepEqual(offenders, [], 'Render3DSystem dispatches BlinnPhongMaterial automatically');
});
