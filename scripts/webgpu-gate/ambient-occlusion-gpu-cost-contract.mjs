import { createAoCostMatrix } from '../benchmark/ambient-occlusion-cost-model.mjs';

export const AMBIENT_OCCLUSION_GPU_COST_SUITE = 'ambient-occlusion.gpu-cost';
export const AMBIENT_OCCLUSION_GPU_COST_SCHEMA_VERSION = 2;

export function validateAmbientOcclusionGpuCostArtifact(
  artifact,
  suiteConfig,
  { mode = 'smoke' } = {},
) {
  const violations = [];
  const expectedArtifact = suiteConfig?.artifact ?? {};
  requireEqual(artifact?.schemaVersion, AMBIENT_OCCLUSION_GPU_COST_SCHEMA_VERSION, 'schemaVersion');
  requireEqual(artifact?.suite, AMBIENT_OCCLUSION_GPU_COST_SUITE, 'suite');
  requireOneOf(artifact?.status, ['passed', 'unavailable'], 'status');
  requireEqual(expectedArtifact.schemaVersion, AMBIENT_OCCLUSION_GPU_COST_SCHEMA_VERSION, 'budget artifact schemaVersion');
  if (!Number.isFinite(Date.parse(artifact?.generatedAt ?? ''))) violations.push('generatedAt is missing or invalid');
  if (typeof artifact?.browser !== 'string' || artifact.browser.length === 0) violations.push('browser identity is missing');
  if (!artifact?.adapter || typeof artifact.adapter !== 'object') violations.push('adapter identity is missing');

  if (artifact?.status === 'unavailable') {
    requireEqual(artifact?.capabilities?.timestampQuery?.status, 'unavailable', 'timestamp-query status');
    if (typeof artifact?.capabilities?.timestampQuery?.reason !== 'string'
      || artifact.capabilities.timestampQuery.reason.length === 0) {
      violations.push('timestamp-query unavailable reason is missing');
    }
    if ((artifact?.cases?.length ?? 0) !== 0) violations.push('unavailable artifact must not contain timing cases');
    return report();
  }

  requireEqual(artifact?.capabilities?.timestampQuery?.status, 'available', 'timestamp-query status');
  requireEqual(artifact?.validation?.errorCount, 0, 'WebGPU validation error count');
  requireEqual(artifact?.configuration?.algorithm, 'gtao', 'algorithm');
  requireEqual(artifact?.configuration?.resolutionScale, expectedArtifact.resolutionScale, 'resolution scale');
  requireEqual(artifact?.configuration?.caseCount, expectedArtifact.caseCount, 'configuration case count');
  requireEqual(artifact?.formatDecision?.selected, expectedArtifact.selectedScratchFormat, 'selected scratch format');
  requireEqual(artifact?.formatDecision?.optionalFloatFilteringRequired, false, 'optional float filtering dependency');

  const expectedCases = new Map(createAoCostMatrix().map(item => [item.id, item]));
  const cases = artifact?.cases ?? [];
  requireEqual(cases.length, expectedArtifact.caseCount, 'case count');
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item?.id)) violations.push(`duplicate case ${String(item?.id)}`);
    seen.add(item?.id);
    const expected = expectedCases.get(item?.id);
    if (!expected) {
      violations.push(`unknown case ${String(item?.id)}`);
      continue;
    }
    requireEqual(item.resolution?.id, expected.resolution.id, `${item.id} resolution`);
    requireEqual(item.quality?.id, expected.quality.id, `${item.id} quality`);
    requireEqual(item.scratchFormat?.id, expected.scratchFormat.id, `${item.id} scratch format`);
    requireEqual(item.scratch?.totalBytes, expected.scratch.totalBytes, `${item.id} scratch bytes`);
    requireEqual(
      item.estimatedBandwidth?.totalBytes,
      expected.estimatedBandwidth.totalBytes,
      `${item.id} estimated bandwidth bytes`,
    );
    for (const phase of ['occlusion', 'denoise', 'upscale', 'total']) {
      validateTiming(item.id, phase, item.gpu?.[phase], artifact.configuration?.sampleCount);
    }
    validatePerSampleTotal(item);

    if (item.scratchFormat.id === expectedArtifact.selectedScratchFormat) {
      const maxScratchBytes = expectedArtifact.maxScratchBytes?.[item.resolution.id];
      if (!Number.isFinite(maxScratchBytes) || item.scratch.totalBytes > maxScratchBytes) {
        violations.push(`${item.id} scratch bytes ${item.scratch.totalBytes} exceed ${String(maxScratchBytes)}`);
      }
      const maxBandwidthBytes = expectedArtifact.maxEstimatedBandwidthBytes?.[item.id];
      if (!Number.isFinite(maxBandwidthBytes)
        || item.estimatedBandwidth.totalBytes > maxBandwidthBytes) {
        violations.push(
          `${item.id} estimated bandwidth ${item.estimatedBandwidth.totalBytes} exceeds ${String(maxBandwidthBytes)}`,
        );
      }
    }
  }
  for (const id of expectedCases.keys()) {
    if (!seen.has(id)) violations.push(`missing case ${id}`);
  }
  return report();

  function validateTiming(caseId, phase, timing, expectedSamples) {
    if (!timing || !Number.isInteger(timing.sampleCount) || timing.sampleCount !== expectedSamples) {
      violations.push(`${caseId} ${phase} sampleCount does not match configuration`);
      return;
    }
    if (!Array.isArray(timing.rawSamples) || timing.rawSamples.length !== expectedSamples) {
      violations.push(`${caseId} ${phase} rawSamples do not match configuration`);
      return;
    }
    if (timing.rawSamples.some(value => !Number.isFinite(value) || value < 0)) {
      violations.push(`${caseId} ${phase} contains an invalid timing sample`);
      return;
    }
    const summary = summarize(timing.rawSamples);
    for (const field of ['p50', 'p95', 'min', 'max']) {
      if (!nearlyEqual(timing[field], summary[field])) {
        violations.push(`${caseId} ${phase} ${field} does not match rawSamples`);
      }
    }
  }

  function validatePerSampleTotal(item) {
    const channels = ['occlusion', 'denoise', 'upscale'].map(phase => item.gpu?.[phase]?.rawSamples ?? []);
    const totals = item.gpu?.total?.rawSamples ?? [];
    for (let index = 0; index < totals.length; index++) {
      const expected = channels.reduce((sum, channel) => sum + (channel[index] ?? Number.NaN), 0);
      if (!nearlyEqual(totals[index], expected)) {
        violations.push(`${item.id} total sample ${index} does not equal its three phases`);
        break;
      }
    }
  }

  function requireEqual(actual, expected, label) {
    if (actual !== expected) violations.push(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }

  function requireOneOf(actual, expected, label) {
    if (!expected.includes(actual)) violations.push(`${label}: expected ${expected.join(' or ')}, received ${String(actual)}`);
  }

  function report() {
    return {
      schemaVersion: 1,
      contract: 'haiyue-ambient-occlusion-gpu-cost-artifact@2',
      mode,
      executionStatus: artifact?.status ?? 'invalid',
      status: violations.length === 0 ? 'passed' : 'failed',
      violations,
    };
  }
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function nearlyEqual(left, right) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}
