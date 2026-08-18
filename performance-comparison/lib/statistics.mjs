export function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

export function summarizeSamples(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new TypeError('Timing samples must be a non-empty array of finite non-negative numbers.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const standardDeviation = Math.sqrt(variance);
  return {
    samples: values.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    standardDeviation,
    relativeStandardDeviation: mean === 0 ? 0 : standardDeviation / mean,
    rawSamples: values,
  };
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('median requires values.');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) * 0.5 : sorted[middle];
}

