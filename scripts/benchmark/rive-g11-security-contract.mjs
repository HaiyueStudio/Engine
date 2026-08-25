export const RIVE_G11_SECURITY_KIND = 'haiyue-rive-g11-security-workload';
export const RIVE_G11_SECURITY_VERSION = 1;

const HASH = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;

export function validateRiveG11SecurityReport(report, manifest, { formal = false, expectedRevision = null, expectedManifestSha256 = null } = {}) {
  const violations = [];
  equal(report?.schemaVersion, RIVE_G11_SECURITY_VERSION, 'schemaVersion');
  equal(report?.kind, RIVE_G11_SECURITY_KIND, 'kind');
  equal(report?.tupleId, 'rive-7.3-webgl2-2.40.0', 'tuple id');
  if (!['incomplete', 'passed', 'failed'].includes(report?.status)) violations.push('status is invalid');
  equal(report?.evidenceClass, report?.engineDirty ? 'dirty-worktree-diagnostic' : 'clean-revision-candidate', 'evidence class');
  match(report?.engineRevision, REVISION, 'Engine revision');
  if (expectedRevision) equal(report?.engineRevision, expectedRevision, 'expected Engine revision');
  if (typeof report?.engineDirty !== 'boolean') violations.push('Engine dirty identity is missing');
  if (typeof report?.nodeVersion !== 'string' || !/^v\d+\./u.test(report.nodeVersion)) violations.push('Node version identity is missing');
  if (!Number.isFinite(Date.parse(report?.generatedAt ?? ''))) violations.push('generatedAt is invalid');
  match(report?.manifestSha256, HASH, 'manifest hash');
  if (expectedManifestSha256) equal(report?.manifestSha256, expectedManifestSha256, 'expected manifest hash');
  equal(report?.runner?.id, 'scripts/benchmark/rive-g11-run-security.mjs@1', 'runner id');
  equal(report?.unclassifiedFailureCount, 0, 'unclassified failure count');

  const expectedCases = new Map((manifest?.securityCases ?? []).map(value => [value.id, value]));
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item?.id)) violations.push(`duplicate security case ${String(item?.id)}`);
    seen.add(item?.id);
    const expected = expectedCases.get(item?.id);
    if (!expected) violations.push(`unknown security case ${String(item?.id)}`);
    else {
      equal(item?.class, expected.class, `${item.id} class`);
      equal(item?.expectedDiagnostic, expected.expected, `${item.id} expected diagnostic`);
    }
    if (!['passed', 'failed', 'not-run'].includes(item?.status)) violations.push(`${String(item?.id)} status is invalid`);
    if (item?.status === 'not-run') requiredString(item?.reason, `${String(item?.id)} not-run reason`);
    if (item?.status === 'passed') {
      equal(item?.observedDiagnostic, item?.expectedDiagnostic, `${String(item?.id)} mapped diagnostic`);
      requiredString(item?.underlyingDiagnostic, `${String(item?.id)} underlying diagnostic`);
      equal(item?.freshOwner, true, `${String(item?.id)} fresh owner`);
      equal(item?.ownerResidual, 0, `${String(item?.id)} owner residual`);
      nonnegativeNumber(item?.cpuMs, `${String(item?.id)} CPU time`);
      nonnegativeNumber(item?.peakMemoryBytes, `${String(item?.id)} peak memory`);
      positiveNumber(item?.limits?.cpuMs, `${String(item?.id)} CPU limit`);
      positiveInteger(item?.limits?.peakMemoryBytes, `${String(item?.id)} memory limit`);
      if (item?.cpuMs > item?.limits?.cpuMs) violations.push(`${String(item?.id)} CPU time exceeded its limit`);
      if (item?.peakMemoryBytes > item?.limits?.peakMemoryBytes) violations.push(`${String(item?.id)} peak memory exceeded its limit`);
      requiredString(item?.runner, `${String(item?.id)} case runner`);
    }
  }
  for (const id of expectedCases.keys()) if (!seen.has(id)) violations.push(`missing security case ${id}`);
  const passed = cases.filter(value => value.status === 'passed').length;
  const failed = cases.filter(value => value.status === 'failed').length;
  const notRun = cases.filter(value => value.status === 'not-run').length;
  equal(report?.summary?.total, expectedCases.size, 'summary total');
  equal(report?.summary?.passed, passed, 'summary passed');
  equal(report?.summary?.failed, failed, 'summary failed');
  equal(report?.summary?.notRun, notRun, 'summary not-run');

  if (formal) {
    equal(report?.status, 'passed', 'formal status');
    equal(report?.engineDirty, false, 'formal Engine dirty state');
    if (!isNode22Plus(report?.nodeVersion)) violations.push('formal security evidence must use Node.js 22 or later');
    if (cases.some(value => value.status !== 'passed')) violations.push('formal security population is incomplete or failing');
  }

  return Object.freeze({ schemaVersion: 1, contract: 'haiyue-rive-g11-security-workload@1', mode: formal ? 'formal' : 'diagnostic', status: violations.length === 0 ? 'passed' : 'failed', violations: Object.freeze(violations) });

  function equal(actual, expected, label) { if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`); }
  function match(actual, expression, label) { if (typeof actual !== 'string' || !expression.test(actual)) violations.push(`${label} is invalid`); }
  function requiredString(actual, label) { if (typeof actual !== 'string' || actual.trim().length === 0) violations.push(`${label} is missing`); }
  function nonnegativeNumber(actual, label) { if (!Number.isFinite(actual) || actual < 0) violations.push(`${label} must be a finite non-negative number`); }
  function positiveNumber(actual, label) { if (!Number.isFinite(actual) || actual <= 0) violations.push(`${label} must be a finite positive number`); }
  function positiveInteger(actual, label) { if (!Number.isSafeInteger(actual) || actual < 1) violations.push(`${label} must be a positive safe integer`); }
}

function isNode22Plus(value) {
  const match = /^v(\d+)\./u.exec(String(value));
  return match !== null && Number(match[1]) >= 22;
}
