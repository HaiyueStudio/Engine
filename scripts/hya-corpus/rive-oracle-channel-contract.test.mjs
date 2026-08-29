import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createRiveOracleChannelComparison,
  validateRiveOracleChannelEvidence,
} from './rive-oracle-channel-contract.mjs';
import { createRiveFullWorkloadScenario } from './rive-workload-scenario-builder.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const plan = JSON.parse(readFileSync(resolve(root, 'animation-spec/corpus/rive/rive-g11-workload-plan.json'), 'utf8'));
const RIV_HASH = 'a'.repeat(64);
const scenario = createRiveFullWorkloadScenario(plan, {
  id: 'channel-contract-fixture', assetId: 'fixture', rivSha256: RIV_HASH,
  selection: { artboard: 'Main', animation: 'Idle', stateMachine: 'Machine' }, initialData: {}, initialResources: [],
  probe: {
    dataMutation: { operation: 'set', path: 'hud.health', value: 75 },
    pointer: { x: 32, y: 48, deltaX: 1, deltaY: 0, pointerId: 1, buttons: 1 },
    keyboard: { code: 'Enter', key: 'Enter' }, gamepad: { index: 0, axes: [0, 0], buttons: [1] },
    focusTarget: 'primary-control', semanticTarget: 'primary-control',
    resource: { resourceId: 'hero', missingResourceId: 'missing', expectedSha256: 'b'.repeat(64), invalidSha256: 'c'.repeat(64), appliedRevision: 'hero-r2', missingRevision: 'missing-r1', integrityRevision: 'hero-bad' },
  },
});
const scenarioSha256 = createHash('sha256').update(`${JSON.stringify(scenario, null, 2)}\n`).digest('hex');

test('structured channel evidence is recomputed from every replay and clock sample', () => {
  const artifactBytesByPath = new Map();
  const officialCapture = capture('stateMachineState', '@rive-app/webgl2@2.40.0', () => ({ active: ['Idle'], inputs: { health: 75 } }));
  const hyaCapture = capture('stateMachineState', 'haiyue-exact-hya', () => ({ active: ['Idle'], inputs: { health: 75 } }));
  const evidence = assemble('stateMachineState', officialCapture, hyaCapture, artifactBytesByPath);
  const result = validateRiveOracleChannelEvidence({ ...evidence, artifactBytesByPath, scenario, scenarioSha256, assetId: 'fixture', rivSha256: RIV_HASH, formal: true });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
  assert.equal(result.recomputed.samples.length, scenario.replayCount * scenario.clockStepsMicros.length);
  assert.equal(result.recomputed.differenceCount, 0);
});

test('a comparison artifact cannot conceal a structured capture difference', () => {
  const artifactBytesByPath = new Map();
  const officialCapture = capture('dataValues', '@rive-app/webgl2@2.40.0', () => ({ health: 75 }));
  const hyaCapture = capture('dataValues', 'haiyue-exact-hya', ({ replayIndex, atMicros }) => ({ health: replayIndex === 1 && atMicros === 2_000_000 ? 74 : 75 }));
  const evidence = assemble('dataValues', officialCapture, hyaCapture, artifactBytesByPath);
  evidence.comparison.status = 'passed'; evidence.comparison.differenceCount = 0;
  const comparisonBytes = jsonBytes(evidence.comparison);
  artifactBytesByPath.set(evidence.comparisonReference.path, comparisonBytes);
  evidence.comparisonReference = jsonReference(evidence.comparisonReference.path, comparisonBytes);
  const result = validateRiveOracleChannelEvidence({ ...evidence, artifactBytesByPath, scenario, scenarioSha256, assetId: 'fixture', rivSha256: RIV_HASH, formal: true });
  assert.equal(result.status, 'failed');
  assert.ok(result.violations.some(value => value.includes('differs from validator recomputation')));
  assert.equal(result.recomputed.differenceCount, 1);
});

