const STABLE_CV = 0.10;
const STABLE_SPREAD = 0.20;
const UNSTABLE_CV = 0.20;
const UNSTABLE_SPREAD = 0.40;
const TREND_SIGNAL = 0.15;

/**
 * Nearest-rank empirical percentiles are retained for budget compatibility.
 * Population variance is reported because the artifact contains the complete
 * measured population, not an estimator with discarded samples. One-percent
 * low FPS is the reciprocal of P99 frame time; a zero P99 is represented as
 * null because unbounded FPS cannot be serialized as a finite JSON number.
 */
export function summarizeTimingSamples(values, unit = 'ms') {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('Timing statistics require at least one raw sample.');
  }
  const rawSamples = values.map((value, index) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Timing sample ${index} must be finite and non-negative.`);
    }
    return value;
  });
  const sorted = [...rawSamples].sort((left, right) => left - right);
  const mean = rawSamples.reduce((total, value) => total + value, 0) / rawSamples.length;
  const variance = rawSamples.reduce(
    (total, value) => total + (value - mean) ** 2,
    0,
  ) / rawSamples.length;
  const standardDeviation = Math.sqrt(variance);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  return {
    unit,
    samples: rawSamples.length,
    sampleCount: rawSamples.length,
    rawSamples,
    p50,
    p95,
    p99,
    onePercentLowFps: unit === 'ms' && p99 > 0 ? 1_000 / p99 : null,
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    variance,
    standardDeviation,
    relativeStandardDeviation: mean > 0 ? standardDeviation / mean : 0,
  };
}

export function assertMatchingTimingSourceFingerprints(cohorts) {
  if (!Array.isArray(cohorts) || cohorts.length === 0) {
    throw new RangeError('At least one timing cohort is required.');
  }
  const expected = cohorts[0]?.sourceFingerprint;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error('Timing cohort 0 is missing its source fingerprint.');
  }
  cohorts.forEach((cohort, index) => {
    if (cohort.sourceFingerprint !== expected) {
      throw new Error(
        `Timing cohort source fingerprint mismatch at index ${index}: `
        + `${cohort.sourceFingerprint ?? 'missing'} != ${expected}.`,
      );
    }
  });
  return expected;
}

/**
 * Pools equal-size independent cohorts. Pooling every raw observation gives
 * each run equal influence and estimates the empirical tail across launches;
 * no minimum/best cohort is selected.
 */
export function aggregateTimingCohorts(cohorts) {
  const sourceFingerprint = assertMatchingTimingSourceFingerprints(cohorts);
  const firstResult = cohorts[0]?.result;
  const expectedIds = firstResult?.results?.map(result => result.id) ?? [];
  if (expectedIds.length === 0) {
    throw new Error('Timing cohort 0 contains no benchmark cases.');
  }
  const expectedSamples = firstResult.results[0]?.timing?.rawSamples?.length;
  if (!Number.isInteger(expectedSamples) || expectedSamples <= 0) {
    throw new Error('Timing cohorts must retain non-empty timing.rawSamples.');
  }
  for (let cohortIndex = 0; cohortIndex < cohorts.length; cohortIndex++) {
    const fixture = cohorts[cohortIndex]?.result;
    const actualIds = fixture?.results?.map(result => result.id) ?? [];
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`Timing cohort ${cohortIndex} has incompatible case coverage.`);
    }
    for (const result of fixture.results) {
      if (result.timing?.rawSamples?.length !== expectedSamples) {
        throw new Error(
          `Timing cohort ${cohortIndex}/${result.id} does not have the equal `
          + `${expectedSamples}-sample weight required for pooling.`,
        );
      }
    }
  }

  const results = expectedIds.map((id, caseIndex) => {
    const caseCohorts = cohorts.map((cohort, cohortIndex) => {
      const result = cohort.result.results[caseIndex];
      return {
        id: cohort.id,
        index: cohortIndex,
        sourceFingerprint: cohort.sourceFingerprint,
        generatedAt: cohort.result.generatedAt,
        browser: cohort.result.browser,
        adapter: cohort.result.adapter,
        coldStart: result.coldStart,
        warmup: result.warmup,
        timing: result.timing,
        sampleWall: result.sampleWall,
        cpuUpdate: result.cpuUpdate,
        cpuRecord: result.cpuRecord,
        cpuSubmit: result.cpuSubmit,
        queueWait: result.queueWait,
        gpuTimestamp: result.gpuTimestamp,
        metrics: result.metrics,
      };
    });
    const firstCase = firstResult.results[caseIndex];
    const timing = poolChannel(caseCohorts, 'timing');
    const warmup = poolChannel(caseCohorts, 'warmup');
    const sampleWall = poolChannel(caseCohorts, 'sampleWall');
    const cpuUpdate = poolChannel(caseCohorts, 'cpuUpdate');
    const cpuRecord = poolChannel(caseCohorts, 'cpuRecord');
    const cpuSubmit = poolChannel(caseCohorts, 'cpuSubmit');
    const queueWait = poolChannel(caseCohorts, 'queueWait');
    const availableGpuCohorts = caseCohorts.filter(
      cohort => cohort.gpuTimestamp?.status === 'available'
        && cohort.gpuTimestamp?.timing?.rawSamples?.length > 0,
    );
    const gpuTimestamp = availableGpuCohorts.length === cohorts.length
      ? {
          status: 'available',
          timing: summarizeTimingSamples(
            availableGpuCohorts.flatMap(cohort => cohort.gpuTimestamp.timing.rawSamples),
          ),
          cohorts: availableGpuCohorts.map(cohort => ({
            id: cohort.id,
            timing: cohort.gpuTimestamp.timing,
            passLabels: cohort.gpuTimestamp.passLabels,
          })),
        }
      : {
          status: 'unavailable',
          reason: caseCohorts
            .find(cohort => cohort.gpuTimestamp?.status !== 'available')
            ?.gpuTimestamp?.reason ?? 'timestamp-query unavailable in at least one cohort',
          cohorts: caseCohorts.map(cohort => ({
            id: cohort.id,
            status: cohort.gpuTimestamp?.status ?? 'missing',
            reason: cohort.gpuTimestamp?.reason ?? null,
          })),
        };
    const cohortP50 = summarizeTimingSamples(
      caseCohorts.map(cohort => cohort.timing.p50),
    );
    const cohortP95 = summarizeTimingSamples(
      caseCohorts.map(cohort => cohort.timing.p95),
    );
    const cohortP99 = summarizeTimingSamples(
      caseCohorts.map(cohort => cohort.timing.p99),
    );
    return {
      ...firstCase,
      samples: timing.samples,
      timing,
      warmup,
      sampleWall,
      cpuUpdate,
      cpuRecord,
      cpuSubmit,
      queueWait,
      gpuTimestamp,
      timingCohorts: caseCohorts,
      cohortStatistics: {
        count: caseCohorts.length,
        samplesPerCohort: expectedSamples,
        p50: cohortP50,
        p95: cohortP95,
        p99: cohortP99,
      },
      structuralMetricsByCohort: caseCohorts.map(cohort => ({
        id: cohort.id,
        metrics: cohort.metrics,
      })),
    };
  });

  return {
    ...firstResult,
    schemaVersion: Math.max(3, firstResult.schemaVersion ?? 0),
    generatedAt: new Date().toISOString(),
    sourceFingerprint,
    configuration: {
      ...firstResult.configuration,
      samples: expectedSamples * cohorts.length,
      samplesPerCohort: expectedSamples,
      timingCohortCount: cohorts.length,
      aggregation: 'equal-cohort pooled empirical nearest-rank',
    },
    timingCohorts: cohorts.map((cohort, index) => ({
      id: cohort.id,
      index,
      sourceFingerprint: cohort.sourceFingerprint,
      generatedAt: cohort.result.generatedAt,
      configuration: cohort.result.configuration,
      adapter: cohort.result.adapter,
      browser: cohort.result.browser,
    })),
    results,
  };
}

export function createTimingVariabilityAnalysis(artifact, performanceBudget) {
  const budgetByCase = new Map(
    (performanceBudget?.checks ?? [])
      .filter(check => (check.channel ?? 'timing') === 'timing')
      .map(check => [check.caseId, check.maxP95Ms]),
  );
  const cases = artifact.results.map(result =>
    assessCaseVariability(result, budgetByCase.get(result.id) ?? null));
  const counts = cases.reduce((totals, result) => {
    totals[result.stability] = (totals[result.stability] ?? 0) + 1;
    totals[result.conclusion] = (totals[result.conclusion] ?? 0) + 1;
    return totals;
  }, {});
  const overallStability = cases.some(result => result.stability === 'unstable')
    ? 'unstable'
    : cases.some(result => result.stability === 'variable')
      ? 'variable'
      : 'stable';
  const consistentFailures = cases.filter(
    result => result.conclusion === 'consistent-workload-cost',
  );
  const mixedFailures = cases.filter(
    result => result.conclusion === 'mixed-budget-failure',
  );
  const varianceFailures = cases.filter(
    result => result.conclusion === 'measurement-or-environment-variance'
      && result.cohortsExceedingBudget > 0,
  );
  const overallConclusion = consistentFailures.length > 0
    ? 'stable-workload-budget-regression-observed'
    : mixedFailures.length > 0
      ? 'budget-failure-with-cross-cohort-variance'
      : varianceFailures.length > 0
        ? 'budget-failure-attributed-to-variance'
        : 'no-stable-budget-regression-observed';
  return {
    schemaVersion: 1,
    methodology: {
      aggregation: 'All equally sized independent cohorts are pooled; no cohort is selected or discarded.',
      percentile: 'Nearest-rank empirical P50/P95/P99 over complete raw samples.',
      variance: 'Population variance over complete samples and independently over cohort P95 values.',
      stabilityThresholds: {
        stable: `cohort P95 CV <= ${STABLE_CV} and relative spread <= ${STABLE_SPREAD}`,
        unstable: `cohort P95 CV > ${UNSTABLE_CV} or relative spread > ${UNSTABLE_SPREAD}`,
        otherwise: 'variable',
      },
      attributionLimits:
        'Thermal and scheduler causes are inferred from trends and CPU/GPU timing separation; no OS thermal sensor is claimed.',
    },
    summary: {
      stability: overallStability,
      conclusion: overallConclusion,
      consistentFailureCaseIds: consistentFailures.map(result => result.caseId),
      mixedFailureCaseIds: mixedFailures.map(result => result.caseId),
      varianceFailureCaseIds: varianceFailures.map(result => result.caseId),
    },
    counts,
    cases,
  };
}

export function assessCaseVariability(result, budgetP95Ms = null) {
  const p95Values = result.timingCohorts.map(cohort => cohort.timing.p95);
  const p95Stats = summarizeTimingSamples(p95Values);
  const coefficientOfVariation = p95Stats.relativeStandardDeviation;
  const relativeSpread = p95Stats.p50 > 0
    ? (p95Stats.max - p95Stats.min) / p95Stats.p50
    : 0;
  const trend = p95Values[0] > 0
    ? (p95Values.at(-1) - p95Values[0]) / p95Values[0]
    : 0;
  const stability = coefficientOfVariation <= STABLE_CV && relativeSpread <= STABLE_SPREAD
    ? 'stable'
    : coefficientOfVariation > UNSTABLE_CV || relativeSpread > UNSTABLE_SPREAD
      ? 'unstable'
      : 'variable';
  const exceedsBudget = Number.isFinite(budgetP95Ms)
    ? result.timing.p95 > budgetP95Ms
    : null;
  const individualFailures = Number.isFinite(budgetP95Ms)
    ? p95Values.filter(value => value > budgetP95Ms).length
    : null;

  const runtimeP95Median = p95Stats.p50;
  const sampleWallP95Median = median(
    result.timingCohorts.map(cohort => cohort.sampleWall?.p95 ?? cohort.timing.p95),
  );
  const submitP95Median = median(result.timingCohorts.map(cohort => cohort.cpuSubmit.p95));
  const recordP95Median = median(result.timingCohorts.map(cohort => cohort.cpuRecord.p95));
  const queueWaitP95Median = median(result.timingCohorts.map(cohort => cohort.queueWait.p95));
  const gpuPairs = result.timingCohorts
    .filter(cohort => cohort.gpuTimestamp?.status === 'available')
    .map(cohort => [
      cohort.sampleWall?.p95 ?? cohort.timing.p95,
      cohort.gpuTimestamp.timing.p95,
    ]);
  const gpuP95Median = gpuPairs.length === result.timingCohorts.length
    ? median(gpuPairs.map(([, gpu]) => gpu))
    : null;
  const gpuCorrelation = gpuPairs.length >= 3
    ? pearsonCorrelation(
        gpuPairs.map(([frame]) => frame),
        gpuPairs.map(([, gpu]) => gpu),
      )
    : null;

  const signals = [];
  if (Math.abs(trend) >= TREND_SIGNAL) {
    signals.push({
      factor: trend > 0 ? 'thermal-or-sustained-system-load' : 'progressive-cache-or-scheduler-improvement',
      strength: Math.abs(trend) >= 0.30 ? 'strong' : 'moderate',
      evidence: `cohort P95 changed ${(trend * 100).toFixed(1)}% from first to last launch`,
    });
  }
  if (gpuP95Median !== null && sampleWallP95Median > 0) {
    const gpuShare = gpuP95Median / sampleWallP95Median;
    if (gpuShare >= 0.60 && (gpuCorrelation ?? 0) >= 0.60) {
      signals.push({
        factor: 'gpu-workload-or-gpu-scheduling',
        strength: gpuShare >= 0.85 ? 'strong' : 'moderate',
        evidence: `GPU P95/frame P95=${gpuShare.toFixed(2)}, cohort correlation=${gpuCorrelation.toFixed(2)}`,
      });
    } else if (stability !== 'stable' && (gpuCorrelation ?? 0) < 0.30) {
      signals.push({
        factor: 'host-scheduling-or-queue-wait',
        strength: 'moderate',
        evidence: `wall-time varies without matching GPU P95 movement (correlation=${gpuCorrelation?.toFixed(2) ?? 'n/a'})`,
      });
    }
  }
  if (sampleWallP95Median > 0 && queueWaitP95Median / sampleWallP95Median >= 0.50) {
    signals.push({
      factor: 'gpu-queue-wait-or-system-scheduling',
      strength: 'moderate',
      evidence: `queue-wait P95 is ${(queueWaitP95Median / sampleWallP95Median * 100).toFixed(1)}% of sample-wall P95`,
    });
  }
  if (runtimeP95Median > 0 && submitP95Median / runtimeP95Median >= 0.20) {
    signals.push({
      factor: 'cpu-submit',
      strength: 'moderate',
      evidence: `CPU submit P95 is ${(submitP95Median / runtimeP95Median * 100).toFixed(1)}% of runtime P95`,
    });
  }

  let conclusion;
  if (stability === 'unstable') {
    conclusion = 'measurement-or-environment-variance';
  } else if (exceedsBudget === true && individualFailures === p95Values.length) {
    conclusion = 'consistent-workload-cost';
  } else if (exceedsBudget === true) {
    conclusion = 'mixed-budget-failure';
  } else if (
    Number.isFinite(budgetP95Ms)
    && individualFailures !== null
    && individualFailures > 0
  ) {
    conclusion = 'transient-cohort-excursion';
  } else {
    conclusion = 'stable-within-budget';
  }

  return {
    caseId: result.id,
    budgetP95Ms,
    pooledP95Ms: result.timing.p95,
    cohortP95Ms: p95Values,
    cohortP95Variance: p95Stats.variance,
    cohortP95CoefficientOfVariation: coefficientOfVariation,
    cohortP95RelativeSpread: relativeSpread,
    firstToLastP95Change: trend,
    stability,
    conclusion,
    cohortsExceedingBudget: individualFailures,
    channelP95MedianMs: {
      frame: sampleWallP95Median,
      runtime: runtimeP95Median,
      sampleWall: sampleWallP95Median,
      cpuRecord: recordP95Median,
      cpuSubmit: submitP95Median,
      queueWait: queueWaitP95Median,
      gpuTimestamp: gpuP95Median,
    },
    gpuFrameP95Correlation: gpuCorrelation,
    signals,
  };
}

function poolChannel(cohorts, key) {
  const samples = cohorts.flatMap(cohort => {
    const rawSamples = cohort[key]?.rawSamples;
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      throw new Error(`Timing cohort ${cohort.id}/${key} is missing raw samples.`);
    }
    return rawSamples;
  });
  return summarizeTimingSamples(samples, cohorts[0][key].unit ?? 'ms');
}

function percentile(sorted, ratio) {
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  ];
}

function median(values) {
  return percentile([...values].sort((left, right) => left - right), 0.5);
}

function pearsonCorrelation(left, right) {
  const leftMean = left.reduce((total, value) => total + value, 0) / left.length;
  const rightMean = right.reduce((total, value) => total + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : 0;
}
