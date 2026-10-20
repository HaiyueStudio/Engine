// Acceptance routing is separate from immutable v1-v5 measurement validators.
// A diagnostic warning never supplies missing production qualification.
export const G09_PRODUCTION_CONTRACT = 'g09-production-acceptance-v2';
const check = (condition, message) => { if (!condition) throw Error(message); };
const requiredIds = ['correctness', 'production-smoothness', 'sustained-resources', 'optimization-benefit', 'release-requalification'];

export function validateG09AcceptanceRouting(config) {
  check(config?.schemaVersion === 1 && config.contractId === G09_PRODUCTION_CONTRACT, 'Unknown G09 acceptance contract');
  check(config.hardwareContract === 'engine-native-021-v2', 'Hardware qualification changed');
  const m = config.microbenchmark;
  check(m?.regressionWarningRatio === .05 && m.releaseBlocking === false && m.legacyCalibrationRequired === false &&
    m.legacyBaselineRequired === false && m.retainAllSamples === true && m.maxPlannedAttempts === 2 &&
    m.unstableResult === 'inconclusive' && m.invalidEvidence === 'invalid', 'Invalid diagnostic routing');
  check(JSON.stringify(config.requiredEvidence?.map(row => row.id)) === JSON.stringify(requiredIds) &&
    config.requiredEvidence.every(row => typeof row.requirement === 'string' && row.requirement.length > 0), 'Missing acceptance requirement');
  check(config.production?.profileRegistration === 'required-before-capture' &&
    config.production.unregisteredProfileResult === 'incomplete' && config.production.contaminatedEvidenceResult === 'inconclusive' &&
    config.production.automaticRetry === false, 'Production evidence must be registered and cannot retry until green');
  for (const field of ['device', 'browser', 'resolution', 'quality', 'workload', 'targetFps', 'frameP95Ms', 'frameP99Ms',
    'longFrameThresholdMs', 'maxLongFrameRatio', 'maxConsecutiveLongFrames', 'durationSeconds', 'startupBoundary', 'warmupBoundary', 'cohortPlan'])
    check(config.production.requiredProfileFields?.includes(field), `Missing production profile field: ${field}`);
  return config;
}

export function createG09AcceptanceRoute(config) {
  validateG09AcceptanceRouting(config);
  return { contractId: config.contractId, status: 'incomplete', g09Complete: false, performanceQualified: false,
    requiredEvidence: config.requiredEvidence, optionalDiagnostics: ['legacy-forward-preflight', 'v1-v5-common-calibration-and-baseline', 'continuous-gpu-state'],
    microbenchmark: config.microbenchmark,
    production: config.production,
    reason: 'A plan is not evidence. Production profiles and validated frame-pacing evidence remain required.' };
}

/** Call only with a revalidated legacy assessment, never unverified raw summaries. */
export function interpretG09Microbenchmark(assessment, config) {
  validateG09AcceptanceRouting(config);
  check(['passed', 'failed'].includes(assessment?.status) && assessment.performanceQualified === false &&
    Array.isArray(assessment.rows) && assessment.rows.length > 0, 'Expected a revalidated diagnostic assessment');
  const rows = assessment.rows.map(row => {
    const a = row.A0?.pooled?.p95, b = row.B4?.pooled?.p95;
    check(Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0 &&
      typeof row.A0.stability?.stable === 'boolean' && typeof row.B4.stability?.stable === 'boolean', 'Invalid timing/stability evidence');
    const stable = row.A0.stability.stable && row.B4.stability.stable;
    const hasRelativeBudget = ['cpu', 'gpuPassSum', 'gpuSpan'].includes(row.metric);
    return { caseId: row.caseId, metric: row.metric, referenceP95Ms: a, candidateP95Ms: b,
      absoluteDeltaMs: b - a, relativeDelta: b / a - 1,
      status: !stable ? 'inconclusive' : !hasRelativeBudget ? 'informational' :
        b > a * (1 + config.microbenchmark.regressionWarningRatio) ? 'warning' : 'within-warning-budget' };
  });
  return { contractId: config.contractId, historicalStatus: assessment.status,
    status: rows.some(r => r.status === 'inconclusive') ? 'inconclusive' : rows.some(r => r.status === 'warning') ? 'warning' : 'within-warning-budget',
    releaseBlocking: false, g09Complete: false, performanceQualified: false, rows };
}
