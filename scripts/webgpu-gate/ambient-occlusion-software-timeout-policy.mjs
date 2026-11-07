import { createAoCostMatrix } from '../benchmark/ambient-occlusion-cost-model.mjs';

export const AO_SOFTWARE_TIMEOUT_ADMISSION = 'm25-g11-linux-swiftshader-ao-cost-600s';

// This release-specific investigation never produces native performance qualification.
export function assessAoSoftwareTimeout(error, context) {
  const reject = reason => ({ admitted: false, qualification: false, reason });
  const env = context.environment;
  if (context.version !== '0.2.3' || context.platform !== 'linux'
    || env.WEBGPU_SOFTWARE_AO_TIMEOUT_ADMISSION !== AO_SOFTWARE_TIMEOUT_ADMISSION
    || env.WEBGPU_ANGLE_BACKEND !== 'swiftshader' || env.BENCHMARK_PROFILE !== 'ci'
    || env.WEBGPU_REQUIRE_NATIVE === '1' || context.enforcePerformanceBudget
    || env.WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS === '1') return reject('outside-approved-software-ci');
  if (context.mode !== 'full' || context.warmup !== 8 || context.samples !== 30
    || context.timeoutMs !== 600_000 || !context.sourceUnchanged) return reject('sampling-contract-changed');
  const failure = error?.browserFailure;
  const snapshot = failure?.fixtureSnapshot;
  if (!failure || failure.fixtureSnapshotError || failure.angleBackend !== 'swiftshader'
    || !/^Chrome\/\d/.test(failure.browserProduct ?? '')
    || !Array.isArray(failure.browserErrors) || failure.browserErrors.length
    || !snapshot || !Array.isArray(snapshot.validationErrors) || snapshot.validationErrors.length
    || snapshot.deviceLost !== null) return reject('missing-or-erroneous-browser-snapshot');
  let url;
  try { url = new URL(failure.url); } catch { return reject('unexpected-fixture'); }
  if (url.hostname !== '127.0.0.1'
    || url.pathname !== '/scripts/webgpu-gate/ambient-occlusion-gpu-cost-fixture.html'
    || url.searchParams.get('warmup') !== '8' || url.searchParams.get('samples') !== '30'
    || [...url.searchParams].length !== 2) return reject('unexpected-fixture');
  if (snapshot.adapter?.vendor !== 'google' || snapshot.adapter.architecture !== 'swiftshader'
    || snapshot.configuration?.timestampQuery !== true
    || snapshot.configuration.warmupCount !== 8 || snapshot.configuration.sampleCount !== 30
    || snapshot.configuration.caseCount !== 18) return reject('unexpected-adapter-or-configuration');
  const matrix = createAoCostMatrix();
  const cases = snapshot.cases;
  const current = snapshot.currentCase;
  // Earlier stalls remain failures; the approved evidence reached the 4K matrix.
  if (!Array.isArray(cases) || cases.length < 12 || cases.length >= matrix.length
    || current?.id !== matrix[cases.length].id || !current.id.startsWith('4k.')
    || !['warmup', 'samples'].includes(current.stage)
    || !Number.isInteger(current.warmupCompleted) || current.warmupCompleted < 0
    || current.warmupCompleted > 8
    || (current.stage === 'samples' && current.warmupCompleted !== 8)) return reject('unexpected-progress');
  const progress = `AO GPU cost ${cases.length + 1}/18: ${current.id}`;
  if (failure.lastProgress !== progress
    || !String(error.message).startsWith(`Timed out waiting for Chrome/WebGPU fixture result (${progress}).`)) {
    return reject('not-the-approved-fixture-timeout');
  }
  const phases = ['occlusion', 'denoise', 'upscale', 'total'];
  const validSamples = (samples, length) => Array.isArray(samples) && samples.length === length
    && samples.every(value => Number.isFinite(value) && value > 0);
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index];
    const expected = matrix[index];
    if (item.id !== expected.id || item.scratch?.totalBytes !== expected.scratch.totalBytes
      || phases.some(phase => item.gpu?.[phase]?.sampleCount !== 30
        || !validSamples(item.gpu[phase].rawSamples, 30))) return reject('incomplete-or-altered-completed-case');
  }
  const partialSamples = current.rawSamples?.total?.length;
  if (!Number.isInteger(partialSamples) || partialSamples > 30
    || (current.stage === 'warmup' && partialSamples !== 0)
    || phases.some(phase => !validSamples(current.rawSamples?.[phase], partialSamples))) {
    return reject('incomplete-partial-samples');
  }
  return { admitted: true, id: AO_SOFTWARE_TIMEOUT_ADMISSION, status: 'investigation', qualification: false,
    completedCases: cases.length, plannedCases: 18, currentCase: current.id, partialSamples,
    timeoutMs: 600_000, webGpuErrors: 0, browserErrors: 0, deviceLost: null };
}
