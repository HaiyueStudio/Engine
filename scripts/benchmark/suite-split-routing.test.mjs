import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const suiteUrl = new URL('./suite.mjs', import.meta.url);

test('benchmark suite imports Editor testing from the split Editor repository', async () => {
  const source = await readFile(suiteUrl, 'utf8');

  assert.match(source, /resolveStudioRepositoryPath\('Editor', 'editor\/dist-test\/testing\.js'\)/u);
  assert.doesNotMatch(source, /\.\.\/\.\.\/editor\/dist-test\/testing\.js/u);
});

test('editor churn teardown tolerates setup failure', async () => {
  const source = await readFile(suiteUrl, 'utf8');

  assert.match(source, /state\?\.session\?\.close\(\)/u);
  assert.match(source, /if \(state && 'originalWindow' in state\)/u);
});
