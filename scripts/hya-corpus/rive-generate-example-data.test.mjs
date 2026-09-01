import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildRiveCompareManifest, buildRiveFeatureCorpusSnapshot } from './rive-generate-example-data.mjs';

const root = resolve(import.meta.dirname, '../..');

test('Rive example data is a deterministic projection of the frozen census and formal asset manifest', () => {
  const censusBytes = readFileSync(resolve(root, 'docs/for-ai/rive-hya/runtime-census.json'));
  const census = JSON.parse(censusBytes);
  const manifest = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json'), 'utf8'));
  const workloads = new Map(manifest.formalAssets.map(asset => [
    asset.workloadScenario.path,
    JSON.parse(readFileSync(resolve(root, asset.workloadScenario.path), 'utf8')),
  ]));
  const expectedCorpus = buildRiveFeatureCorpusSnapshot(census, censusBytes);
  const expectedSamples = buildRiveCompareManifest(manifest, workloads);
  const actualCorpus = JSON.parse(readFileSync(resolve(root, 'examples/rive-feature-corpus/corpus.json'), 'utf8'));
  const actualSamples = JSON.parse(readFileSync(resolve(root, 'examples/rive-hya-compare/samples.json'), 'utf8'));
  assert.deepEqual(actualCorpus, expectedCorpus);
  assert.deepEqual(actualSamples, expectedSamples);
  assert.equal(actualCorpus.recordCount, 1_317);
  assert.equal(actualSamples.samples.length, 8);
  assert.equal(new Set(actualCorpus.records.map(value => `${value.kind}:${value.key}`)).size, actualCorpus.recordCount);
  assert.deepEqual(new Set(actualCorpus.records.map(value => value.hyaStatus)), new Set(['full', 'partial', 'missing']));
  for (const name of ['NestedArtboard', 'NestedArtboardLeaf', 'NestedArtboardLayout', 'StateMachineListenerSingle', 'ListenerBoolChange']) {
    assert.equal(actualCorpus.records.find(value => value.kind === 'object' && value.name === name)?.hyaStatus, 'partial');
  }
  assert.deepEqual(actualSamples.samples.find(value => value.id === 'official-eight-planets-grid')?.featureFamilies, [
    'data-interaction-accessibility', 'import-neutral-ir', 'rig-mesh-constraint',
    'text-layout-component-asset', 'timeline-state-machine', 'vector-paint-composite',
  ]);
});
