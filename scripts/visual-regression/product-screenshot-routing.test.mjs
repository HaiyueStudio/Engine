import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const verifierUrl = new URL('../verify-product-screenshot-regressions.mjs', import.meta.url);

test('product screenshot verifier mounts the split Games repository', async () => {
  const source = await readFile(verifierUrl, 'utf8');

  assert.match(source, /resolveStudioRepositoryPath\('Games', 'games'\)/u);
  assert.match(source, /prefix:\s*['"]\/games['"]/u);
});
