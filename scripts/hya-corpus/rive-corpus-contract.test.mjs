import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiveCorpusManifest } from './rive-corpus-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json'), 'utf8'));
const census = JSON.parse(readFileSync(resolve(root, manifest.census.path), 'utf8'));

test('G11 corpus diagnostic contract binds the frozen tuple, census, policy hashes and threat classes', () => {
  const result = validateRiveCorpusManifest(manifest, census, { root });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
  assert.equal(result.summary.formalAssetCount, 0);
  assert.equal(result.summary.adversarialCaseCount, 28);
  assert.equal(manifest.diagnosticUpstreamSources.length, 2);
  assert.deepEqual(result.summary.uncovered, {
    objectKeys: 288,
    propertyKeys: 611,
    scriptModuleKeys: 48,
    scriptSymbolKeys: 349,
    assetTypeKeys: 14,
  });
});

test('diagnostic upstream repositories cannot become formal assets by implication', () => {
  const changed = structuredClone(manifest);
  changed.diagnosticUpstreamSources[0].formalEligible = true;
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('formal eligibility')));
});

test('formal corpus validation refuses empty or incomplete licensed evidence', () => {
  const result = validateRiveCorpusManifest(manifest, census, { formal: true, root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.includes('formalAssets is empty'));
  assert.ok(result.violations.some(value => value.includes('uncovered frozen census keys')));
  assert.ok(result.violations.some(value => value.includes('missing real product asset')));
});

test('a changed frozen source file hash is detected before corpus evidence can run', () => {
  const changed = structuredClone(manifest);
  changed.census.sha256 = '0'.repeat(64);
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('runtime census file hash')));
});