test('pixel evidence binds raw RGBA bytes and recomputes frozen thresholds', () => {
  const artifactBytesByPath = new Map();
  const officialRgba = Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]);
  const hyaRgba = Buffer.from(officialRgba); hyaRgba[0] = 3;
  const officialPixel = pixelValue('official', officialRgba, artifactBytesByPath);
  const hyaPixel = pixelValue('hya', hyaRgba, artifactBytesByPath);
  const officialCapture = capture('pixels', '@rive-app/webgl2@2.40.0', () => officialPixel);
  const hyaCapture = capture('pixels', 'haiyue-exact-hya', () => hyaPixel);
  const evidence = assemble('pixels', officialCapture, hyaCapture, artifactBytesByPath);
  const result = validateRiveOracleChannelEvidence({ ...evidence, artifactBytesByPath, scenario, scenarioSha256, assetId: 'fixture', rivSha256: RIV_HASH, formal: true });
  assert.equal(result.status, 'passed', result.violations.join('\n'));
  assert.equal(result.recomputed.status, 'failed');
  assert.equal(result.recomputed.differenceCount, scenario.replayCount * scenario.clockStepsMicros.length);
  assert.ok(result.recomputed.maxChannelDelta > 2 / 255);
});

test('pixel evidence treats in-tolerance rounding consistently and rejects transparent proxy frames', () => {
  const artifactBytesByPath = new Map();
  const officialRgba = Buffer.from([40, 40, 40, 255, 116, 116, 116, 255]);
  const hyaRgba = Buffer.from(officialRgba); hyaRgba[0] += 2;
  const generated = assemble(
    'pixels',
    capture('pixels', '@rive-app/webgl2@2.40.0', () => pixelValue('tolerant-official', officialRgba, artifactBytesByPath)),
    capture('pixels', 'haiyue-exact-hya', () => pixelValue('tolerant-hya', hyaRgba, artifactBytesByPath)),
    artifactBytesByPath,
  );
  assert.equal(generated.comparison.status, 'passed');
  assert.equal(generated.comparison.maxChannelDelta, 2 / 255);
  assert.equal(generated.comparison.changedPixelRatio, 0);

  const transparentArtifacts = new Map(); const transparent = Buffer.alloc(8);
  assert.throws(() => assemble(
    'pixels',
    capture('pixels', '@rive-app/webgl2@2.40.0', () => pixelValue('blank-official', transparent, transparentArtifacts)),
    capture('pixels', 'haiyue-exact-hya', () => pixelValue('blank-hya', transparent, transparentArtifacts)),
    transparentArtifacts,
  ), /framebuffer population is fully transparent/u);

  const mixedArtifacts = new Map();
  assert.doesNotThrow(() => assemble(
    'pixels',
    capture('pixels', '@rive-app/webgl2@2.40.0', ({ atMicros }) => pixelValue(`mixed-official-${atMicros}`, atMicros === 0 ? transparent : officialRgba, mixedArtifacts)),
    capture('pixels', 'haiyue-exact-hya', ({ atMicros }) => pixelValue(`mixed-hya-${atMicros}`, atMicros === 0 ? transparent : officialRgba, mixedArtifacts)),
    mixedArtifacts,
  ));
});

