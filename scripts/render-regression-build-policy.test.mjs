import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectEngineRenderTargets } from './engine-release-policy.mjs';

test('render regression builds all selected targets in one checked batch', () => {
  const source = readFileSync(new URL('./verify-render-regressions.mjs', import.meta.url), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('../examples/manifest.json', import.meta.url), 'utf8'));
  const targets = selectEngineRenderTargets(manifest);
  const filter = targets.map(entry => entry.id).join(',');
  assert.deepEqual(filter.split(','), targets.map(entry => entry.id));
  assert.ok(targets.length > 0);
  assert.ok(targets.every(entry => entry.ci !== 'manual'));
  assert.match(source, /EXAMPLE_FILTER: renderTargets\.map\(entry => entry\.id\)\.join\(','\)/);
  assert.match(source, /renderTargets\.length > 0 \? \[\{/);
  assert.match(source, /timeout: exampleBuildTimeoutMs \* renderTargets\.length/);
  assert.doesNotMatch(source, /\.\.\.renderTargets\.map/);
  assert.match(source, /cmd: 'npm run typecheck'/);
  assert.match(source, /cmd: 'npm run build:engine'/);
  assert.match(source, /EXAMPLE_SHELL_ONLY: '1'/);
});
