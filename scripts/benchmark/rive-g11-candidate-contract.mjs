import { validateRiveOracleTrace } from '../hya-corpus/rive-oracle-trace-contract.mjs';

export const RIVE_G11_CANDIDATE_KIND = 'haiyue-rive-g11-candidate';
export const RIVE_G11_CANDIDATE_VERSION = 1;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const REQUIRED_DEVICE_MATRIX = Object.freeze(new Map([
  ['windows-10-integrated', ['chrome', 'edge']],
  ['windows-11-discrete', ['chrome', 'edge']],
]));
const METRICS = Object.freeze([
  'rawBytes', 'gzipBytes', 'networkBytes', 'networkMs', 'parseMs', 'firstFrameMs',
  'cpuFrameMs', 'gpuFrameMs', 'peakMemoryBytes', 'settleMs', 'energyMj',
]);
const CLOSURE_SCANS = Object.freeze([
  'packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests',
]);

export function validateRiveG11Candidate(candidate, {
  formal = false,
  expectedEngineRevision = null,
  expectedManifestSha256 = null,
  manifest = null,
  tracesByPath = null,
} = {}) {
  const violations = [];
  equal(candidate?.schemaVersion, RIVE_G11_CANDIDATE_VERSION, 'schemaVersion');
  equal(candidate?.kind, RIVE_G11_CANDIDATE_KIND, 'kind');
  equal(candidate?.goal, 'm07/g11-corpus-version-fidelity-performance', 'Goal');
  if (!['incomplete', 'passed', 'failed'].includes(candidate?.status)) violations.push('candidate status is invalid');
  if (!Array.isArray(candidate?.blockers)) violations.push('blockers must be an array');
  equal(candidate?.tupleId, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  match(candidate?.engineRevision, REVISION, 'Engine revision');
  if (expectedEngineRevision) equal(candidate?.engineRevision, expectedEngineRevision, 'expected Engine revision');
  if (typeof candidate?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  if (typeof candidate?.nodeVersion !== 'string' || !/^v\d+\./u.test(candidate.nodeVersion)) violations.push('Node version identity is missing');
  if (!Number.isFinite(Date.parse(candidate?.generatedAt ?? ''))) violations.push('generatedAt is invalid');
  equal(
    candidate?.evidenceClass,
    candidate?.engineDirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate',
    'evidence class',
  );
  match(candidate?.corpus?.manifestSha256, SHA256, 'corpus manifest hash');
  match(candidate?.corpus?.censusSha256, SHA256, 'census hash');
  if (expectedManifestSha256) equal(candidate?.corpus?.manifestSha256, expectedManifestSha256, 'expected corpus manifest hash');

  const coverage = candidate?.coverage;
  for (const [key, expected] of Object.entries({
    objectTypes: 288,
    propertyKeys: 611,
    scriptModules: 48,
    scriptSymbols: 349,
    assetTypes: 14,
  })) equal(coverage?.[key], expected, `coverage ${key}`);
  for (const key of ['uncoveredObjects', 'uncoveredProperties', 'uncoveredScriptModules', 'uncoveredScriptSymbols', 'uncoveredAssets', 'unclassifiedFailureCount']) {
    nonnegativeInteger(coverage?.[key], `coverage ${key}`);
  }

  const traceReferences = Array.isArray(candidate?.traceArtifacts) ? candidate.traceArtifacts : [];
  const seenTraceKeys = new Set();
  for (const [index, reference] of traceReferences.entries()) {
    requiredString(reference?.assetId, `trace ${index} asset id`);
    requiredString(reference?.deviceClass, `trace ${index} device class`);
    if (!['chrome', 'edge'].includes(reference?.browser)) violations.push(`trace ${index} browser is invalid`);
    requiredString(reference?.path, `trace ${index} path`);
    match(reference?.sha256, SHA256, `trace ${index} hash`);
    const key = `${reference?.assetId}:${reference?.deviceClass}:${reference?.browser}`;
    if (seenTraceKeys.has(key)) violations.push(`duplicate trace ${key}`);
    seenTraceKeys.add(key);
    if (tracesByPath?.has(reference.path)) {
      const result = validateRiveOracleTrace(tracesByPath.get(reference.path), {
        formal,
        expectedRevision: candidate.engineRevision,
        expectedManifestSha256: candidate.corpus.manifestSha256,
      });
      if (result.status !== 'passed') violations.push(`trace ${reference.path} failed: ${result.violations.join('; ')}`);
    } else if (formal) violations.push(`trace artifact is unavailable for validation: ${String(reference.path)}`);
  }

  const devices = Array.isArray(candidate?.devices) ? candidate.devices : [];
  const seenDevices = new Set();
  for (const device of devices) {
    const requiredBrowsers = REQUIRED_DEVICE_MATRIX.get(device?.id);
    if (!requiredBrowsers) violations.push(`unknown device class ${String(device?.id)}`);
    if (seenDevices.has(device?.id)) violations.push(`duplicate device class ${String(device?.id)}`);
    seenDevices.add(device?.id);
    for (const key of ['os', 'gpuClass', 'machineIdSha256']) requiredString(device?.[key], `${String(device?.id)} ${key}`);
    match(device?.machineIdSha256, SHA256, `${String(device?.id)} machine identity`);
    const browsers = Array.isArray(device?.browsers) ? device.browsers : [];
    for (const browser of requiredBrowsers ?? []) {
      const report = browsers.find(value => value?.browser === browser);
      if (!report) violations.push(`${String(device?.id)} missing ${browser}`);
      else validateBrowserReport(device.id, report);
    }
    if (browsers.some(value => !requiredBrowsers?.includes(value?.browser))) violations.push(`${String(device?.id)} contains an unexpected browser`);
  }
  if (formal) {
    for (const id of REQUIRED_DEVICE_MATRIX.keys()) if (!seenDevices.has(id)) violations.push(`missing required device class ${id}`);
  }

  const metrics = Array.isArray(candidate?.performance?.assets) ? candidate.performance.assets : [];
  const metricIds = new Set();
  for (const item of metrics) {
    requiredString(item?.assetId, 'performance asset id');
    if (metricIds.has(item?.assetId)) violations.push(`duplicate performance asset ${String(item?.assetId)}`);
    metricIds.add(item?.assetId);
    for (const metric of METRICS) nonnegativeNumber(item?.official?.[metric], `${String(item?.assetId)} official ${metric}`);
    for (const metric of METRICS) nonnegativeNumber(item?.hya?.[metric], `${String(item?.assetId)} HYA ${metric}`);
    equal(item?.sameMachine, true, `${String(item?.assetId)} same-machine comparison`);
    equal(item?.sameRevision, true, `${String(item?.assetId)} same-revision comparison`);
  }
  equal(candidate?.performance?.fullWorkload, formal ? true : candidate?.performance?.fullWorkload, 'performance workload identity');

  const securityResults = Array.isArray(candidate?.security?.cases) ? candidate.security.cases : [];
  const securityIds = new Set();
  for (const result of securityResults) {
    requiredString(result?.id, 'security case id');
    if (securityIds.has(result?.id)) violations.push(`duplicate security result ${String(result?.id)}`);
    securityIds.add(result?.id);
    if (!['passed', 'failed', 'not-run'].includes(result?.status)) violations.push(`${String(result?.id)} security status is invalid`);
    requiredString(result?.expectedDiagnostic, `${String(result?.id)} expected diagnostic`);
    if (result?.status === 'passed') {
      equal(result?.observedDiagnostic, result.expectedDiagnostic, `${String(result?.id)} diagnostic`);
      equal(result?.ownerResidual, 0, `${String(result?.id)} owner residual`);
      nonnegativeNumber(result?.peakMemoryBytes, `${String(result?.id)} peak memory`);
      nonnegativeNumber(result?.cpuMs, `${String(result?.id)} CPU time`);
    }
  }
  if (manifest) {
    for (const expected of manifest.securityCases ?? []) {
      if (!securityIds.has(expected.id)) violations.push(`missing security result ${expected.id}`);
    }
  }

  const closureScans = Array.isArray(candidate?.browserClosure?.scans) ? candidate.browserClosure.scans : [];
  for (const name of CLOSURE_SCANS) {
    const scan = closureScans.find(value => value?.name === name);
    if (!scan) violations.push(`missing browser closure scan ${name}`);
    else {
      if (!['passed', 'failed', 'not-run'].includes(scan?.status)) violations.push(`${name} scan status is invalid`);
      if (scan?.status === 'not-run') {
        requiredString(scan?.reason, `${name} not-run reason`);
        if (formal) violations.push(`${name} closure scan was not run`);
      } else {
        match(scan?.sha256, SHA256, `${name} scan hash`);
        equal(scan?.forbiddenPackageCount, 0, `${name} forbidden package count`);
        equal(scan?.forbiddenFileCount, 0, `${name} forbidden file count`);
        equal(scan?.forbiddenStaticPatternCount, 0, `${name} forbidden static pattern count`);
        equal(scan?.forbiddenNetworkCount, 0, `${name} forbidden network count`);
        equal(scan?.rawRivCount, 0, `${name} raw RIV count`);
        if (formal) equal(scan?.status, 'passed', `${name} formal scan status`);
      }
    }
  }
  equal(candidate?.browserClosure?.officialOracleBuildTimeOnly, true, 'official oracle build-time boundary');
  equal(candidate?.browserClosure?.unclassifiedFailureCount, 0, 'browser closure unclassified failures');

  const licenseInventory = Array.isArray(candidate?.licenses?.assets) ? candidate.licenses.assets : [];
  if (formal && manifest && licenseInventory.length !== manifest.formalAssets.length) {
    violations.push('license inventory does not match formal asset population');
  }
  for (const item of licenseInventory) {
    requiredString(item?.assetId, 'license asset id');
    requiredString(item?.licenseId, `${String(item?.assetId)} license id`);
    requiredString(item?.evidence, `${String(item?.assetId)} license evidence`);
    equal(item?.rightsComplete, true, `${String(item?.assetId)} license rights`);
    equal(item?.transitiveAssetsComplete, true, `${String(item?.assetId)} transitive license inventory`);
  }

  const findings = candidate?.diagnosticFindings;
  if (findings !== null && findings !== undefined) {
    equal(findings?.formalEvidence, false, 'diagnostic findings evidence class');
    match(findings?.runtimeInventory?.sha256, SHA256, 'runtime diagnostic inventory hash');
    match(findings?.officialLoadMatrix?.sha256, SHA256, 'official diagnostic matrix hash');
    nonnegativeInteger(findings?.coveredObjectKeys, 'diagnostic covered object keys');
    nonnegativeInteger(findings?.coveredPropertyKeys, 'diagnostic covered property keys');
    nonnegativeInteger(findings?.importerOracleDivergenceCount, 'importer/oracle divergence count');
    nonnegativeInteger(findings?.oracleBrowserGateFailureCount, 'oracle browser gate failure count');
    nonnegativeInteger(findings?.redCaseCount, 'diagnostic red case count');
    equal(
      findings?.redCaseCount,
      Number(findings?.importerOracleDivergenceCount ?? 0) + Number(findings?.oracleBrowserGateFailureCount ?? 0),
      'diagnostic red case accounting',
    );
    equal(findings?.runtimeInventory?.unclassifiedFailureCount, 0, 'runtime inventory unclassified failures');
    if (findings?.oracleRepositoryInventory) {
      match(findings.oracleRepositoryInventory.sha256, SHA256, 'oracle repository inventory hash');
      equal(findings.oracleRepositoryInventory.accepted, 0, 'oracle repository frozen-minor accepted count');
      equal(findings.oracleRepositoryInventory.unclassifiedFailureCount, 0, 'oracle repository inventory unclassified failures');
    }
    equal(findings?.officialLoadMatrix?.ownerResidual, 0, 'official load matrix owner residual');
    if (findings?.edgeLoadMatrix) {
      match(findings.edgeLoadMatrix.sha256, SHA256, 'Edge diagnostic matrix hash');
      equal(findings.edgeLoadMatrix.ownerResidual, 0, 'Edge load matrix owner residual');
      nonnegativeInteger(findings?.crossBrowserPixelHashDifferenceCount, 'cross-browser pixel hash difference count');
    }
    nonnegativeInteger(findings?.formalDeviceClassCount, 'formal diagnostic device class count');
    if (!Array.isArray(findings?.redCases) || findings.redCases.length !== findings.redCaseCount) {
      violations.push('diagnostic red case ledger is incomplete');
    }
  }

  if (formal) {
    equal(candidate?.status, 'passed', 'formal candidate status');
    equal(candidate?.blockers?.length, 0, 'formal blocker count');
    equal(candidate?.engineDirty, false, 'formal Engine dirty state');
    if (!/^v22\./u.test(candidate?.nodeVersion ?? '')) violations.push('formal evidence must use Node 22');
    for (const key of ['uncoveredObjects', 'uncoveredProperties', 'uncoveredScriptModules', 'uncoveredScriptSymbols', 'uncoveredAssets', 'unclassifiedFailureCount']) {
      equal(coverage?.[key], 0, `formal coverage ${key}`);
    }
    if (manifest && traceReferences.length < manifest.formalAssets.length * 4) {
      violations.push('formal trace population does not cover every asset on both devices and browsers');
    }
    if (metrics.length < (manifest?.formalAssets?.length ?? 1)) violations.push('performance population is incomplete');
    if (securityResults.some(value => value?.status !== 'passed')) violations.push('security corpus contains a non-passing case');
    equal(findings?.redCaseCount ?? 0, 0, 'formal diagnostic red case count');
    equal(findings?.formalDeviceClassCount ?? 0, 2, 'formal diagnostic device class count');
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: 'haiyue-rive-g11-candidate@1',
    mode: formal ? 'formal' : 'diagnostic',
    status: violations.length === 0 ? 'passed' : 'failed',
    violations: Object.freeze(violations),
  });

  function validateBrowserReport(deviceId, report) {
    requiredString(report?.version, `${deviceId}:${report?.browser} version`);
    equal(report?.nativeBackend, true, `${deviceId}:${report?.browser} native backend`);
    equal(report?.officialBackend, 'webgl2', `${deviceId}:${report?.browser} official backend`);
    equal(report?.hyaBackend, 'webgpu', `${deviceId}:${report?.browser} HYA backend`);
    equal(report?.fullWorkload, true, `${deviceId}:${report?.browser} full workload`);
    equal(report?.consoleErrorCount, 0, `${deviceId}:${report?.browser} console errors`);
    equal(report?.exceptionCount, 0, `${deviceId}:${report?.browser} exceptions`);
    equal(report?.unclassifiedFailureCount, 0, `${deviceId}:${report?.browser} unclassified failures`);
  }

  function equal(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
  function match(actual, expression, label) {
    if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`);
  }
  function requiredString(actual, label) {
    if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`);
  }
  function nonnegativeInteger(actual, label) {
    if (!Number.isInteger(actual) || actual < 0) violations.push(`${label} must be a non-negative integer`);
  }
  function nonnegativeNumber(actual, label) {
    if (!Number.isFinite(actual) || actual < 0) violations.push(`${label} must be a finite non-negative number`);
  }
}
