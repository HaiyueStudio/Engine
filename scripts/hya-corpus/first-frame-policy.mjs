export const HYA_FIRST_FRAME_DIAGNOSTIC_TOLERANCE = 0.10;

export function compareHyaFirstFrameCohorts(report, baseline) {
  const comparisons = [
    compareCohort(
      'legacy/small',
      report?.cohorts?.small,
      baseline?.cohorts?.small ?? baseline?.summary,
    ),
  ];
  if (report?.cohorts?.large?.sampleCount > 0 && baseline?.cohorts?.large?.sampleCount > 0) {
    comparisons.push(compareCohort('large', report.cohorts.large, baseline.cohorts.large));
  }
  const observed = comparisons.filter(comparison => comparison.status === 'regression-observed');
  return {
    role: 'cross-host-diagnostic',
    releaseBlocking: false,
    tolerance: HYA_FIRST_FRAME_DIAGNOSTIC_TOLERANCE,
    status: observed.length > 0 ? 'regression-observed' : 'within-tolerance',
    cohorts: comparisons,
  };
}

function compareCohort(label, current, baseline) {
  const currentP95Ms = finiteOrNull(current?.firstFrameP95Ms);
  const baselineP95Ms = finiteOrNull(baseline?.firstFrameP95Ms);
  if (currentP95Ms === null || baselineP95Ms === null) {
    return {
      label,
      status: 'unavailable',
      currentP95Ms,
      baselineP95Ms,
      limitP95Ms: null,
      ratio: null,
    };
  }
  const limitP95Ms = baselineP95Ms * (1 + HYA_FIRST_FRAME_DIAGNOSTIC_TOLERANCE);
  return {
    label,
    status: currentP95Ms > limitP95Ms ? 'regression-observed' : 'within-tolerance',
    currentP95Ms,
    baselineP95Ms,
    limitP95Ms,
    ratio: baselineP95Ms === 0 ? null : currentP95Ms / baselineP95Ms,
  };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
