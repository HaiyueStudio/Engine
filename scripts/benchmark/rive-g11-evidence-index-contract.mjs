import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const CLOSURE_SCANS = ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'];

export function validateRiveG11EvidenceIndex(index, {
  expectedEngineRevision = null,
  expectedManifestSha256 = null,
  expectedWorkloadPlanSha256 = null,
  artifactBytesByPath = null,
  manifest = null,
  workloadPlan = null,
  formal = false,
} = {}) {
  const violations = [];
  equal(index?.schemaVersion, 1, 'schemaVersion');
  equal(index?.kind, 'haiyue-rive-g11-evidence-index', 'kind');
  if (!['collecting', 'complete'].includes(index?.status)) violations.push('status is invalid');
  equal(index?.tupleId, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  if (index?.engineRevision !== null) match(index?.engineRevision, REVISION, 'Engine revision');
  if (index?.corpusManifestSha256 !== null) match(index?.corpusManifestSha256, HASH, 'manifest hash');
  if (index?.workloadPlanSha256 !== null) match(index?.workloadPlanSha256, HASH, 'workload plan hash');
  if (formal || index?.status === 'complete') {
    equal(index?.engineRevision, expectedEngineRevision, 'expected Engine revision');
    equal(index?.corpusManifestSha256, expectedManifestSha256, 'expected manifest hash');
    equal(index?.workloadPlanSha256, expectedWorkloadPlanSha256, 'expected workload plan hash');
  }
  for (const [name, value] of [
    ['traceArtifacts', index?.traceArtifacts], ['devices', index?.devices],
    ['performance.assets', index?.performance?.assets], ['browserClosure.scans', index?.browserClosure?.scans],
  ]) if (!Array.isArray(value)) violations.push(`${name} must be an array`);
  if (!Array.isArray(index?.formalRunAttempts)) violations.push('formalRunAttempts must be an array');
  if (typeof index?.performance?.fullWorkload !== 'boolean') violations.push('performance.fullWorkload must be boolean');
  if (index?.browserClosure?.officialOracleBuildTimeOnly !== true) violations.push('official oracle build-time boundary must be true');
  if (!Number.isSafeInteger(index?.browserClosure?.unclassifiedFailureCount) || index.browserClosure.unclassifiedFailureCount < 0) violations.push('browser closure unclassified failures are invalid');
  const traceArtifacts = Array.isArray(index?.traceArtifacts) ? index.traceArtifacts : [];
  const devices = Array.isArray(index?.devices) ? index.devices : [];
  const performanceAssets = Array.isArray(index?.performance?.assets) ? index.performance.assets : [];
  const closureScans = Array.isArray(index?.browserClosure?.scans) ? index.browserClosure.scans : [];
  const closureNames = new Set();
  for (const scan of closureScans) {
    if (closureNames.has(scan?.name)) violations.push(`duplicate closure scan ${String(scan?.name)}`);
    closureNames.add(scan?.name);
    if (!CLOSURE_SCANS.includes(scan?.name)) violations.push(`unknown closure scan ${String(scan?.name)}`);
    if (!['passed', 'failed', 'not-run'].includes(scan?.status)) violations.push(`${String(scan?.name)} closure status is invalid`);
    if (scan?.status === 'not-run') requiredString(scan?.reason, `${String(scan?.name)} closure reason`);
  }
  for (const name of CLOSURE_SCANS) if (!closureNames.has(name)) violations.push(`missing closure scan ${name}`);

  const traceKeys = new Set();
  const traceByKey = new Map();
  for (const trace of traceArtifacts) {
    requiredString(trace?.assetId, 'trace asset id');
    requiredString(trace?.deviceClass, 'trace device class');
    if (!['chrome', 'edge'].includes(trace?.browser)) violations.push(`trace browser is invalid: ${String(trace?.browser)}`);
    const key = evidenceKey(trace);
    if (traceKeys.has(key)) violations.push(`duplicate trace ${key}`);
    traceKeys.add(key); traceByKey.set(key, trace);
  }
  const deviceIds = new Set(); const machineIds = new Set(); const browsersByDevice = new Map();
  for (const device of devices) {
    requiredString(device?.id, 'device id'); requiredString(device?.os, `${String(device?.id)} OS`);
    if (!isWindows10Plus(device?.os)) violations.push(`${String(device?.id)} must run Windows 10 or later`);
    requiredString(device?.gpuClass, `${String(device?.id)} GPU`); match(device?.machineIdSha256, HASH, `${String(device?.id)} machine identity`);
    equal(device?.physicalDevice, true, `${String(device?.id)} physical device`);
    if (deviceIds.has(device?.id)) violations.push(`duplicate device ${String(device?.id)}`);
    deviceIds.add(device?.id);
    if (machineIds.has(device?.machineIdSha256)) violations.push('device slots must use distinct physical machines');
    machineIds.add(device?.machineIdSha256);
    if (!Array.isArray(device?.browsers)) violations.push(`${String(device?.id)} browsers must be an array`);
    const browsers = new Set();
    for (const browser of Array.isArray(device?.browsers) ? device.browsers : []) {
      if (!['chrome', 'edge'].includes(browser?.browser)) violations.push(`${String(device?.id)} browser is invalid`);
      if (browsers.has(browser?.browser)) violations.push(`duplicate browser ${String(device?.id)}:${String(browser?.browser)}`);
      browsers.add(browser?.browser);
      requiredString(browser?.version, `${String(device?.id)}:${String(browser?.browser)} version`);
      equal(browser?.nativeBackend, true, `${String(device?.id)}:${String(browser?.browser)} native backend`);
      equal(browser?.officialBackend, 'webgl2', `${String(device?.id)}:${String(browser?.browser)} official backend`);
      equal(browser?.hyaBackend, 'webgpu', `${String(device?.id)}:${String(browser?.browser)} HYA backend`);
      equal(browser?.browserLogCaptured, true, `${String(device?.id)}:${String(browser?.browser)} browser log capture`);
      equal(browser?.fullWorkload, true, `${String(device?.id)}:${String(browser?.browser)} full workload`);
      for (const key of ['consoleErrorCount', 'exceptionCount', 'unclassifiedFailureCount']) equal(browser?.[key], 0, `${String(device?.id)}:${String(browser?.browser)} ${key}`);
    }
    browsersByDevice.set(device?.id, browsers);
  }
  const metricKeys = new Set();
  for (const metric of performanceAssets) {
    requiredString(metric?.assetId, 'performance asset id'); requiredString(metric?.deviceClass, 'performance device class');
    if (!['chrome', 'edge'].includes(metric?.browser)) violations.push(`performance browser is invalid: ${String(metric?.browser)}`);
    const key = evidenceKey(metric);
    if (metricKeys.has(key)) violations.push(`duplicate performance ${key}`);
    metricKeys.add(key);
    const trace = traceByKey.get(key);
    if (!trace) violations.push(`performance has no trace ${key}`);
    else {
      equal(metric?.tracePath, trace.path, `${key} performance trace path`);
      equal(metric?.traceSha256, trace.sha256, `${key} performance trace hash`);
    }
  }

  const references = [
    ...traceArtifacts,
    ...devices.flatMap(value => (Array.isArray(value?.browsers) ? value.browsers : []).map(browser => browser?.evidence).filter(Boolean)),
    ...closureScans.map(value => value?.evidence).filter(Boolean),
  ];
  for (const [position, reference] of references.entries()) validateReference(reference, `evidence reference ${position}`);
  const expectedKeys = manifest && workloadPlan ? expectedEvidenceKeys(manifest, workloadPlan) : null;
  if (expectedKeys && (formal || index?.status === 'complete')) {
    exactSet(traceKeys, expectedKeys, 'trace matrix');
    exactSet(metricKeys, expectedKeys, 'performance matrix');
    const expectedDevices = new Set((workloadPlan.browserDeviceMatrix ?? []).map(value => value.deviceClass));
    exactSet(deviceIds, expectedDevices, 'device matrix');
    for (const device of workloadPlan.browserDeviceMatrix ?? []) {
      exactSet(browsersByDevice.get(device.deviceClass) ?? new Set(), new Set(device.browsers ?? []), `${device.deviceClass} browser matrix`);
    }
    equal(index?.performance?.fullWorkload, true, 'complete performance workload');
    for (const name of CLOSURE_SCANS) equal(closureScans.find(value => value.name === name)?.status, 'passed', `${name} complete closure status`);
  }
  if (formal && index?.status !== 'complete') violations.push('formal evidence index is not complete');
  return Object.freeze({ schemaVersion: 1, contract: 'haiyue-rive-g11-evidence-index@1', status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations) });

  function validateReference(reference, label) {
    if (typeof reference?.path !== 'string' || reference.path.trim() === '') violations.push(`${label} path is missing`);
    match(reference?.sha256, HASH, `${label} hash`);
    if (!Number.isSafeInteger(reference?.byteLength) || reference.byteLength < 1) violations.push(`${label} byte length is invalid`);
    const bytes = artifactBytesByPath?.get(reference?.path);
    if (!bytes) { violations.push(`${label} bytes are unavailable`); return; }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    equal(buffer.byteLength, reference.byteLength, `${label} byte length`);
    equal(createHash('sha256').update(buffer).digest('hex'), reference.sha256, `${label} content hash`);
  }
  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function match(actual, expression, label) { if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`); }
  function requiredString(actual, label) { if (typeof actual !== 'string' || actual.trim() === '') violations.push(`${label} is missing`); }
  function nonnegativeInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 0) violations.push(`${label} is invalid`); }
  function exactSet(actual, expected, label) { if (actual.size !== expected.size || [...expected].some(value => !actual.has(value))) violations.push(`${label} is incomplete`); }
}

function evidenceKey(value) { return `${value?.assetId}:${value?.deviceClass}:${value?.browser}`; }
function expectedEvidenceKeys(manifest, workloadPlan) {
  return new Set((manifest.formalAssets ?? []).flatMap(asset => (workloadPlan.browserDeviceMatrix ?? []).flatMap(device => (
    device.browsers.map(browser => `${asset.id}:${device.deviceClass}:${browser}`)
  ))));
}

function isWindows10Plus(value) {
  const match = /^Windows\s+(\d+)(?:\D|$)/iu.exec(String(value));
  return match !== null && Number(match[1]) >= 10;
}
