import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const verifierUrl = new URL('./largeScenePerformance.mjs', import.meta.url);

test('large-scene verifier resolves Editor-owned dependencies from the Editor repository', async () => {
  const source = await readFile(verifierUrl, 'utf8');

  assert.match(source, /requireStudioRepository\('Editor'\)\.root/u);
  assert.match(source, /createRequire\(resolve\(editorRepositoryRoot, 'editor\/package\.json'\)\)/u);
  assert.match(source, /editorRequire\('jszip'\)/u);
});
