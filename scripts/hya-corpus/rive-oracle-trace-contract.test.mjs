import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requiredRiveOracleTraceChannels,
  validateRiveOracleTrace,
} from './rive-oracle-trace-contract.mjs';

const HASH = 'a'.repeat(64);
const REVISION = 'b'.repeat(40);

function validTrace() {
  const channels = Object.fromEntries(requiredRiveOracleTraceChannels().map(name => [name, {
    sha256: HASH,
    byteLength: 16,
    sampleCount: 2,
  }]));
  const comparisons = Object.fromEntries(requiredRiveOracleTraceChannels().map(name => [name, {
    status: 'passed',
    differenceCount: 0,
    ...(name === 'pixels' ? { maxChannelDelta: 0, changedPixelRatio: 0, ssim: 1 } : {}),
  }]));
  return {
    schemaVersion: 1,
    kind: 'haiyue-rive-oracle-differential-trace',
    status: 'passed',
    evidenceClass: 'clean-device-candidate',
    generatedAt: '2026-08-24T00:00:00.000Z',
    engineRevision: REVISION,
    engineDirty: false,
    corpusManifestSha256: HASH,
    tuple: {
      id: 'rive-7.3-webgl2-2.40.0',
      oraclePackage: '@rive-app/webgl2@2.40.0',
      riveJsSha256: HASH,
      riveWasmSha256: HASH,
    },
    assetId: 'fixture',
    rivSha256: HASH,
    environment: {
      deviceClass: 'windows-10-integrated',
      browser: 'chrome',
      browserVersion: '140.0.0.0',
      os: 'Windows 10 22H2',
      gpu: 'Intel integrated fixture',
      dpr: 1,
      viewport: [800, 600],
      audioSampleRate: 48000,
      fonts: [],
      externalAssets: [],
    },
    scenario: {
      selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' },
      initialData: {},
      clockStepsMicros: [0, 16667],
      actions: [{ atMicros: 0, kind: 'initialize' }],
    },
    official: { runtime: '@rive-app/webgl2@2.40.0', channels, diagnostics: [], ownerResidual: 0 },
    hya: { runtime: 'haiyue-exact-hya', channels, diagnostics: [], ownerResidual: 0 },
    comparison: {
      channels: comparisons,
      structuralDifferenceCount: 0,
      unclassifiedFailureCount: 0,
      deterministicReplay: true,
    },
  };
}

test('oracle trace contract accepts every frozen observable channel', () => {
  const result = validateRiveOracleTrace(validTrace(), {
    formal: true,
    expectedRevision: REVISION,
    expectedManifestSha256: HASH,
  });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('structural parity cannot be hidden by a passing pixel score', () => {
  const trace = validTrace();
  trace.comparison.structuralDifferenceCount = 1;
  trace.comparison.channels.stateMachineState.differenceCount = 1;
  const result = validateRiveOracleTrace(trace);
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('structural difference count')));
  assert.ok(result.violations.some(value => value.includes('stateMachineState difference count')));
});

test('formal traces reject dirty revisions, residual owners and tolerance drift', () => {
  const trace = validTrace();
  trace.engineDirty = true;
  trace.hya.ownerResidual = 1;
  trace.comparison.channels.pixels.ssim = 0.99;
  const result = validateRiveOracleTrace(trace, { formal: true });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('formal Engine dirty state')));
  assert.ok(result.violations.some(value => value.includes('HYA owner residual')));
  assert.ok(result.violations.some(value => value.includes('SSIM')));
});
