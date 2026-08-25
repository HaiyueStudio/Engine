import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contractRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = resolve(contractRoot, '..', '..', '..');
const studioRoot = resolve(engineRoot, '..');

const readJson = name => JSON.parse(readFileSync(join(contractRoot, name), 'utf8'));
const compatibility = readJson('compatibility-tuple.json');
const census = readJson('runtime-census.json');
const denyList = readJson('browser-runtime-deny-list.json');
const corpus = readJson('corpus-oracle-manifest.json');
const diagnostics = readFileSync(join(contractRoot, 'diagnostic-catalog.md'), 'utf8');
const adr = readFileSync(join(engineRoot, 'docs', 'for-ai', 'adr', '0087-rive-hya-source-neutral-full-fidelity.md'), 'utf8');
const milestone = JSON.parse(readFileSync(join(studioRoot, 'milestones', 'milestones', 'm07-rive-hya-full-fidelity', 'milestone.json'), 'utf8'));

function invariant(value, message) {
  if (!value) throw new Error(message);
}

invariant(compatibility.status === 'accepted', 'Compatibility tuple must be accepted.');
invariant(compatibility.riveFormat.major === 7 && compatibility.riveFormat.minor === 3, 'Frozen format must be 7.3.');
invariant(compatibility.id === census.compatibilityTupleId, 'Census tuple id mismatch.');
invariant(compatibility.id === corpus.compatibilityTupleId, 'Corpus tuple id mismatch.');
invariant(compatibility.runtimeSource.publicCommit === census.source.publicCommit, 'Runtime source commit mismatch.');
invariant(compatibility.runtimeSource.riveHead === census.source.riveHead, 'Runtime .rive_head mismatch.');
invariant(compatibility.officialOracle.riveRuntimeHead === compatibility.runtimeSource.riveHead, 'Oracle/runtime .rive_head mismatch.');
invariant(compatibility.editorExport.editorExporterRevision === compatibility.runtimeSource.riveHead, 'Editor exporter/runtime schema revision mismatch.');
invariant(adr.includes('- 状态：Accepted'), 'ADR 0087 is not Accepted.');
for (const [name, digest] of Object.entries({
  sourceArchive: compatibility.runtimeSource.sourceArchiveSha256,
  oracleTarball: compatibility.officialOracle.tarballSha256,
  riveJs: compatibility.officialOracle.riveJsSha256,
  riveWasm: compatibility.officialOracle.riveWasmSha256,
  fallbackWasm: compatibility.officialOracle.fallbackWasmSha256,
  censusInputs: census.source.inputDigestSha256,
})) {
  invariant(/^[0-9a-f]{64}$/.test(digest), `${name} is not a lowercase SHA-256 digest.`);
}

const unique = (items, key, label) => {
  const values = items.map(key);
  invariant(new Set(values).size === values.length, `${label} contains duplicate keys.`);
};
unique(census.objects, item => item.typeKey, 'Object census');
unique(census.properties, item => item.key, 'Property census');

invariant(census.totals.objectTypes === census.objects.length, 'Object total mismatch.');
invariant(census.totals.propertyKeys === census.properties.length, 'Property total mismatch.');
invariant(census.totals.scriptModules === census.scripts.modules.length, 'Script module total mismatch.');
invariant(census.totals.scriptSymbols === census.scripts.symbols.length, 'Script symbol total mismatch.');
invariant(census.totals.assetTypes === census.assets.length, 'Asset total mismatch.');
invariant(census.totals.serializedAssetTypes === census.assets.filter(item => item.serialized).length, 'Serialized asset total mismatch.');
invariant(census.totals.unclassifiedObjects === 0, 'Unclassified object count is not zero.');
invariant(census.totals.unclassifiedProperties === 0, 'Unclassified property count is not zero.');
invariant(census.totals.unclassifiedScripts === 0, 'Unclassified script count is not zero.');
invariant(census.totals.unclassifiedAssets === 0, 'Unclassified asset count is not zero.');

const entries = [...census.objects, ...census.properties, ...census.scripts.symbols, ...census.assets];
const statusVocabulary = new Set(census.statusVocabulary);
for (const entry of entries) {
  invariant(entry.family && entry.goal && entry.diagnostic && entry.fixtureOwner, `Unowned census entry: ${entry.name}`);
  invariant(statusVocabulary.has(entry.hyaStatus), `Invalid HYA status: ${entry.hyaStatus}`);
  invariant(diagnostics.includes(`\`${entry.diagnostic}\``), `Diagnostic is not catalogued: ${entry.diagnostic}`);
}

const goals = new Map(milestone.goals.map(goal => [goal.id, goal]));
for (const contract of Object.values(census.familyContracts)) {
  invariant(goals.has(contract.goal), `Census family owner is not a milestone goal: ${contract.goal}`);
}
invariant(goals.get('g01-compatibility-license-security-contracts')?.status === 'complete', 'G01 milestone status is not complete.');
invariant(goals.get('g02-riv-import-neutral-ir')?.status === 'complete', 'G02 milestone status is not complete.');

invariant(denyList.forbiddenPackages.includes('@rive-app/webgl2'), 'Oracle package is not denied from browser closure.');
invariant(denyList.forbiddenFileGlobs.includes('**/*.riv'), 'Raw .riv is not denied from browser closure.');
invariant(corpus.productCases.length >= 4, 'At least four product cases are required.');
invariant(corpus.minimumCorpus.adversarialAssets >= 24, 'Adversarial corpus floor regressed.');
invariant(corpus.requiredAssetMetadata.includes('licenseEvidence'), 'Corpus license evidence is not required.');
invariant(corpus.requiredAssetMetadata.includes('sourceIdentity'), 'Corpus immutable source identity is not required.');
invariant(corpus.requiredAssetMetadata.includes('storagePolicy'), 'Corpus storage policy is not required.');
invariant(compatibility.officialRepositoryAssetIdentity.storagePolicy === 'remote-hash-pinned-no-vendoring', 'Official repository inputs must not be vendored.');

console.log(JSON.stringify({
  tuple: compatibility.id,
  objects: census.objects.length,
  properties: census.properties.length,
  scriptModules: census.scripts.modules.length,
  scriptSymbols: census.scripts.symbols.length,
  assets: census.assets.length,
  serializedAssets: census.assets.filter(item => item.serialized).length,
  unclassified: 0,
  g01: goals.get('g01-compatibility-license-security-contracts').status,
  g02: goals.get('g02-riv-import-neutral-ir').status,
}));
