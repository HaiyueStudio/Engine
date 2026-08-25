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
  assert.equal(result.summary.formalAssetCount, 8);
  assert.equal(result.summary.officialAssetSourceCount, 8);
  assert.equal(result.summary.adversarialCaseCount, 28);
  assert.equal(manifest.diagnosticUpstreamSources.length, 2);
  assert.deepEqual(result.summary.uncovered, {
    objectKeys: 151,
    propertyKeys: 292,
    scriptModuleKeys: 0,
    scriptSymbolKeys: 0,
    assetTypeKeys: 4,
  });
  assert.deepEqual(result.summary.sourceAttribution, { scriptModuleKeys: 0, scriptSymbolKeys: 0 });
  assert.deepEqual(result.summary.behavioral, {
    featureFamilies: 8,
    coveredFeatureFamilies: 5,
    uncoveredFeatureFamilies: 3,
  });
});

test('diagnostic upstream repositories cannot become formal assets by implication', () => {
  const changed = structuredClone(manifest);
  changed.diagnosticUpstreamSources[0].formalEligible = true;
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('formal eligibility')));
});

test('official repository inputs require immutable paths, hashes and no-vendoring policy', () => {
  const changed = structuredClone(manifest);
  changed.officialAssetSources[0].downloadUrl = 'https://raw.githubusercontent.com/rive-app/rive-runtime/main/example.riv';
  changed.officialAssetSources[0].storagePolicy = 'repository-pinned';
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('downloadUrl is not immutable')));
  assert.ok(result.violations.some(value => value.includes('storage policy is invalid')));
});

test('an official Git formal asset identity does not require Cloud revision or a checked-in riv path', () => {
  const changed = structuredClone(manifest);
  const source = changed.officialAssetSources[0];
  changed.formalAssets.push({
    id: 'official-remote-contract-probe',
    kind: 'feature-isolated',
    sourceIdentity: { kind: 'official-git', officialAssetSourceId: source.id },
    storagePolicy: 'remote-hash-pinned-no-vendoring',
    riv: { sourceUrl: source.downloadUrl, sha256: source.sha256, byteLength: source.byteLength },
    externalAssets: [],
    license: {
      id: 'MIT',
      evidence: source.license.evidence,
      visibility: 'public-redistributable',
      attribution: 'Rive runtime official fixture, MIT',
      allowedUses: Object.fromEntries([
        'import', 'modificationAndDerivative', 'automatedOracleExecution', 'ciStorage',
        'screenshotAndAudioEvidence', 'hyaRedistribution',
      ].map(key => [key, true])),
    },
    featureFamilies: ['import-neutral-ir'],
    objectKeys: [], propertyKeys: [], scriptModuleKeys: [], scriptSymbolKeys: [], assetTypeKeys: [],
    fixtureOwner: 'G11',
    oracleTraceId: 'contract-probe',
    workloadScenario: {},
  });
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('workloadScenario')));
  assert.ok(!result.violations.some(value => value.includes('riveCloudFileRevisionId')));
  assert.ok(!result.violations.some(value => value.includes('.riv.path')));
});

test('formal corpus validation refuses admitted inputs whose traces or full coverage are incomplete', () => {
  const result = validateRiveCorpusManifest(manifest, census, { formal: true, root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('is not trace-ready')));
  assert.ok(result.violations.some(value => value.includes('uncovered binary-evidence keys')));
  assert.ok(result.violations.some(value => value.includes('uncovered feature families')));
  assert.ok(result.violations.some(value => value.includes('missing real product asset')));
});

test('source-only properties and asset bases cannot be claimed as serialized asset coverage', () => {
  const changed = structuredClone(manifest);
  changed.formalAssets[0].propertyKeys.push(9);
  changed.formalAssets[0].assetTypeKeys.push(99);
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('propertyKeys contains 1 keys outside')));
  assert.ok(result.violations.some(value => value.includes('assetTypeKeys contains 1 keys outside')));
});

test('a changed frozen source file hash is detected before corpus evidence can run', () => {
  const changed = structuredClone(manifest);
  changed.census.sha256 = '0'.repeat(64);
  const result = validateRiveCorpusManifest(changed, census, { root });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('runtime census file hash')));
});
