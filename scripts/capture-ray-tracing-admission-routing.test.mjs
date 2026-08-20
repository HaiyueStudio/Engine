import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const captureUrl = new URL('./capture-ray-tracing-admission.mjs', import.meta.url);

test('ray admission capture confines Games content to an identity-validated mount', async () => {
  const source = await readFile(captureUrl, 'utf8');

  assert.match(source, /requireStudioRepository\('Games'\)\.root/u);
  assert.match(source, /root:\s*engineRoot/u);
  assert.match(source, /prefix:\s*'\/Games\/games'/u);
  assert.match(source, /resolveStudioRepositoryPath\('Games', 'games'\)/u);
  assert.doesNotMatch(source, /root:\s*studioRoot/u);
});
