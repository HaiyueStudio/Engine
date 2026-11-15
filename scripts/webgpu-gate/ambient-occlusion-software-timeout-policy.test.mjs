import assert from 'node:assert/strict';
import test from 'node:test';
import { createAoCostMatrix } from '../benchmark/ambient-occlusion-cost-model.mjs';
import { AO_SOFTWARE_TIMEOUT_ADMISSION, assessAoSoftwareTimeout } from './ambient-occlusion-software-timeout-policy.mjs';

function fixture() {
  const phases = ['occlusion', 'denoise', 'upscale', 'total'];
  const cases = createAoCostMatrix().slice(0, 14).map(item => ({ ...item,
    gpu: Object.fromEntries(phases.map(phase => [phase, { sampleCount: 30, rawSamples: Array(30).fill(1) }])),
  }));
  const progress = 'AO GPU cost 15/18: 4k.medium.r8unorm';
  const error = new Error(`Timed out waiting for Chrome/WebGPU fixture result (${progress}).`);
  error.browserFailure = {
    url: 'http://127.0.0.1:12345/scripts/webgpu-gate/ambient-occlusion-gpu-cost-fixture.html?warmup=8&samples=30',
    angleBackend: 'swiftshader', browserProduct: 'Chrome/156.0', browserErrors: [], lastProgress: progress,
    fixtureSnapshot: {
      adapter: { vendor: 'google', architecture: 'swiftshader' },
      configuration: { warmupCount: 8, sampleCount: 30, caseCount: 18, timestampQuery: true },
      validationErrors: [], deviceLost: null, cases,
      currentCase: { id: '4k.medium.r8unorm', stage: 'samples', warmupCompleted: 8,
        rawSamples: Object.fromEntries(phases.map(phase => [phase, Array(25).fill(1)])),
      },
    },
  };
  const context = { version: '0.2.3', platform: 'linux', mode: 'full', warmup: 8, samples: 30,
    timeoutMs: 600_000, sourceUnchanged: true, enforcePerformanceBudget: false,
    environment: { WEBGPU_SOFTWARE_AO_TIMEOUT_ADMISSION: AO_SOFTWARE_TIMEOUT_ADMISSION,
      WEBGPU_ANGLE_BACKEND: 'swiftshader', BENCHMARK_PROFILE: 'ci' },
  };
  return { error, context };
}

test('approved software timeout continues CI while remaining an unqualified investigation', () => {
  const { error, context } = fixture();
  const decision = assessAoSoftwareTimeout(error, context);
  assert.equal(decision.admitted, true);
  assert.equal(decision.status, 'investigation');
  assert.equal(decision.qualification, false);
  assert.equal(decision.completedCases, 14);
  assert.equal(decision.partialSamples, 25);
  assert.equal(decision.timeoutMs, 600_000);
  assert.equal(error.browserFailure.fixtureSnapshot.cases.length, 14);
});

const denials = {
  'default environment': (_, c) => { c.environment = {}; },
  'another release': (_, c) => { c.version = '0.2.4'; },
  'Windows': (_, c) => { c.platform = 'win32'; },
  'native required': (_, c) => { c.environment.WEBGPU_REQUIRE_NATIVE = '1'; },
  'native performance enforcement': (_, c) => { c.enforcePerformanceBudget = true; },
  'explicit performance enforcement': (_, c) => { c.environment.WEBGPU_ENFORCE_DEVICE_PERFORMANCE_BUDGETS = '1'; },
  'another backend': (_, c) => { c.environment.WEBGPU_ANGLE_BACKEND = 'vulkan'; },
  'another profile': (_, c) => { c.environment.BENCHMARK_PROFILE = 'formal'; },
  'smoke': (_, c) => { c.mode = 'smoke'; },
  'changed deadline': (_, c) => { c.timeoutMs++; },
  'changed samples': (_, c) => { c.samples--; },
  'changed warmup': (_, c) => { c.warmup--; },
  'changed executable inputs': (_, c) => { c.sourceUnchanged = false; },
  'different timeout': e => { e.message = 'Timed out waiting for browser startup.'; },
  'missing snapshot': e => { delete e.browserFailure.fixtureSnapshot; },
  'capture failed': e => { e.browserFailure.fixtureSnapshotError = 'CDP error'; },
  'browser exception': e => { e.browserFailure.browserErrors.push({ kind: 'exception', message: 'crash' }); },
  'GPU error': e => { e.browserFailure.fixtureSnapshot.validationErrors.push('validation'); },
  'device lost': e => { e.browserFailure.fixtureSnapshot.deviceLost = { reason: 'unknown' }; },
  'unknown device loss status': e => { delete e.browserFailure.fixtureSnapshot.deviceLost; },
  'hardware adapter': e => { e.browserFailure.fixtureSnapshot.adapter.architecture = 'pascal'; },
  'timestamp unavailable': e => { e.browserFailure.fixtureSnapshot.configuration.timestampQuery = false; },
  'altered fixture query': e => { e.browserFailure.url += '&alternate=1'; },
  'other fixture': e => { e.browserFailure.url = 'http://127.0.0.1/other.html?warmup=8&samples=30'; },
  'early matrix stall': e => { e.browserFailure.fixtureSnapshot.cases.splice(10); },
  'case order changed': e => { e.browserFailure.fixtureSnapshot.cases.reverse(); },
  'completed samples missing': e => { e.browserFailure.fixtureSnapshot.cases[0].gpu.total.rawSamples.pop(); },
  'partial phase missing': e => { e.browserFailure.fixtureSnapshot.currentCase.rawSamples.occlusion.pop(); },
  'invalid sample': e => { e.browserFailure.fixtureSnapshot.currentCase.rawSamples.total[0] = NaN; },
  'warmup incomplete': e => { e.browserFailure.fixtureSnapshot.currentCase.warmupCompleted = 7; },
  'different resource count': e => { e.browserFailure.fixtureSnapshot.cases[0].scratch = { totalBytes: 1 }; },
};
for (const [name, change] of Object.entries(denials)) {
  test(`keeps ${name} blocking`, () => {
    const { error, context } = fixture();
    change(error, context);
    assert.equal(assessAoSoftwareTimeout(error, context).admitted, false);
  });
}
