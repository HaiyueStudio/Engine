import test from 'node:test';
import assert from 'node:assert/strict';
import { SHADER_LANGUAGE_BROWSER_DAG } from '../../scripts/shader-language-browser-dag.mjs';

test('Stage 14 browser DAG covers each historical stage exactly once', () => {
  assert.deepEqual(SHADER_LANGUAGE_BROWSER_DAG.map(entry => entry.stage), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal(new Set(SHADER_LANGUAGE_BROWSER_DAG.map(entry => entry.id)).size, 13);
  assert.ok(SHADER_LANGUAGE_BROWSER_DAG.every(entry => entry.script.startsWith('scripts/')));
  assert.ok(SHADER_LANGUAGE_BROWSER_DAG.every(entry => !entry.script.includes('verify-shader-language-stage14-dag')));
});

test('browser DAG keeps build ownership outside leaf fixtures', () => {
  assert.deepEqual(SHADER_LANGUAGE_BROWSER_DAG.find(entry => entry.stage === 4)?.dependencies, ['build:engine', 'build:extensions']);
  assert.deepEqual(SHADER_LANGUAGE_BROWSER_DAG.find(entry => entry.stage === 6)?.dependencies, ['build:motion-blur-example']);
  assert.deepEqual(SHADER_LANGUAGE_BROWSER_DAG.find(entry => entry.stage === 9)?.dependencies, ['build:engine', 'build:extensions']);
});
