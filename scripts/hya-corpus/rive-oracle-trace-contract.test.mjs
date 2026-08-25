import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRiveOracleTraceChannels, validateRiveOracleTrace } from './rive-oracle-trace-contract.mjs';
import { createRiveOracleChannelComparison } from './rive-oracle-channel-contract.mjs';
import { createRiveFullWorkloadScenario } from './rive-workload-scenario-builder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workloadPlan = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json'), 'utf8'));
const REVISION = 'b'.repeat(40);
const RIV_HASH = 'c'.repeat(64);

function validScenario() {
  return createRiveFullWorkloadScenario(workloadPlan, {
    id: 'fixture-full-scenario', assetId: 'fixture', rivSha256: RIV_HASH,
    selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' }, initialData: {}, initialResources: [],
    probe: {
      dataMutation: { operation: 'set', path: 'hud.health', value: 75 },
      pointer: { x: 32, y: 48, deltaX: 1, deltaY: 0, pointerId: 1, buttons: 1 },
      keyboard: { code: 'Enter', key: 'Enter' }, gamepad: { index: 0, axes: [0, 0], buttons: [1] },
      focusTarget: 'primary-control', semanticTarget: 'primary-control',
      resource: { resourceId: 'hero', missingResourceId: 'missing', expectedSha256: 'a'.repeat(64), invalidSha256: 'd'.repeat(64), appliedRevision: 'hero-r2', missingRevision: 'missing-r1', integrityRevision: 'hero-bad' },
    },
  });
}

function validTrace() {
  const artifactBytesByPath = new Map();
  const scenario = validScenario();
  const scenarioBytes = Buffer.from(`${JSON.stringify(scenario, null, 2)}\n`);
  const scenarioSha256 = createHash('sha256').update(scenarioBytes).digest('hex');
  const scenarioPath = 'review/candidates/rive-traces/fixture/scenario.json';
  artifactBytesByPath.set(scenarioPath, scenarioBytes);
  const officialChannels = {}; const hyaChannels = {}; const comparisons = {};
  for (const channel of requiredRiveOracleTraceChannels()) {
    const officialCapture = capture(channel, '@rive-app/webgl2@2.40.0', 'official');
    const hyaCapture = capture(channel, 'haiyue-exact-hya', 'hya');
    const generated = createRiveOracleChannelComparison({
      channel, officialCapture, hyaCapture,
      officialPath: `review/candidates/rive-traces/fixture/official-${channel}.json`,
      hyaPath: `review/candidates/rive-traces/fixture/hya-${channel}.json`,
      comparisonPath: `review/candidates/rive-traces/fixture/comparison-${channel}.json`,
      artifactBytesByPath, scenario, scenarioSha256, assetId: 'fixture', rivSha256: RIV_HASH,
    });
    artifactBytesByPath.set(generated.officialReference.path, generated.officialBytes);
    artifactBytesByPath.set(generated.hyaReference.path, generated.hyaBytes);
    artifactBytesByPath.set(generated.comparisonReference.path, generated.comparisonBytes);
    officialChannels[channel] = { ...generated.officialReference, sampleCount: officialCapture.samples.length, normalization: officialCapture.normalization };
    hyaChannels[channel] = { ...generated.hyaReference, sampleCount: hyaCapture.samples.length, normalization: hyaCapture.normalization };
    comparisons[channel] = {
      status: generated.comparison.status, differenceCount: generated.comparison.differenceCount, artifact: generated.comparisonReference,
      ...(channel === 'pixels' ? { maxChannelDelta: generated.comparison.maxChannelDelta, changedPixelRatio: generated.comparison.changedPixelRatio, ssim: generated.comparison.ssim } : {}),
    };
  }
  const metrics = Object.fromEntries(workloadPlan.measurement.metrics.map(name => [name, 1]));
  const lifecycle = scenario.lifecyclePaths.map(path => ({ path, status: 'passed', ownerResidual: 0 }));
  const measurement = { warmupIterations: 5, measuredIterations: 30, frameSampleCount: 120, queueCompleted: true, energySource: 'fixture-meter' };
  return {
    artifactBytesByPath,
    trace: {
      schemaVersion: 2, kind: 'haiyue-rive-oracle-differential-trace', status: 'passed', evidenceClass: 'clean-device-candidate',
      generatedAt: '2026-08-24T00:00:00.000Z', engineRevision: REVISION, engineDirty: false, corpusManifestSha256: 'a'.repeat(64),
      workloadPlanId: workloadPlan.id, workloadPlanSha256: 'e'.repeat(64),
      tuple: { id: 'rive-7.3-webgl2-2.40.0', oraclePackage: '@rive-app/webgl2@2.40.0', riveJsSha256: 'f'.repeat(64), riveWasmSha256: '0'.repeat(64) },
      assetId: 'fixture', rivSha256: RIV_HASH,
      environment: {
        deviceClass: 'windows-10-plus-device-a', physicalDevice: true, browser: 'chrome', browserVersion: '140.0.0.0', os: 'Windows 10 22H2', osBuild: '19045',
        gpu: 'Intel integrated fixture', machineIdSha256: 'd'.repeat(64), officialBackend: 'webgl2', hyaBackend: 'webgpu', nativeBackend: true,
        adapter: { vendor: 'Intel', architecture: 'integrated', device: 'fixture', description: 'fixture adapter' },
        dpr: 1, viewport: [800, 600], audioSampleRate: 48000, fonts: [], externalAssets: [],
      },
      scenarioArtifact: { path: scenarioPath, sha256: scenarioSha256, byteLength: scenarioBytes.byteLength, mediaType: 'application/json' },
      scenario,
      official: { runtime: '@rive-app/webgl2@2.40.0', freshOwnerPerReplay: true, replayCount: 2, channels: officialChannels, metrics, measurement, diagnostics: [], lifecycle, ownerResidual: 0 },
      hya: { runtime: 'haiyue-exact-hya', freshOwnerPerReplay: true, replayCount: 2, channels: hyaChannels, metrics, measurement, diagnostics: [], lifecycle, ownerResidual: 0 },
      comparison: { channels: comparisons, structuralDifferenceCount: 0, unclassifiedFailureCount: 0, deterministicReplay: true, sameActionStream: true, sameMachine: true, sameRevision: true },
    },
  };

  function capture(channel, runtime, label) {
    let value = { channel, normalized: true };
    if (channel === 'pixels') {
      const bytes = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]);
      const path = `review/candidates/rive-traces/fixture/${label}.rgba`;
      artifactBytesByPath.set(path, bytes);
      value = { width: 2, height: 1, dpr: 1, rgba: { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mediaType: 'application/octet-stream' } };
    }
    const samples = [];
    for (let replayIndex = 0; replayIndex < scenario.replayCount; replayIndex++) for (const atMicros of scenario.clockStepsMicros) samples.push({
      replayIndex, atMicros, actionIds: scenario.actions.filter(action => action.atMicros === atMicros).map(action => action.id), value,
    });
    return { schemaVersion: 1, kind: 'haiyue-rive-normalized-channel-capture', channel, runtime, assetId: 'fixture', rivSha256: RIV_HASH, scenarioSha256, normalization: `haiyue-rive-${channel}@1`, replayCount: scenario.replayCount, samples };
  }
}

