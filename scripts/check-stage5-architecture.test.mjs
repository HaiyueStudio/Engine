import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('stage5 gate follows the shared renderer pipeline-key owner', async () => {
  const source = await readFile(new URL('./check-stage5-architecture.mjs', import.meta.url), 'utf8');
  assert.match(source, /ParameterizedRendererCore\.ts/);
  assert.match(source, /ParameterizedRendererCore pipeline keys omit the shader feature set/);
  assert.match(source, /\(\?:rendererCore\|_rendererCore\).*pipelineKey/);
  assert.doesNotMatch(source, /requireMatch\(renderer, \/encodeShaderPipelineKey/);
});
