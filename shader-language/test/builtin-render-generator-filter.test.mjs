import assert from 'node:assert/strict';
import test from 'node:test';
import { generateBuiltinRenderProduction } from '../scripts/generate-builtin-render-production.mjs';

test('focused builtin generation validates one complete family without consuming unrelated 2D inputs', async () => {
  const result = await generateBuiltinRenderProduction({ onlyFamily: 'simple-3d' });
  assert.deepEqual(result.families.map(family => family.id), ['simple-3d']);
  assert.equal(result.passCount, 4);
  assert.equal(result.outputCount, 5, 'all four passes and their joint artifact must stay atomic');
});

test('unknown builtin family is rejected instead of silently generating nothing', async () => {
  await assert.rejects(generateBuiltinRenderProduction({ onlyFamily: 'missing' }), /Unknown builtin render family/);
});
