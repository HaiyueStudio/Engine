import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { validateRiveWorkloadPlan, validateRiveWorkloadScenario } from './rive-workload-contract.mjs';

export const RIVE_G11_CORPUS_KIND = 'haiyue-rive-g11-corpus';
export const RIVE_G11_TUPLE_ID = 'rive-7.3-webgl2-2.40.0';

const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9-]*$/u;
const REVISION = /^[A-Za-z0-9._:-]{8,128}$/u;
const EXPECTED_FAMILIES = Object.freeze([
  'import-neutral-ir',
  'vector-paint-composite',
  'rig-mesh-constraint',
  'text-layout-component-asset',
  'timeline-state-machine',
  'data-interaction-accessibility',
  'audio-event',
  'scripting-custom-rendering',
]);
const EXPECTED_VERSION_CASES = Object.freeze([
  ['7.2-reject-outside-denominator', 7, 2, 'E_RIVE_FORMAT_MINOR_UNSUPPORTED'],
  ['7.3-accept', 7, 3, 'accepted'],
  ['7.4-reject', 7, 4, 'E_RIVE_FORMAT_MINOR_UNSUPPORTED'],
  ['8.0-reject', 8, 0, 'E_RIVE_FORMAT_MAJOR_UNSUPPORTED'],
]);
const SECURITY_CLASSES = Object.freeze([
  'parser', 'graph', 'expansion', 'asset', 'script', 'shader', 'event', 'lifecycle', 'audio',
]);
const REQUIRED_LICENSE_USES = Object.freeze([
  'import',
  'modificationAndDerivative',
  'automatedOracleExecution',
  'ciStorage',
  'screenshotAndAudioEvidence',
  'hyaRedistribution',
]);
const VISIBILITIES = Object.freeze([
  'public-redistributable', 'internal-evidence-only', 'local-never-upload',
]);

