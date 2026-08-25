import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const CLOSURE_SCANS = ['packedPlayerTarball', 'browserBundle', 'sourceMap', 'networkRequests'];

export function validateRiveG11EvidenceIndex(index, {
  expectedEngineRevision = null,
  expectedManifestSha256 = null,
  expectedWorkloadPlanSha256 = null,
  artifactBytesByPath = null,
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
  if (typeof index?.performance?.fullWorkload !== 'boolean') violations.push('performance.fullWorkload must be boolean');
  if (index?.browserClosure?.officialOracleBuildTimeOnly !== true) violations.push('official oracle build-time boundary must be true');
  if (!Number.isSafeInteger(index?.browserClosure?.unclassifiedFailureCount) || index.browserClosure.unclassifiedFailureCount < 0) violations.push('browser closure unclassified failures are invalid');
  for (const name of CLOSURE_SCANS) if (!(index?.browserClosure?.scans ?? []).some(value => value?.name === name)) violations.push(`missing closure scan ${name}`);

  const references = [
    ...(index?.traceArtifacts ?? []),
    ...(index?.devices ?? []).flatMap(value => (value?.browsers ?? []).map(browser => browser?.evidence).filter(Boolean)),
    ...(index?.browserClosure?.scans ?? []).map(value => value?.evidence).filter(Boolean),
  ];
  for (const [position, reference] of references.entries()) validateReference(reference, `evidence reference ${position}`);
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
}
