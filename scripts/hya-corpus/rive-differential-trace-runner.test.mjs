import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runRiveDifferentialTrace } from './rive-differential-trace-runner.mjs';
import { requiredRiveOracleTraceChannels } from './rive-oracle-trace-contract.mjs';
import { createRiveFullWorkloadScenario } from './rive-workload-scenario-builder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workloadPlanBytes = readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json'));
const workloadPlan = JSON.parse(workloadPlanBytes);
const rivBytes = new Uint8Array([82, 73, 86, 69, 7, 3, 0, 0]);
const rivSha256 = hash(rivBytes);

test('differential runner executes both native adapters and recomputes every channel artifact', async () => {
  const scenario = createRiveFullWorkloadScenario(workloadPlan, {
    id: 'runner-real-data-plane', assetId: 'runner-asset', rivSha256,
    selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' }, initialData: {}, initialResources: [],
    probe: {
      dataMutation: { operation: 'set', path: 'probe.value', value: 1 },
      pointer: { x: 1, y: 1, deltaX: 1, deltaY: 1, pointerId: 1, buttons: 1 },
      keyboard: { code: 'Enter', key: 'Enter' }, gamepad: { index: 0, axes: [0], buttons: [1] },
      focusTarget: 'Main', semanticTarget: 'Main',
      resource: { resourceId: 'resource', missingResourceId: 'missing', expectedSha256: 'a'.repeat(64), invalidSha256: 'b'.repeat(64), appliedRevision: 'r2', missingRevision: 'missing', integrityRevision: 'bad' },
    },
  });
  const calls = [];
  const environment = {
    deviceClass: 'windows-10-plus-device-a', physicalDevice: true, browser: 'chrome', browserVersion: '140', os: 'Windows 11', osBuild: 'fixture', gpu: 'native fixture', machineIdSha256: 'c'.repeat(64),
    officialBackend: 'webgl2', hyaBackend: 'webgpu', nativeBackend: true,
    browserLogCaptured: true, consoleErrorCount: 0, exceptionCount: 0,
    adapter: { vendor: 'fixture', architecture: 'discrete', device: 'fixture', description: 'test-owned native adapter descriptor' },
    dpr: 1, viewport: [800, 600], audioSampleRate: 48000, fonts: [], externalAssets: [],
  };
  const result = await runRiveDifferentialTrace({
    assetId: 'runner-asset', rivSha256, rivBytes, scenario,
    scenarioPath: 'review/candidates/rive-traces/runner/scenario.json', artifactPrefix: 'review/candidates/rive-traces/runner',
    convert: async bytes => {
      calls.push(`convert:${bytes.byteLength}`);
      return {
        hyaBytes: new Uint8Array([1]), packageBytes: new Uint8Array([2]),
        report: {
          tuple: {
            adapterId: 'fixture-adapter', adapterRevisionSha256: '4'.repeat(64), evaluatorId: 'fixture-evaluator',
            evaluatorRevisionSha256: '5'.repeat(64), optionsRevision: 'rive-7.3-production-v1',
          },
        },
      };
    },
    officialAdapter: adapter('@rive-app/webgl2@2.40.0', 'webgl2', 'official', calls),
    hyaAdapter: adapter('haiyue-exact-hya', 'webgpu', 'hya', calls),
    environment,
    workloadPlan, workloadPlanSha256: hash(workloadPlanBytes), corpusManifestSha256: 'd'.repeat(64),
    tuple: { id: 'rive-7.3-webgl2-2.40.0', oraclePackage: '@rive-app/webgl2@2.40.0', riveJsSha256: 'e'.repeat(64), riveWasmSha256: 'f'.repeat(64) },
    engineRevision: '1'.repeat(40), engineDirty: true, generatedAt: '2026-08-25T00:00:00.000Z', evidenceClass: 'diagnostic', formal: false,
  });
  assert.deepEqual(calls, [`convert:${rivBytes.byteLength}`, 'official:riv', 'hya:hya-package']);
  assert.equal(result.trace.status, 'passed');
  assert.equal(result.validation.status, 'passed', result.validation.violations.join('\n'));
  assert.equal(result.trace.adapters.capabilityEvaluator.evaluatorId, 'fixture-evaluator');
  assert.equal(result.trace.adapters.officialCapture.runtime, '@rive-app/webgl2@2.40.0');
  assert.equal(result.trace.adapters.hyaCapture.backend, 'webgpu');
  assert.deepEqual(result.trace.environment, environment);
  assert.equal(Object.keys(result.trace.comparison.channels).length, requiredRiveOracleTraceChannels().length);
  assert.ok(result.artifactBytesByPath.has('review/candidates/rive-traces/runner/comparison-pixels.json'));
});

function adapter(runtime, backend, label, calls) {
  return {
    descriptor: { id: `${label}-capture`, revisionSha256: label === 'official' ? '2'.repeat(64) : '3'.repeat(64), runtime, backend, nativeBackend: true },
    async capture(request) {
      calls.push(`${label}:${request.runtimeInput.kind}`);
      const pixelPath = `review/candidates/rive-traces/runner/${label}.rgba`;
      const pixelBytes = Buffer.from([10, 20, 30, 255]);
      const channels = {};
      for (const channel of requiredRiveOracleTraceChannels()) {
        const samples = [];
        for (let replayIndex = 0; replayIndex < request.scenario.replayCount; replayIndex++) {
          for (const atMicros of request.scenario.clockStepsMicros) samples.push({
            replayIndex, atMicros,
            actionIds: request.scenario.actions.filter(action => action.atMicros === atMicros).map(action => action.id),
            value: channel === 'pixels'
              ? { width: 1, height: 1, dpr: 1, rgba: { path: pixelPath, sha256: hash(pixelBytes), byteLength: pixelBytes.byteLength, mediaType: 'application/octet-stream' } }
              : { normalized: channel },
          });
        }
        channels[channel] = {
          schemaVersion: 1, kind: 'haiyue-rive-normalized-channel-capture', channel, runtime,
          assetId: request.assetId, rivSha256: request.rivSha256, scenarioSha256: request.scenarioSha256,
          normalization: `haiyue-rive-${channel}@1`, replayCount: request.scenario.replayCount, samples,
        };
      }
      return {
        environment: structuredClone(request.environment),
        channels, artifactBytesByPath: new Map([[pixelPath, pixelBytes]]), freshOwnerPerReplay: true,
        metrics: Object.fromEntries(workloadPlan.measurement.metrics.map(name => [name, 1])),
        measurement: { warmupIterations: 1, measuredIterations: 1, frameSampleCount: 1, queueCompleted: true, energySource: 'test-meter' },
        diagnostics: [], lifecycle: request.scenario.lifecyclePaths.map(path => ({ path, status: 'passed', ownerResidual: 0 })), ownerResidual: 0,
      };
    },
  };
}

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
