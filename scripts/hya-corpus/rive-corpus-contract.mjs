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
const STORAGE_POLICIES = Object.freeze([
  'repository-pinned', 'remote-hash-pinned-no-vendoring', 'local-never-upload',
]);
const EVIDENCE_ROLE_KINDS = Object.freeze([
  'feature-witness', 'property-boundary', 'product-witness', 'combined-stress', 'adversarial',
]);
const OFFICIAL_RIVE_REPOSITORY = 'https://github.com/rive-app/rive-runtime';

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
  validateCoverageModel(manifest?.coverageModel, census, violations);

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
  positiveInteger(manifest?.minimums?.realProductWitnesses, 'real product witness minimum');
  positiveInteger(manifest?.minimums?.combinedStressWitnesses, 'combined stress witness minimum');
  equal(manifest?.minimums?.requiredPhysicalDevices, 2, 'required physical device count');

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

  const officialSources = list(manifest?.officialAssetSources, 'official asset sources');
  const officialSourceIds = uniqueValues(officialSources, 'id', 'official asset source', violations);
  const officialSourcesById = new Map(officialSources.map(value => [value?.id, value]));
  for (const source of officialSources) validateOfficialAssetSource(source, violations);

  const assets = list(manifest?.formalAssets, 'formal assets');
  uniqueValues(assets, 'id', 'formal asset', violations);
  const productCasesById = new Map((manifest?.productCases ?? []).map(value => [value?.id, value]));
  const coverage = {
    objectKeys: new Set(), propertyKeys: new Set(), scriptModuleKeys: new Set(),
    scriptSymbolKeys: new Set(), assetTypeKeys: new Set(), featureFamilies: new Set(),
  };
  for (const [index, asset] of assets.entries()) {
    validateFormalAsset(asset, `formalAssets[${index}]`, coverage, securityIds, root, workloadPlan, officialSourcesById, productCasesById, formal, violations);
  }

  const allowedCoverage = sourceCensusCoverage(census);
  const expectedCoverage = binaryEvidenceCoverage(census);
  const uncovered = Object.fromEntries(Object.entries(expectedCoverage).map(([key, expected]) => [
    key,
    [...expected].filter(value => !coverage[key].has(value)),
  ]));
  const extra = Object.fromEntries(Object.entries(allowedCoverage).map(([key, expected]) => [
    key,
    [...coverage[key]].filter(value => !expected.has(value)),
  ]));
  for (const [key, values] of Object.entries(extra)) {
    if (values.length > 0) violations.push(`${key} contains ${values.length} keys outside the frozen census`);
  }
  const uncoveredBehavioralFeatureFamilies = EXPECTED_FAMILIES.filter(value => !coverage.featureFamilies.has(value));

  const evidenceRoles = assets.flatMap(asset => (asset?.evidenceRoles ?? []).map(role => ({ asset, role })));
  const productWitnesses = evidenceRoles.filter(value => value.role?.kind === 'product-witness');
  const combinedStressWitnesses = evidenceRoles.filter(value => value.role?.kind === 'combined-stress');
  const featureWitnesses = evidenceRoles.filter(value => value.role?.kind === 'feature-witness');
  for (const family of EXPECTED_FAMILIES) {
    if (!featureWitnesses.some(value => value.role?.featureFamily === family)) {
      if (formal) violations.push(`missing formal feature witness for ${family}`);
    }
  }
  for (const product of manifest?.productCases ?? []) {
    if (!productWitnesses.some(value => value.role?.productCaseId === product.id)) {
      if (formal) violations.push(`missing formal product witness for ${product.id}`);
    }
  }
  if (formal) {
    equal(manifest?.status, 'candidate-ready', 'formal manifest status');
    if (assets.length === 0) violations.push('formalAssets is empty');
    if (productWitnesses.length < manifest.minimums.realProductWitnesses) violations.push('real product witness count is below minimum');
    if (combinedStressWitnesses.length < manifest.minimums.combinedStressWitnesses) violations.push('combined stress witness count is below minimum');
    for (const [key, values] of Object.entries(uncovered)) {
      if (values.length > 0) violations.push(`${key} has ${values.length} uncovered binary-evidence keys`);
    }
    if (uncoveredBehavioralFeatureFamilies.length > 0) {
      violations.push(`behavioralFeatureFamilies has ${uncoveredBehavioralFeatureFamilies.length} uncovered feature families`);
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
      officialAssetSourceCount: officialSourceIds.size,
      evidenceRoleCount: evidenceRoles.length,
      realProductWitnessCount: productWitnesses.length,
      combinedStressWitnessCount: combinedStressWitnesses.length,
      featureWitnessCount: featureWitnesses.length,
      adversarialCaseCount: securityCases.length,
      uncovered: Object.freeze(Object.fromEntries(Object.entries(uncovered).map(([key, values]) => [key, values.length]))),
      sourceAttribution: Object.freeze({
        scriptModuleKeys: coverage.scriptModuleKeys.size,
        scriptSymbolKeys: coverage.scriptSymbolKeys.size,
      }),
      behavioral: Object.freeze({
        featureFamilies: EXPECTED_FAMILIES.length,
        coveredFeatureFamilies: coverage.featureFamilies.size,
        uncoveredFeatureFamilies: uncoveredBehavioralFeatureFamilies.length,
      }),
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

function validateFormalAsset(asset, path, coverage, securityIds, root, workloadPlan, officialSourcesById, productCasesById, formal, violations) {
  if (!ID.test(asset?.id ?? '')) violations.push(`${path}.id is invalid`);
  if (!['feature-isolated', 'property-boundary', 'real-product', 'combined-stress', 'adversarial'].includes(asset?.kind)) {
    violations.push(`${path}.kind is invalid`);
  }
  const sourceIdentity = asset?.sourceIdentity;
  if (sourceIdentity?.kind === 'official-git') {
    requiredString(sourceIdentity?.officialAssetSourceId, `${path}.sourceIdentity.officialAssetSourceId`, violations);
    const officialSource = officialSourcesById.get(sourceIdentity?.officialAssetSourceId);
    if (!officialSource) {
      violations.push(`${path}.sourceIdentity.officialAssetSourceId is not declared`);
    } else {
      if (asset?.riv?.sourceUrl !== officialSource.downloadUrl) violations.push(`${path}.riv.sourceUrl does not match official source`);
      if (asset?.riv?.sha256 !== officialSource.sha256) violations.push(`${path}.riv.sha256 does not match official source`);
      if (asset?.riv?.byteLength !== officialSource.byteLength) violations.push(`${path}.riv.byteLength does not match official source`);
    }
    if (asset?.storagePolicy !== 'remote-hash-pinned-no-vendoring') {
      violations.push(`${path}.storagePolicy must forbid vendoring for an official Git source`);
    }
  } else if (sourceIdentity?.kind === 'rive-cloud') {
    requiredString(asset?.sourceUrlOrInternalAssetId, `${path}.sourceUrlOrInternalAssetId`, violations);
    if (!REVISION.test(sourceIdentity?.riveCloudFileRevisionId ?? '')) {
      violations.push(`${path}.sourceIdentity.riveCloudFileRevisionId is invalid`);
    }
  } else {
    violations.push(`${path}.sourceIdentity.kind is invalid`);
  }
  if (!STORAGE_POLICIES.includes(asset?.storagePolicy)) violations.push(`${path}.storagePolicy is invalid`);
  const riv = asset?.riv;
  if (typeof riv?.path !== 'string' && typeof riv?.sourceUrl !== 'string') {
    violations.push(`${path}.riv requires path or sourceUrl`);
  }
  if (typeof riv?.sourceUrl === 'string') validateHttpsUrl(riv.sourceUrl, `${path}.riv.sourceUrl`, violations);
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
  for (const family of families) coverage.featureFamilies.add(family);
  const roles = array(asset?.evidenceRoles, `${path}.evidenceRoles`, violations);
  uniqueValues(roles, 'id', `${path} evidence role`, violations);
  if (roles.length === 0) violations.push(`${path}.evidenceRoles must not be empty`);
  addCoverage(coverage.objectKeys, asset?.objectKeys, `${path}.objectKeys`, value => Number.isSafeInteger(value), violations);
  addCoverage(coverage.propertyKeys, asset?.propertyKeys, `${path}.propertyKeys`, value => Number.isSafeInteger(value), violations);
  addCoverage(coverage.scriptModuleKeys, asset?.scriptModuleKeys, `${path}.scriptModuleKeys`, value => typeof value === 'string', violations);
  addCoverage(coverage.scriptSymbolKeys, asset?.scriptSymbolKeys, `${path}.scriptSymbolKeys`, value => typeof value === 'string', violations);
  addCoverage(coverage.assetTypeKeys, asset?.assetTypeKeys, `${path}.assetTypeKeys`, value => Number.isSafeInteger(value), violations);
  requiredString(asset?.fixtureOwner, `${path}.fixtureOwner`, violations);
  requiredString(asset?.oracleTraceId, `${path}.oracleTraceId`, violations);
  equalEvidenceStatus(asset?.officialOracleEvidence?.status, ['loaded'], `${path}.officialOracleEvidence.status`, violations);
  requiredString(asset?.officialOracleEvidence?.resultSelector, `${path}.officialOracleEvidence.resultSelector`, violations);
  equalEvidenceStatus(asset?.officialOracleCrossBrowserEvidence?.status, ['loaded'], `${path}.officialOracleCrossBrowserEvidence.status`, violations);
  requiredString(asset?.officialOracleCrossBrowserEvidence?.resultSelector, `${path}.officialOracleCrossBrowserEvidence.resultSelector`, violations);
  equalEvidenceStatus(asset?.featureCoverageEvidence?.status, ['captured', 'blocked-by-strict-import'], `${path}.featureCoverageEvidence.status`, violations);
  requiredString(asset?.featureCoverageEvidence?.resultSelector, `${path}.featureCoverageEvidence.resultSelector`, violations);
  for (const [value, label] of [
    [asset?.officialOracleEvidence, `${path}.officialOracleEvidence`],
    [asset?.officialOracleCrossBrowserEvidence, `${path}.officialOracleCrossBrowserEvidence`],
    [asset?.featureCoverageEvidence, `${path}.featureCoverageEvidence`],
  ]) {
    requiredString(value?.path, `${label}.path`, violations);
    if (!SHA256.test(value?.sha256 ?? '')) violations.push(`${label}.sha256 is invalid`);
    if (!Number.isSafeInteger(value?.byteLength) || value.byteLength < 1) violations.push(`${label}.byteLength is invalid`);
    if (root && typeof value?.path === 'string') validateAssetFile(root, value, label, violations);
  }
  const scenario = asset?.workloadScenario;
  requiredString(scenario?.path, `${path}.workloadScenario.path`, violations);
  if (!SHA256.test(scenario?.sha256 ?? '')) violations.push(`${path}.workloadScenario.sha256 is invalid`);
  if (!Number.isSafeInteger(scenario?.byteLength) || scenario.byteLength < 1) violations.push(`${path}.workloadScenario.byteLength is invalid`);
  let scenarioValue = null;
  if (root && typeof scenario?.path === 'string') {
    validateAssetFile(root, scenario, `${path}.workloadScenario`, violations);
    const scenarioPath = safeResolve(root, scenario.path, `${path}.workloadScenario.path`, violations);
    if (scenarioPath && workloadPlan) {
      try {
        scenarioValue = JSON.parse(readFileSync(scenarioPath, 'utf8'));
        const result = validateRiveWorkloadScenario(scenarioValue, workloadPlan, {
          expectedAssetId: asset.id,
          expectedRivSha256: riv?.sha256,
        });
        if (result.status !== 'passed') violations.push(...result.violations.map(value => `${path}.workloadScenario: ${value}`));
      } catch (error) {
        violations.push(`${path}.workloadScenario cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const scenarioActionKinds = scenarioValue
    ? new Set((scenarioValue.actions ?? []).map(value => value?.kind))
    : null;
  for (const [index, role] of roles.entries()) {
    validateEvidenceRole(role, `${path}.evidenceRoles[${index}]`, families, scenarioActionKinds, workloadPlan, productCasesById, violations);
  }
  if (asset?.kind === 'real-product') requiredString(asset?.productCaseId, `${path}.productCaseId`, violations);
  if (asset?.kind === 'adversarial' && !securityIds.has(asset?.securityCaseId)) {
    violations.push(`${path}.securityCaseId is not declared`);
  }
  const admissionStatus = asset?.admissionResult?.status;
  if (!['trace-ready', 'workload-recorded-trace-blocked', 'formal-red-import-failure'].includes(admissionStatus)) {
    violations.push(`${path}.admissionResult.status is invalid`);
  }
  if (admissionStatus === 'formal-red-import-failure') {
    if (!/^E_RIVE_[A-Z0-9_]+$/u.test(asset?.admissionResult?.diagnostic ?? '')) violations.push(`${path}.admissionResult.diagnostic is invalid`);
    requiredString(asset?.admissionResult?.path, `${path}.admissionResult.path`, violations);
  }
  if (formal && admissionStatus !== 'trace-ready') violations.push(`${path} is not trace-ready`);
}

function equalEvidenceStatus(actual, expected, label, violations) {
  if (!expected.includes(actual)) violations.push(`${label} is invalid`);
}

function validateEvidenceRole(role, path, assetFamilies, scenarioActionKinds, workloadPlan, productCasesById, violations) {
  if (!ID.test(role?.id ?? '')) violations.push(`${path}.id is invalid`);
  if (!EVIDENCE_ROLE_KINDS.includes(role?.kind)) violations.push(`${path}.kind is invalid`);
  const actionKinds = array(role?.actionKinds, `${path}.actionKinds`, violations);
  if (actionKinds.length === 0) violations.push(`${path}.actionKinds must not be empty`);
  const requiredActionKinds = new Set(workloadPlan?.requiredActionKinds ?? []);
  for (const actionKind of actionKinds) {
    if (!requiredActionKinds.has(actionKind)) violations.push(`${path}.actionKinds contains undeclared action kind ${String(actionKind)}`);
    else if (scenarioActionKinds && !scenarioActionKinds.has(actionKind)) violations.push(`${path}.actionKinds is not exercised by the pinned scenario: ${actionKind}`);
  }
  if (new Set(actionKinds).size !== actionKinds.length) violations.push(`${path}.actionKinds contains duplicates`);

  if (role?.kind === 'feature-witness') {
    if (!EXPECTED_FAMILIES.includes(role?.featureFamily)) violations.push(`${path}.featureFamily is invalid`);
    else if (!assetFamilies.includes(role.featureFamily)) violations.push(`${path}.featureFamily is not attributed to the asset`);
  }
  if (role?.kind === 'product-witness') {
    const product = productCasesById.get(role?.productCaseId);
    if (!product) violations.push(`${path}.productCaseId is not declared`);
    else {
      const missingFamilies = (product.requiredFamilies ?? []).filter(value => !assetFamilies.includes(value));
      if (missingFamilies.length > 0) violations.push(`${path} lacks required product families: ${missingFamilies.join(', ')}`);
    }
  }
}

function validateOfficialAssetSource(source, violations) {
  const label = `official asset source ${String(source?.id)}`;
  if (!ID.test(source?.id ?? '')) violations.push(`${label} id is invalid`);
  if (source?.repository !== OFFICIAL_RIVE_REPOSITORY) violations.push(`${label} repository is not the frozen official repository`);
  if (!/^[a-f0-9]{40}$/u.test(source?.commit ?? '')) violations.push(`${label} commit is invalid`);
  if (typeof source?.path !== 'string' || source.path.includes('\\') || source.path.startsWith('/') || source.path.split('/').includes('..') || !source.path.endsWith('.riv')) {
    violations.push(`${label} path must be a relative POSIX .riv path`);
  }
  const expectedSourceUrl = `${OFFICIAL_RIVE_REPOSITORY}/blob/${String(source?.commit)}/${String(source?.path)}`;
  const expectedDownloadUrl = `https://raw.githubusercontent.com/rive-app/rive-runtime/${String(source?.commit)}/${String(source?.path)}`;
  if (source?.sourceUrl !== expectedSourceUrl) violations.push(`${label} sourceUrl is not immutable`);
  if (source?.downloadUrl !== expectedDownloadUrl) violations.push(`${label} downloadUrl is not immutable`);
  if (!SHA256.test(source?.sha256 ?? '')) violations.push(`${label} sha256 is invalid`);
  if (!Number.isSafeInteger(source?.byteLength) || source.byteLength < 8) violations.push(`${label} byteLength is invalid`);
  if (source?.format?.major !== 7 || source?.format?.minor !== 3) violations.push(`${label} format must be 7.3`);
  if (source?.license?.id !== 'MIT') violations.push(`${label} license id must be MIT`);
  const expectedLicenseEvidence = `${OFFICIAL_RIVE_REPOSITORY}/blob/${String(source?.commit)}/LICENSE`;
  if (source?.license?.evidence !== expectedLicenseEvidence) violations.push(`${label} license evidence is not immutable`);
  if (!SHA256.test(source?.license?.sha256 ?? '')) violations.push(`${label} license hash is invalid`);
  if (source?.storagePolicy !== 'remote-hash-pinned-no-vendoring') violations.push(`${label} storage policy is invalid`);
  if (source?.formalEligible !== true) violations.push(`${label} formal eligibility must be explicit`);
}

function validateHttpsUrl(value, label, violations) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') violations.push(`${label} must use HTTPS`);
  } catch {
    violations.push(`${label} is invalid`);
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

function sourceCensusCoverage(census) {
  return {
    objectKeys: new Set((census?.objects ?? []).map(value => value.typeKey)),
    propertyKeys: new Set((census?.properties ?? []).filter(value => value.binaryEvidenceEligible === true).map(value => value.key)),
    scriptModuleKeys: new Set((census?.scripts?.modules ?? []).map(scriptKey)),
    scriptSymbolKeys: new Set((census?.scripts?.symbols ?? []).map(scriptKey)),
    assetTypeKeys: new Set((census?.assets ?? []).filter(value => value.binaryEvidenceEligible === true).map(value => value.typeKey)),
  };
}

function binaryEvidenceCoverage(census) {
  return {
    objectKeys: new Set((census?.objects ?? []).filter(value => value.binaryEvidenceEligible === true).map(value => value.typeKey)),
    propertyKeys: new Set((census?.properties ?? []).filter(value => value.binaryEvidenceEligible === true).map(value => value.key)),
    scriptModuleKeys: new Set(),
    scriptSymbolKeys: new Set(),
    assetTypeKeys: new Set((census?.assets ?? []).filter(value => value.binaryEvidenceEligible === true).map(value => value.typeKey)),
  };
}

function validateCoverageModel(model, census, violations) {
  const equalValue = (actual, expected, label) => {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  };
  equalValue(model?.contractRevision, 2, 'coverage model revision');
  for (const key of ['objectTypes', 'propertyKeys', 'scriptModules', 'scriptSymbols', 'assetTypes']) {
    equalValue(model?.sourceCensus?.[key], census?.totals?.[key], `source census ${key}`);
  }
  equalValue(model?.sourceCensus?.unclassifiedFailureCount, 0, 'source census unclassified failures');
  equalValue(model?.binaryEvidence?.objectTypes, census?.coverageEvidenceModel?.binaryEvidence?.objectTypes, 'binary evidence object types');
  equalValue(model?.binaryEvidence?.propertyKeys, census?.coverageEvidenceModel?.binaryEvidence?.propertyKeys, 'binary evidence property keys');
  equalValue(model?.binaryEvidence?.assetTypes, census?.coverageEvidenceModel?.binaryEvidence?.assetTypes, 'binary evidence asset types');
  const runtimeNullKeys = model?.binaryEvidence?.runtimeNullObjectKeys;
  if (!Array.isArray(runtimeNullKeys) || runtimeNullKeys.length !== 1 || runtimeNullKeys[0] !== 526) {
    violations.push('binary evidence runtime-null object keys do not match the accepted tuple');
  }
  equalValue(model?.behavioralEvidence?.featureFamilies, EXPECTED_FAMILIES.length, 'behavioral evidence feature families');
  equalValue(model?.behavioralEvidence?.scriptModules, census?.totals?.scriptModules, 'behavioral evidence script modules');
  equalValue(model?.behavioralEvidence?.scriptSymbols, census?.totals?.scriptSymbols, 'behavioral evidence script symbols');
  equalValue(model?.behavioralEvidence?.scriptRegistrationKeysAreWireKeys, false, 'script registration wire-key policy');
  requiredString(model?.diagnosticInventoryPolicy, 'diagnostic inventory policy', violations);
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