export function validateRiveCorpusManifest(manifest, census, {
  formal = false,
  root = null,
} = {}) {
  const violations = [];
  equal(manifest?.schemaVersion, 1, 'schemaVersion');
  equal(manifest?.kind, RIVE_G11_CORPUS_KIND, 'kind');
  string(manifest?.id, 'id');
  equal(manifest?.compatibilityTuple?.id, RIVE_G11_TUPLE_ID, 'compatibility tuple id');
  equal(manifest?.compatibilityTuple?.format?.major, 7, 'format major');
  equal(manifest?.compatibilityTuple?.format?.minor, 3, 'format minor');
  match(manifest?.compatibilityTuple?.runtimeCommit, /^[a-f0-9]{40}$/u, 'runtime commit');
  match(manifest?.compatibilityTuple?.editorExporterRevision, /^[a-f0-9]{40}$/u, 'exporter revision');
  validatePinnedFile(manifest?.compatibilityTuple, 'compatibility tuple', root);
  validatePinnedFile(manifest?.census, 'runtime census', root);
  validatePinnedFile(manifest?.g01CorpusContract, 'G01 corpus contract', root);
  validatePinnedFile(manifest?.browserRuntimeDenyList, 'browser runtime deny list', root);
  validatePinnedFile(manifest?.generatedParserCorpus, 'generated parser corpus', root);
  validatePinnedFile(manifest?.workloadPlan, 'workload plan', root);
  equal(manifest?.generatedParserCorpus?.caseCount, 19, 'generated parser corpus case count');
  equal(manifest?.generatedParserCorpus?.generator, 'scripts/hya-corpus/rive-generate-parser-corpus.mjs@1', 'generated parser corpus generator');
  equal(manifest?.workloadPlan?.contract, 'haiyue-rive-g11-workload-plan@1', 'workload plan contract');
  const workloadPlan = readWorkloadPlan(manifest?.workloadPlan, root, violations);

  equal(census?.compatibilityTupleId, RIVE_G11_TUPLE_ID, 'census tuple id');
  for (const [key, value] of Object.entries(census?.totals ?? {})) {
    equal(manifest?.census?.counts?.[key], value, `census count ${key}`);
  }
  for (const key of ['unclassifiedObjects', 'unclassifiedProperties', 'unclassifiedScripts', 'unclassifiedAssets']) {
    equal(census?.totals?.[key], 0, `census ${key}`);
  }

  const suites = list(manifest?.featureSuites, 'feature suites');
  const suiteFamilies = uniqueValues(suites, 'id', 'feature suite', violations);
  exactSet(suiteFamilies, EXPECTED_FAMILIES, 'feature suite families', violations);
  for (const suite of suites) {
    positiveInteger(suite?.minimumIsolatedFixtures, `${suite?.id} isolated minimum`);
    if (!Number.isInteger(suite?.minimumPropertyBoundaryFixtures) || suite.minimumPropertyBoundaryFixtures < 2) {
      violations.push(`${String(suite?.id)} property boundary minimum must be at least 2`);
    }
    equal(census?.familyContracts?.[suite?.id]?.goal, suite?.goal, `${suite?.id} Goal owner`);
  }

  const versions = list(manifest?.versionCases, 'version cases');
  equal(versions.length, EXPECTED_VERSION_CASES.length, 'version case count');
  for (const [id, major, minor, expected] of EXPECTED_VERSION_CASES) {
    const item = versions.find(value => value?.id === id);
    if (!item) violations.push(`missing version case ${id}`);
    else {
      equal(item.major, major, `${id} major`);
      equal(item.minor, minor, `${id} minor`);
      equal(item.expected, expected, `${id} expected result`);
    }
  }

  const securityCases = list(manifest?.securityCases, 'security cases');
  const securityIds = uniqueValues(securityCases, 'id', 'security case', violations);
  if (securityCases.length < (manifest?.minimums?.adversarialCases ?? 24)) {
    violations.push('adversarial security case count is below the frozen minimum');
  }
  for (const securityClass of SECURITY_CLASSES) {
    if (!securityCases.some(value => value?.class === securityClass)) {
      violations.push(`missing security class ${securityClass}`);
    }
  }
  for (const item of securityCases) {
    if (!ID.test(item?.id ?? '')) violations.push(`security case id is invalid: ${String(item?.id)}`);
    if (!SECURITY_CLASSES.includes(item?.class)) violations.push(`${String(item?.id)} security class is invalid`);
    if (typeof item?.expected !== 'string' || !/^E_RIVE_[A-Z0-9_]+$/u.test(item.expected)) {
      violations.push(`${String(item?.id)} expected diagnostic is invalid`);
    }
  }

  const diagnosticSources = list(manifest?.diagnosticUpstreamSources, 'diagnostic upstream sources');
  uniqueValues(diagnosticSources, 'id', 'diagnostic upstream source', violations);
  for (const source of diagnosticSources) {
    if (!ID.test(source?.id ?? '')) violations.push('diagnostic upstream source id is invalid');
    try {
      const url = new URL(source?.sourceUrl);
      if (url.protocol !== 'https:') violations.push(`${String(source?.id)} source URL must use HTTPS`);
    } catch {
      violations.push(`${String(source?.id)} source URL is invalid`);
    }
    match(source?.revision, /^[a-f0-9]{40}$/u, `${String(source?.id)} revision`);
    match(source?.archiveSha256, SHA256, `${String(source?.id)} archive hash`);
    equal(source?.license?.id, 'MIT', `${String(source?.id)} license id`);
    match(source?.license?.sha256, SHA256, `${String(source?.id)} license hash`);
    equal(source?.formalEligible, false, `${String(source?.id)} formal eligibility`);
    string(source?.disqualifier, `${String(source?.id)} formal disqualifier`);
  }

  const assets = list(manifest?.formalAssets, 'formal assets');
  uniqueValues(assets, 'id', 'formal asset', violations);
  const coverage = {
    objectKeys: new Set(), propertyKeys: new Set(), scriptModuleKeys: new Set(),
    scriptSymbolKeys: new Set(), assetTypeKeys: new Set(),
  };
  for (const [index, asset] of assets.entries()) {
    validateFormalAsset(asset, `formalAssets[${index}]`, coverage, securityIds, root, workloadPlan, violations);
  }

  const expectedCoverage = censusCoverage(census);
  const uncovered = Object.fromEntries(Object.entries(expectedCoverage).map(([key, expected]) => [
    key,
    [...expected].filter(value => !coverage[key].has(value)),
  ]));
  const extra = Object.fromEntries(Object.entries(expectedCoverage).map(([key, expected]) => [
    key,
    [...coverage[key]].filter(value => !expected.has(value)),
  ]));
  for (const [key, values] of Object.entries(extra)) {
    if (values.length > 0) violations.push(`${key} contains ${values.length} keys outside the frozen census`);
  }

  const realProduct = assets.filter(value => value?.kind === 'real-product');
  const combinedStress = assets.filter(value => value?.kind === 'combined-stress');
  const isolated = assets.filter(value => value?.kind === 'feature-isolated');
  for (const family of EXPECTED_FAMILIES) {
    if (!isolated.some(value => value?.featureFamilies?.length === 1 && value.featureFamilies[0] === family)) {
      if (formal) violations.push(`missing isolated formal asset for ${family}`);
    }
  }
  for (const product of manifest?.productCases ?? []) {
    if (!realProduct.some(value => value?.productCaseId === product.id)) {
      if (formal) violations.push(`missing real product asset for ${product.id}`);
    }
  }
  if (formal) {
    equal(manifest?.status, 'candidate-ready', 'formal manifest status');
    if (assets.length === 0) violations.push('formalAssets is empty');
    if (realProduct.length < manifest.minimums.realProductAssets) violations.push('real product asset count is below minimum');
    if (combinedStress.length < manifest.minimums.combinedStressAssets) violations.push('combined stress asset count is below minimum');
    for (const [key, values] of Object.entries(uncovered)) {
      if (values.length > 0) violations.push(`${key} has ${values.length} uncovered frozen census keys`);
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: 'haiyue-rive-g11-corpus@1',
    mode: formal ? 'formal' : 'diagnostic',
    status: violations.length === 0 ? 'passed' : 'failed',
    violations: Object.freeze(violations),
    summary: Object.freeze({
      formalAssetCount: assets.length,
      realProductAssetCount: realProduct.length,
      combinedStressAssetCount: combinedStress.length,
      isolatedAssetCount: isolated.length,
      adversarialCaseCount: securityCases.length,
      uncovered: Object.freeze(Object.fromEntries(Object.entries(uncovered).map(([key, values]) => [key, values.length]))),
      unclassifiedFailureCount: 0,
    }),
  });

  function validatePinnedFile(value, label, candidateRoot) {
    string(value?.path, `${label} path`);
    match(value?.sha256, SHA256, `${label} sha256`);
    if (!candidateRoot || typeof value?.path !== 'string') return;
    const path = safeResolve(candidateRoot, value.path, `${label} path`, violations);
    if (!path) return;
    try {
      const bytes = readFileSync(path);
      equal(bytes.byteLength, value.byteLength ?? bytes.byteLength, `${label} byte length`);
      equal(hash(bytes), value.sha256, `${label} file hash`);
    } catch (error) {
      violations.push(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function equal(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
  function match(actual, expression, label) {
    if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`);
  }
  function string(actual, label) {
    if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`);
  }
  function positiveInteger(actual, label) {
    if (!Number.isInteger(actual) || actual < 1) violations.push(`${label} must be a positive integer`);
  }
}

function validateFormalAsset(asset, path, coverage, securityIds, root, workloadPlan, violations) {
  if (!ID.test(asset?.id ?? '')) violations.push(`${path}.id is invalid`);
  if (!['feature-isolated', 'property-boundary', 'real-product', 'combined-stress', 'adversarial'].includes(asset?.kind)) {
    violations.push(`${path}.kind is invalid`);
  }
  requiredString(asset?.sourceUrlOrInternalAssetId, `${path}.sourceUrlOrInternalAssetId`, violations);
  if (!REVISION.test(asset?.riveCloudFileRevisionId ?? '')) violations.push(`${path}.riveCloudFileRevisionId is invalid`);
  const riv = asset?.riv;
  requiredString(riv?.path, `${path}.riv.path`, violations);
  if (!SHA256.test(riv?.sha256 ?? '')) violations.push(`${path}.riv.sha256 is invalid`);
  if (!Number.isSafeInteger(riv?.byteLength) || riv.byteLength < 8) violations.push(`${path}.riv.byteLength is invalid`);
  if (root && typeof riv?.path === 'string') validateAssetFile(root, riv, `${path}.riv`, violations);

  const externalAssets = Array.isArray(asset?.externalAssets) ? asset.externalAssets : [];
  for (const [index, external] of externalAssets.entries()) {
    requiredString(external?.id, `${path}.externalAssets[${index}].id`, violations);
    if (!SHA256.test(external?.sha256 ?? '')) violations.push(`${path}.externalAssets[${index}].sha256 is invalid`);
    if (!Number.isSafeInteger(external?.byteLength) || external.byteLength < 1) violations.push(`${path}.externalAssets[${index}].byteLength is invalid`);
    if (root && typeof external?.path === 'string') validateAssetFile(root, external, `${path}.externalAssets[${index}]`, violations);
  }

  const license = asset?.license;
  requiredString(license?.id, `${path}.license.id`, violations);
  requiredString(license?.evidence, `${path}.license.evidence`, violations);
  if (!VISIBILITIES.includes(license?.visibility)) violations.push(`${path}.license.visibility is invalid`);
  requiredString(license?.attribution, `${path}.license.attribution`, violations);
  for (const use of REQUIRED_LICENSE_USES) {
    if (typeof license?.allowedUses?.[use] !== 'boolean') violations.push(`${path}.license.allowedUses.${use} must be explicit`);
  }

  const families = array(asset?.featureFamilies, `${path}.featureFamilies`, violations);
  if (families.length === 0 || families.some(value => !EXPECTED_FAMILIES.includes(value))) {
    violations.push(`${path}.featureFamilies contains an invalid family`);
  }
  addCoverage(coverage.objectKeys, asset?.objectKeys, `${path}.objectKeys`, value => Number.isSafeInteger(value), violations);
  addCoverage(coverage.propertyKeys, asset?.propertyKeys, `${path}.propertyKeys`, value => Number.isSafeInteger(value), violations);
  addCoverage(coverage.scriptModuleKeys, asset?.scriptModuleKeys, `${path}.scriptModuleKeys`, value => typeof value === 'string', violations);
  addCoverage(coverage.scriptSymbolKeys, asset?.scriptSymbolKeys, `${path}.scriptSymbolKeys`, value => typeof value === 'string', violations);
  addCoverage(coverage.assetTypeKeys, asset?.assetTypeKeys, `${path}.assetTypeKeys`, value => Number.isSafeInteger(value), violations);
  requiredString(asset?.fixtureOwner, `${path}.fixtureOwner`, violations);
  requiredString(asset?.oracleTraceId, `${path}.oracleTraceId`, violations);
  const scenario = asset?.workloadScenario;
  requiredString(scenario?.path, `${path}.workloadScenario.path`, violations);
  if (!SHA256.test(scenario?.sha256 ?? '')) violations.push(`${path}.workloadScenario.sha256 is invalid`);
  if (!Number.isSafeInteger(scenario?.byteLength) || scenario.byteLength < 1) violations.push(`${path}.workloadScenario.byteLength is invalid`);
  if (root && typeof scenario?.path === 'string') {
    validateAssetFile(root, scenario, `${path}.workloadScenario`, violations);
    const scenarioPath = safeResolve(root, scenario.path, `${path}.workloadScenario.path`, violations);
    if (scenarioPath && workloadPlan) {
      try {
        const value = JSON.parse(readFileSync(scenarioPath, 'utf8'));
        const result = validateRiveWorkloadScenario(value, workloadPlan, {
          expectedAssetId: asset.id,
          expectedRivSha256: riv?.sha256,
        });
        if (result.status !== 'passed') violations.push(...result.violations.map(value => `${path}.workloadScenario: ${value}`));
      } catch (error) {
        violations.push(`${path}.workloadScenario cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (asset?.kind === 'real-product') requiredString(asset?.productCaseId, `${path}.productCaseId`, violations);
  if (asset?.kind === 'adversarial' && !securityIds.has(asset?.securityCaseId)) {
    violations.push(`${path}.securityCaseId is not declared`);
  }
}

function readWorkloadPlan(reference, root, violations) {
  if (!root || typeof reference?.path !== 'string') return null;
  const path = safeResolve(root, reference.path, 'workload plan path', violations);
  if (!path) return null;
  try {
    const plan = JSON.parse(readFileSync(path, 'utf8'));
    const result = validateRiveWorkloadPlan(plan);
    if (result.status !== 'passed') violations.push(...result.violations.map(value => `workload plan: ${value}`));
    return plan;
  } catch (error) {
    violations.push(`workload plan cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function validateAssetFile(root, file, label, violations) {
  const path = safeResolve(root, file.path, `${label}.path`, violations);
  if (!path) return;
  try {
    const bytes = readFileSync(path);
    if (statSync(path).isDirectory()) throw new Error('path is a directory');
    if (bytes.byteLength !== file.byteLength) violations.push(`${label}.byteLength does not match file`);
    if (hash(bytes) !== file.sha256) violations.push(`${label}.sha256 does not match file`);
  } catch (error) {
    violations.push(`${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function censusCoverage(census) {
  return {
    objectKeys: new Set((census?.objects ?? []).map(value => value.typeKey)),
    propertyKeys: new Set((census?.properties ?? []).map(value => value.key)),
    scriptModuleKeys: new Set((census?.scripts?.modules ?? []).map(scriptKey)),
    scriptSymbolKeys: new Set((census?.scripts?.symbols ?? []).map(scriptKey)),
    assetTypeKeys: new Set((census?.assets ?? []).map(value => value.typeKey)),
  };
}

function scriptKey(value) {
  return `${value.name}#${value.source}`;
}

function addCoverage(target, values, path, predicate, violations) {
  const items = array(values, path, violations);
  for (const value of items) {
    if (!predicate(value)) violations.push(`${path} contains an invalid key`);
    else target.add(value);
  }
}

function exactSet(actual, expected, label, violations) {
  if (actual.size !== expected.length || expected.some(value => !actual.has(value))) {
    violations.push(`${label} does not match the frozen set`);
  }
}

function uniqueValues(values, key, label, violations) {
  const result = new Set();
  for (const value of values) {
    const id = value?.[key];
    if (result.has(id)) violations.push(`duplicate ${label} ${String(id)}`);
    result.add(id);
  }
  return result;
}

function list(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function array(value, label, violations) {
  if (!Array.isArray(value)) {
    violations.push(`${label} must be an array`);
    return [];
  }
  return value;
}

function requiredString(value, label, violations) {
  if (typeof value !== 'string' || value.trim().length === 0) violations.push(`${label} is missing`);
}

function safeResolve(root, relativePath, label, violations) {
  if (typeof relativePath !== 'string' || relativePath.includes('\\') || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)) {
    violations.push(`${label} must be a relative POSIX path`);
    return null;
  }
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, relativePath);
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}${sep}`)) {
    violations.push(`${label} escapes repository root`);
    return null;
  }
  return path;
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
