export const MIN_MEDIAN_PARSE_SPEEDUP = 1.25;
export const MIN_GZIP_SAVING = 0.15;

export function mergeBrowserMetrics(samples, browserSamples) {
  const byId = new Map((browserSamples ?? []).map(sample => [sample.id, sample]));
  for (const sample of samples) {
    const measured = byId.get(sample.id);
    if (!measured) throw new Error(`Browser benchmark omitted corpus sample ${sample.id}.`);
    sample.firstFrame = measured.firstFrame;
    sample.delivery = measured.delivery ?? null;
    sample.fidelity = measured.fidelity;
    const frames = new Map(measured.frames.map(frame => [frame.frame, frame]));
    for (const frame of sample.frames) frame.metrics = frames.get(frame.frame)?.metrics ?? null;
  }
}

export function summarize(samples) {
  const totalLottieBytes = sum(samples, sample => sample.source.bytes);
  const totalHyaBytes = sum(samples, sample => sample.hya.bytes);
  const totalLottieGzipBytes = sum(samples, sample => sample.source.gzipBytes);
  const totalHyaGzipBytes = sum(samples, sample => sample.hya.gzipBytes);
  const fidelities = finite(samples.map(sample => sample.fidelity?.score));
  const parseSpeedups = finite(samples.map(sample => sample.parse.speedup));
  const firstFrames = finite(samples.map(sample => sample.firstFrame?.totalMs));
  const network = finite(samples.map(sample => sample.delivery?.hya.network.totalMs));
  const downloads = finite(samples.map(sample => sample.delivery?.hya.network.bodyDownloadMs));
  return {
    sampleCount: samples.length,
    referenceFrameCount: sum(samples, sample => sample.frames.length),
    cleanConversionCount: samples.filter(sample => sample.conversion.status === 'clean').length,
    failedFeatureSampleCount: samples.filter(sample => sample.featureAnalysis.failedFeatureCount > 0).length,
    unclassifiedFailureCount: sum(samples, sample => sample.featureAnalysis.unclassifiedFailureCount),
    totalLottieBytes,
    totalHyaBytes,
    totalLottieGzipBytes,
    totalHyaGzipBytes,
    rawByteSaving: saving(totalHyaBytes, totalLottieBytes),
    gzipByteSaving: saving(totalHyaGzipBytes, totalLottieGzipBytes),
    medianFidelity: median(fidelities),
    minimumFidelity: fidelities.length > 0 ? Math.min(...fidelities) : null,
    medianParseSpeedup: median(parseSpeedups) ?? 0,
    firstFrameP50Ms: median(firstFrames),
    firstFrameP95Ms: percentile(firstFrames, 0.95),
    networkP50Ms: median(network),
    networkP95Ms: percentile(network, 0.95),
    downloadP50Ms: median(downloads),
    downloadP95Ms: percentile(downloads, 0.95),
  };
}

export function cohort(samples, sizeClass) {
  return samples.filter(sample => (sample.sizeClass ?? 'small') === sizeClass);
}

export function stability(runs) {
  return {
    runs,
    minimum: runs.length > 0 ? Math.min(...runs) : 0,
    median: median([...runs].sort((a, b) => a - b)),
    maximum: runs.length > 0 ? Math.max(...runs) : 0,
  };
}

export function validateReport(report, baseline) {
  const small = report.cohorts.small;
  if (small.gzipByteSaving === null || small.gzipByteSaving < MIN_GZIP_SAVING) {
    throw new Error(
      `HYA legacy/small gzip saving ${formatPercent(small.gzipByteSaving)} is below `
      + `${formatPercent(MIN_GZIP_SAVING)}; evidence was not updated.`,
    );
  }
  if (report.summary.unclassifiedFailureCount !== 0) {
    throw new Error(`HYA corpus has ${report.summary.unclassifiedFailureCount} unclassified conversion failures.`);
  }
  if (!report.environment.browser) return;
  for (const sample of report.samples) {
    if (!sample.fidelity || !sample.firstFrame || !sample.delivery) {
      throw new Error(`HYA browser evidence is incomplete for ${sample.id}.`);
    }
    if (
      sample.delivery.source.network.bytes !== sample.source.bytes
      || sample.delivery.hya.network.bytes !== sample.hya.bytes
      || !sample.delivery.source.network.streamed
      || !sample.delivery.hya.network.streamed
    ) throw new Error(`HYA HTTP streaming evidence is invalid for ${sample.id}.`);
    const externalResources = sample.delivery.externalResources ?? [];
    const expectedExternalBytes = sample.source.externalResourceBytes ?? 0;
    const deliveredExternalBytes = sum(externalResources, resource => resource.network.bytes);
    if (
      deliveredExternalBytes !== expectedExternalBytes
      || externalResources.some(resource => (
        resource.network.bytes !== resource.expectedBytes || !resource.network.streamed
      ))
      || sample.firstFrame.externalResourceBytes !== expectedExternalBytes
      || sample.firstFrame.externalResourceCount !== externalResources.length
      || sample.firstFrame.pendingResourceCount !== 0
      || sample.firstFrame.failedResourceCount !== 0
    ) throw new Error(`HYA external-resource delivery evidence is invalid for ${sample.id}.`);
  }
  if (!baseline) return;
  validateCohortRegression('legacy/small', small, baseline.cohorts?.small ?? baseline.summary);
  if (report.cohorts.large.sampleCount > 0 && baseline.cohorts?.large?.sampleCount > 0) {
    validateCohortRegression('large', report.cohorts.large, baseline.cohorts.large);
  }
}

function validateCohortRegression(label, cohort, baseline) {
  const fidelityFloor = baseline?.minimumFidelity;
  if (
    typeof fidelityFloor === 'number'
    && (cohort.minimumFidelity === null || cohort.minimumFidelity + 1e-9 < fidelityFloor)
  ) {
    throw new Error(
      `HYA ${label} minimum fidelity ${formatPercent(cohort.minimumFidelity)} is below `
      + `the formal cohort baseline ${formatPercent(fidelityFloor)}.`,
    );
  }
}

function sum(values, selector) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function finite(values) {
  return values.filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
}

function median(values) {
  return percentile(values, 0.5);
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? null;
}

function saving(value, original) {
  return original === 0 ? null : 1 - value / original;
}

export function formatPercent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