test('the hash-pinned structural-only grid fixture permits transparent pixels but forbids visual submission', () => {
  const assetId = 'official-grid-placement-bound';
  const rivSha256 = '02dca529414c584c38e7c438e501e276d89337588d9042381120d330784380d0';
  const transparentArtifacts = new Map(); const transparent = Buffer.alloc(8);
  const officialPixels = capture('pixels', '@rive-app/webgl2@2.40.0', () => pixelValue('grid-official', transparent, transparentArtifacts));
  const hyaPixels = capture('pixels', 'haiyue-exact-hya', () => pixelValue('grid-hya', transparent, transparentArtifacts));
  bindCaptureIdentity(officialPixels, assetId, rivSha256); bindCaptureIdentity(hyaPixels, assetId, rivSha256);
  assert.equal(createRiveOracleChannelComparison({
    channel: 'pixels', officialCapture: officialPixels, hyaCapture: hyaPixels,
    officialPath: 'evidence/grid-pixels-official.json', hyaPath: 'evidence/grid-pixels-hya.json', comparisonPath: 'evidence/grid-pixels-comparison.json',
    artifactBytesByPath: transparentArtifacts, scenario, scenarioSha256, assetId, rivSha256,
  }).comparison.status, 'passed');

  const topology = {
    semantic: { oracle: 'neutral-drawable-topology@1', items: [
      { id: 'artboard', family: 'structure', drawOrder: 0 },
      { id: 'layout-a', family: 'structure', drawOrder: 1 },
      { id: 'layout-b', family: 'structure', drawOrder: 2 },
    ] },
  };
  const officialGeometry = capture('geometryAndDrawOrder', '@rive-app/webgl2@2.40.0', () => ({
    artboard: 'Main', viewport: 'desktop-1x', topology: { ...topology, submission: { oracle: 'native-render-command-stream@1', backend: 'webgl2', artboardBounds: [0, 0, 100, 100], draws: [] } },
  }));
  const hyaGeometry = capture('geometryAndDrawOrder', 'haiyue-exact-hya', () => ({
    artboard: 'Main', viewport: 'desktop-1x', topology: { ...topology, submission: { oracle: 'webgpu-scene-submission@1', backend: 'webgpu', visualCount: 0, compositeLayerCount: 0, maskTargetCount: 0, effectTargetCount: 0 } },
  }));
  bindCaptureIdentity(officialGeometry, assetId, rivSha256); bindCaptureIdentity(hyaGeometry, assetId, rivSha256);
  assert.equal(createRiveOracleChannelComparison({
    channel: 'geometryAndDrawOrder', officialCapture: officialGeometry, hyaCapture: hyaGeometry,
    officialPath: 'evidence/grid-geometry-official.json', hyaPath: 'evidence/grid-geometry-hya.json', comparisonPath: 'evidence/grid-geometry-comparison.json',
    artifactBytesByPath: new Map(), scenario, scenarioSha256, assetId, rivSha256,
  }).comparison.status, 'passed');
});

function capture(channel, runtime, value) {
  const samples = [];
  for (let replayIndex = 0; replayIndex < scenario.replayCount; replayIndex++) {
    for (const atMicros of scenario.clockStepsMicros) samples.push({
      replayIndex, atMicros, actionIds: scenario.actions.filter(action => action.atMicros === atMicros).map(action => action.id),
      value: value({ replayIndex, atMicros }),
    });
  }
  return { schemaVersion: 1, kind: 'haiyue-rive-normalized-channel-capture', channel, runtime, assetId: 'fixture', rivSha256: RIV_HASH, scenarioSha256, normalization: `haiyue-rive-${channel}@1`, replayCount: scenario.replayCount, samples };
}

function assemble(channel, officialCapture, hyaCapture, artifactBytesByPath) {
  const generated = createRiveOracleChannelComparison({
    channel, officialCapture, hyaCapture, officialPath: `evidence/${channel}-official.json`, hyaPath: `evidence/${channel}-hya.json`, comparisonPath: `evidence/${channel}-comparison.json`,
    artifactBytesByPath, scenario, scenarioSha256, assetId: 'fixture', rivSha256: RIV_HASH,
  });
  artifactBytesByPath.set(generated.officialReference.path, generated.officialBytes);
  artifactBytesByPath.set(generated.hyaReference.path, generated.hyaBytes);
  artifactBytesByPath.set(generated.comparisonReference.path, generated.comparisonBytes);
  return { channel, officialReference: generated.officialReference, hyaReference: generated.hyaReference, comparisonReference: generated.comparisonReference, comparison: generated.comparison };
}

function pixelValue(label, bytes, artifactBytesByPath) {
  const path = `evidence/${label}.rgba`;
  artifactBytesByPath.set(path, bytes);
  return { width: 2, height: 1, dpr: 1, rgba: { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mediaType: 'application/octet-stream' } };
}
function bindCaptureIdentity(captureValue, assetId, rivSha256) { captureValue.assetId = assetId; captureValue.rivSha256 = rivSha256; }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`); }
function jsonReference(path, bytes) { return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mediaType: 'application/json' }; }
