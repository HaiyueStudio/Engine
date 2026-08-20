import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const runnerUrl = new URL('../run-benchmarks.mjs', import.meta.url);

test('CPU benchmark builds Editor testing from the split Editor repository', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.match(source, /requireStudioRepository\('Editor'\)\.root/u);
  assert.match(source, /cwd:\s*editorWorkspace/u);
  assert.doesNotMatch(source, /cwd:\s*resolve\(root, 'editor'\)/u);
});