test('oracle trace v2 binds every observable to artifact bytes and the full workload', () => {
  const { trace, artifactBytesByPath } = validTrace();
  const result = validateRiveOracleTrace(trace, { formal: true, expectedRevision: REVISION, expectedManifestSha256: 'a'.repeat(64), workloadPlan, artifactBytesByPath });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
});

test('formal device policy accepts any physical GPU on Windows 10+ and rejects older Windows', () => {
  const accepted = validTrace();
  accepted.trace.environment.gpu = 'Any physical GPU';
  accepted.trace.environment.adapter.architecture = 'unspecified-physical';
  const acceptedResult = validateRiveOracleTrace(accepted.trace, { formal: true, expectedRevision: REVISION, expectedManifestSha256: 'a'.repeat(64), workloadPlan, artifactBytesByPath: accepted.artifactBytesByPath });
  assert.equal(acceptedResult.status, 'passed', acceptedResult.violations.join('\n'));
  accepted.trace.environment.os = 'Windows 9';
  const rejectedResult = validateRiveOracleTrace(accepted.trace, { workloadPlan, artifactBytesByPath: accepted.artifactBytesByPath });
  assert.ok(rejectedResult.violations.some(value => value.includes('Windows 10 or later')));
});

test('structural parity cannot be hidden by a passing pixel score', () => {
  const { trace } = validTrace();
  trace.comparison.structuralDifferenceCount = 1;
  trace.comparison.channels.stateMachineState.differenceCount = 1;
  const result = validateRiveOracleTrace(trace, { workloadPlan });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('structural difference count')));
  assert.ok(result.violations.some(value => value.includes('stateMachineState difference count')));
});

test('formal traces reject missing bytes, dirty revisions, residual owners and tolerance drift', () => {
  const { trace } = validTrace();
  trace.engineDirty = true;
  trace.hya.ownerResidual = 1;
  trace.comparison.channels.pixels.ssim = 0.99;
  const result = validateRiveOracleTrace(trace, { formal: true, workloadPlan, artifactBytesByPath: new Map() });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('bytes are unavailable')));
  assert.ok(result.violations.some(value => value.includes('formal Engine dirty state')));
  assert.ok(result.violations.some(value => value.includes('HYA owner residual')));
  assert.ok(result.violations.some(value => value.includes('SSIM')));
});

test('trace rejects an inline action stream that differs from the pinned scenario artifact', () => {
  const { trace, artifactBytesByPath } = validTrace();
  trace.scenario.actions[0].payload = { tampered: true };
  const result = validateRiveOracleTrace(trace, { workloadPlan, artifactBytesByPath });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('inline scenario differs')));
});

test('trace recomputation exposes a normalized capture that differs from its comparison claim', () => {
  const { trace, artifactBytesByPath } = validTrace();
  const reference = trace.hya.channels.dataValues;
  const artifact = JSON.parse(artifactBytesByPath.get(reference.path).toString('utf8'));
  artifact.samples[0].value = { channel: 'dataValues', normalized: false };
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  artifactBytesByPath.set(reference.path, bytes);
  reference.sha256 = createHash('sha256').update(bytes).digest('hex');
  reference.byteLength = bytes.byteLength;
  const result = validateRiveOracleTrace(trace, { formal: true, workloadPlan, artifactBytesByPath });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('validator recomputation') || value.includes('recomputed status')));
});
