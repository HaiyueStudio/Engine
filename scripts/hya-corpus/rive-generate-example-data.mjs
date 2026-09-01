import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function buildRiveFeatureCorpusSnapshot(census, censusBytes) {
  const records = [
    ...census.objects.map(value => record('object', value.typeKey, value)),
    ...census.properties.map(value => record('property', value.key, value)),
    ...census.assets.map(value => record('asset', value.typeKey, value)),
    ...census.scripts.modules.map((value, index) => record('script-module', index + 1, value)),
    ...census.scripts.symbols.map((value, index) => record('script-symbol', index + 1, value)),
  ];
  const familySummary = Object.fromEntries(Object.entries(census.familyContracts).map(([family, contract]) => {
    const familyRecords = records.filter(value => value.family === family);
    return [family, {
      ...contract,
      total: familyRecords.length,
      full: familyRecords.filter(value => value.hyaStatus === 'full').length,
      partial: familyRecords.filter(value => value.hyaStatus === 'partial').length,
      missing: familyRecords.filter(value => value.hyaStatus === 'missing').length,
    }];
  }));
  return {
    schemaVersion: 1,
    kind: 'haiyue-rive-feature-corpus-snapshot',
    compatibilityTupleId: census.compatibilityTupleId,
    source: {
      repository: census.source.repository,
      publicCommit: census.source.publicCommit,
      riveHead: census.source.riveHead,
      censusSha256: hash(censusBytes),
    },
    totals: census.totals,
    statusVocabulary: census.statusVocabulary,
    familySummary,
    recordCount: records.length,
    records,
  };
}

export function buildRiveCompareManifest(corpusManifest, workloadByPath) {
  return {
    schemaVersion: 1,
    kind: 'haiyue-rive-hya-compare-samples',
    compatibilityTupleId: corpusManifest.compatibilityTuple.id,
    oracle: {
      package: `${corpusManifest.oracle.package}@${corpusManifest.oracle.version}`,
      riveJsSha256: corpusManifest.oracle.riveJsSha256,
      riveWasmSha256: corpusManifest.oracle.riveWasmSha256,
    },
    samples: corpusManifest.formalAssets.map(asset => {
      const workload = workloadByPath.get(asset.workloadScenario.path);
      if (!workload) throw new Error(`Missing workload ${asset.workloadScenario.path}.`);
      return {
        id: asset.id,
        title: title(asset.id),
        sourceUrl: asset.riv.sourceUrl,
        sha256: asset.riv.sha256,
        byteLength: asset.riv.byteLength,
        selection: workload.selection,
        featureFamilies: [...new Set([
          ...(asset.featureFamilies ?? []),
          ...asset.evidenceRoles.map(value => value.featureFamily).filter(Boolean),
        ])].sort(),
        evidenceRoles: asset.evidenceRoles.map(value => value.id),
      };
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const censusPath = resolve(root, 'docs/for-ai/rive-hya/runtime-census.json');
  const manifestPath = resolve(root, 'animation-spec/corpus/rive/rive-g11-corpus-manifest.json');
  const censusBytes = readFileSync(censusPath);
  const census = JSON.parse(censusBytes);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const workloads = new Map(manifest.formalAssets.map(asset => [
    asset.workloadScenario.path,
    JSON.parse(readFileSync(resolve(root, asset.workloadScenario.path), 'utf8')),
  ]));
  writeJson(
    resolve(root, 'examples/rive-feature-corpus/corpus.json'),
    buildRiveFeatureCorpusSnapshot(census, censusBytes),
  );
  writeJson(
    resolve(root, 'examples/rive-hya-compare/samples.json'),
    buildRiveCompareManifest(manifest, workloads),
  );
  console.log(`[rive-examples] feature records=${census.objects.length + census.properties.length + census.assets.length + census.scripts.modules.length + census.scripts.symbols.length}; compare samples=${manifest.formalAssets.length}.`);
}

function record(kind, key, value) {
  return {
    kind,
    key,
    name: value.name,
    ...(value.owner ? { owner: value.owner } : {}),
    ...(value.extends ? { extends: value.extends } : {}),
    source: value.source,
    evidenceClass: value.evidenceClass,
    binaryEvidenceEligible: value.binaryEvidenceEligible,
    ...(value.behavioralEvidenceEligible === undefined ? {} : { behavioralEvidenceEligible: value.behavioralEvidenceEligible }),
    ...(value.serialized === undefined ? {} : { serialized: value.serialized }),
    family: value.family,
    hyaStatus: value.hyaStatus,
    goal: value.goal,
    diagnostic: value.diagnostic,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function title(value) { return value.replace(/^official-/u, '').split('-').map(word => `${word[0].toUpperCase()}${word.slice(1)}`).join(' '); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
