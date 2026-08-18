import { expectedStructuralEvidence } from '../scene-contract.mjs';
import { median } from './statistics.mjs';

export const COMPARISON_POLICY = Object.freeze({
  schemaVersion: 1,
  rankedBackend: 'webgpu',
  subjectEngineId: 'haiyue',
  requiredRankedEngines: Object.freeze(['haiyue', 'three', 'babylon', 'playcanvas']),
  requiredInformationalEngines: Object.freeze(['galacean']),
  leadingTieRatio: 1.05,
  maximumStableRsd: 0.15,
  minimumStableCohortRatio: 2 / 3,
});

export function evaluateComparisonReport(report, policy = COMPARISON_POLICY) {
  const violations = [];
  const expected = expectedStructuralEvidence();
  const expectedProfile = report.profile === 'full'
    ? { cohorts: 3, warmupFrames: 12, sampleFrames: 40 }
    : report.profile === 'smoke'
      ? { cohorts: 1, warmupFrames: 4, sampleFrames: 12 }
      : null;
  if (report.profile != null && !expectedProfile) violations.push(`unknown comparison profile: ${report.profile}`);
  if (expectedProfile) {
    for (const [key, value] of Object.entries(expectedProfile)) {
      if (report.configuration?.[key] !== value) {
        violations.push(`configuration.${key}=${report.configuration?.[key]} expected ${value}`);
      }
    }
  }
  const byEngine = new Map((report.engines ?? []).map(engine => [engine.engineId, engine]));
  const required = [...policy.requiredRankedEngines, ...policy.requiredInformationalEngines];
  for (const engineId of required) {
    if (!byEngine.has(engineId)) violations.push(`${engineId}: required adapter result is missing`);
  }

  for (const engine of byEngine.values()) {
    for (const [key, value] of Object.entries(expected)) {
      if (engine.structural?.[key] !== value) {
        violations.push(`${engine.engineId}: structural.${key}=${engine.structural?.[key]} expected ${value}`);
      }
    }
    if (engine.visual?.status !== 'passed') violations.push(`${engine.engineId}: visual sanity check did not pass`);
    if ((engine.browserErrorCount ?? 0) !== 0) violations.push(`${engine.engineId}: browser errors were reported`);
    const cohorts = Array.isArray(engine.cohorts) ? engine.cohorts : [];
    if (cohorts.length === 0) violations.push(`${engine.engineId}: timing cohorts are missing`);
    if (expectedProfile && cohorts.length !== expectedProfile.cohorts) {
      violations.push(`${engine.engineId}: cohort count=${cohorts.length} expected ${expectedProfile.cohorts}`);
    }
    if (expectedProfile) {
      for (const cohort of cohorts) {
        for (const metric of ['cpuSubmit', 'frameWall']) {
          const summary = cohort?.[metric];
          if (summary?.samples !== expectedProfile.sampleFrames
            || summary?.rawSamples?.length !== expectedProfile.sampleFrames
            || summary.rawSamples.some(value => !Number.isFinite(value) || value < 0)) {
            violations.push(`${engine.engineId}/${cohort?.id ?? 'unknown'}: ${metric} raw samples are incomplete`);
          }
        }
      }
    }
  }

  const ranked = policy.requiredRankedEngines.map(engineId => byEngine.get(engineId)).filter(Boolean);
  const subjectEngine = byEngine.get(policy.subjectEngineId);
  const competitorEngines = ranked.filter(engine => engine.engineId !== policy.subjectEngineId);
  const subjectCohortP50s = (subjectEngine?.cohorts ?? []).map(cohort => cohort.frameWall.p50);
  const competitorCohortP50s = competitorEngines.flatMap(engine => (engine.cohorts ?? []).map(cohort => cohort.frameWall.p50));
  const subjectWorstCohortP50 = subjectCohortP50s.length ? Math.max(...subjectCohortP50s) : Infinity;
  const fastestCompetitorBestCohortP50 = competitorCohortP50s.length ? Math.min(...competitorCohortP50s) : -Infinity;
  const robustCohortLead = subjectWorstCohortP50 <= fastestCompetitorBestCohortP50 * policy.leadingTieRatio;
  for (const engine of ranked) {
    if (engine.backend !== policy.rankedBackend) violations.push(`${engine.engineId}: ranked backend is ${engine.backend}, expected ${policy.rankedBackend}`);
    if (engine.nativeBackend !== true) violations.push(`${engine.engineId}: ranked result is not native WebGPU`);
    const cohortP50s = (engine.cohorts ?? []).map(cohort => cohort.frameWall.p50);
    const cohortRsd = relativeStandardDeviation(cohortP50s);
    const implausiblyNoisyCohorts = (engine.cohorts ?? []).filter(cohort => cohort.frameWall.relativeStandardDeviation > 0.5).length;
    if (!robustCohortLead && (cohortRsd > policy.maximumStableRsd || implausiblyNoisyCohorts / Math.max(1, engine.cohorts?.length ?? 0) > (1 - policy.minimumStableCohortRatio))) {
      violations.push(`${engine.engineId}: timing cohorts are too noisy`);
    }
  }

  const rankedScores = ranked.filter(engine => engine.cohorts?.length).map(engine => ({
    engineId: engine.engineId,
    medianP50Ms: median(engine.cohorts.map(cohort => cohort.frameWall.p50)),
    medianP95Ms: median(engine.cohorts.map(cohort => cohort.frameWall.p95)),
  })).sort((left, right) => left.medianP50Ms - right.medianP50Ms);
  const subject = rankedScores.find(item => item.engineId === policy.subjectEngineId);
  const fastestCompetitor = rankedScores.find(item => item.engineId !== policy.subjectEngineId);
  const leadingOrTied = Boolean(subject && fastestCompetitor && subject.medianP50Ms <= fastestCompetitor.medianP50Ms * policy.leadingTieRatio);
  if (!leadingOrTied) {
    violations.push(`${policy.subjectEngineId}: not leading or within ${(policy.leadingTieRatio - 1) * 100}% of the fastest WebGPU competitor`);
  }

  return {
    status: violations.length === 0 ? 'passed' : 'failed',
    violations,
    rankedBackend: policy.rankedBackend,
    ranking: rankedScores,
    subject: subject ?? null,
    fastestCompetitor: fastestCompetitor ?? null,
    leadingOrTied,
    robustCohortLead,
    subjectWorstCohortP50,
    fastestCompetitorBestCohortP50,
    informationalEngines: policy.requiredInformationalEngines,
  };
}

function relativeStandardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return mean === 0 ? 0 : Math.sqrt(variance) / mean;
}
