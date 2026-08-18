import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import {
  LIGHTING_SCALING_RESULT_FORMAT,
  LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
  validateLightingScalingResult,
} from './webgpu-gate/lighting-scaling-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(
  root,
  'artifacts/webgpu/lighting-scaling.json',
);
const BILLIARDS_SCENE = Object.freeze({
  sourcePath: 'games/pad-simulator/scenes/billiards-3d-import.scene.json',
  byteLength: 363097,
  sha256: '9e7f393aba90a91a1a84a42be9583ce627bfa2a0ee996c0b843d21f9514ba007',
});
const options = parseArguments(process.argv.slice(2));
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'scripts/webgpu-gate/lighting-scaling-fixture.html',
  query: {
    lights: options.lights,
    overlap: options.overlap,
    dynamic: options.dynamic,
    views: options.views,
    resolution: options.resolution,
    warmup: options.warmup,
    samples: options.samples,
    gpuSamples: options.gpuSamples,
  },
  timeoutMs: options.timeoutMs,
});

const contractErrors = validateLightingScalingResult(result);
if (contractErrors.length > 0) {
  throw new Error(
    `Lighting fixture violated ${LIGHTING_SCALING_RESULT_FORMAT}:\n`
    + contractErrors.map(error => `- ${error}`).join('\n'),
  );
}
assertEqual(
  result.schemaVersion,
  LIGHTING_SCALING_RESULT_SCHEMA_VERSION,
  'schema version',
);
assertEqual(result.suite, 'lighting.scaling.real-fixture', 'suite');
assertEqual(result.matrix?.caseCount, 216, 'fixture matrix case count');
assertEqual(
  result.execution?.validation?.errorCount,
  0,
  'WebGPU validation error count',
);
assertEqual(
  result.execution?.ownerCleanup?.ownerResidual?.value,
  0,
  'owner resource residual',
);
assertEqual(
  result.execution?.benchmarkSucceeded,
  true,
  'benchmark success',
);
assertEqual(
  result.capability?.rendererAbiChanged,
  false,
  'renderer ABI change flag',
);
assertEqual(
  result.fixture?.cameraReplayId,
  'billiards-3d-lighting-camera-v1',
  'camera replay',
);
assertEqual(
  result.configuration?.authoredLocalLightCount,
  options.lights,
  'authored light count',
);
assertEqual(
  result.configuration?.dynamicRatio,
  options.dynamic,
  'dynamic light ratio',
);
assertEqual(result.configuration?.viewCount, options.views, 'view count');
assertEqual(result.configuration?.overlap, options.overlap, 'overlap');
assertEqual(
  result.configuration?.resolution?.id,
  options.resolution,
  'resolution',
);
assertEqual(
  result.timing?.rawSamples?.length,
  options.samples,
  'CPU sample count',
);
assertSceneProvenance(result);
assertKnownForwardCap(result, options.lights);
assertEqual(
  result.failureSummary?.unclassifiedFailureCount,
  0,
  'unclassified failure count',
);
for (const category of [
  'scene-content-mismatch',
  'webgpu-validation',
  'owner-residual',
  'schema-invalid',
]) {
  assertEqual(
    result.failureSummary?.counts?.[category],
    0,
    `${category} failure count`,
  );
}
if (result.metrics?.timing?.gpuTimestamp?.status === 'unavailable') {
  const reason = result.metrics.timing.gpuTimestamp.reason;
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error(
      'Unavailable GPU timestamp evidence must retain a diagnostic reason.',
    );
  }
}
mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(
  `[webgpu-lighting-fixture] ${result.caseId}: `
  + `${result.timing.rawSamples.length} CPU samples, `
  + `${result.timing.p95.toFixed(3)}ms P95, `
  + `${result.capability.submittedLocalLightCount}/`
  + `${result.capability.authoredLocalLightCount} local lights submitted, `
  + `${result.capability.status}.`,
);
console.log(
  `[webgpu-lighting-fixture] Wrote ${relative(root, artifactPath)}.`,
);

function parseArguments(argumentsList) {
  const values = new Map();
  for (const argument of argumentsList) {
    const match = /^--([^=]+)=(.+)$/u.exec(argument);
    if (!match) {
      throw new Error(
        `Invalid argument "${argument}"; expected --name=value.`,
      );
    }
    values.set(match[1], match[2]);
  }
  return {
    lights: numberValue(values, 'lights', 128),
    overlap: values.get('overlap') ?? 'high',
    dynamic: numberValue(values, 'dynamic', 1),
    views: numberValue(values, 'views', 4),
    resolution: values.get('resolution') ?? '720p',
    warmup: positiveInteger(values, 'warmup', 4),
    samples: positiveInteger(values, 'samples', 8),
    gpuSamples: nonNegativeInteger(values, 'gpu-samples', 2),
    timeoutMs: positiveInteger(values, 'timeout-ms', 120_000),
  };
}

function assertSceneProvenance(result) {
  const provenance = result.metrics?.evidence?.sceneProvenance;
  assertEqual(provenance?.status, 'available', 'scene provenance status');
  assertEqual(
    provenance?.value?.sourceFingerprint,
    `sha256:${BILLIARDS_SCENE.sha256}`,
    'scene source fingerprint',
  );
  assertEqual(
    provenance?.value?.sourcePath,
    BILLIARDS_SCENE.sourcePath,
    'scene source path',
  );
  assertEqual(
    provenance?.value?.byteLength,
    BILLIARDS_SCENE.byteLength,
    'scene byte length',
  );
  assertEqual(
    provenance?.value?.sourceSceneEntityCount,
    43,
    'source scene entity count',
  );
  assertEqual(
    provenance?.value?.runtimeWorldEntityCount,
    43 + result.configuration.authoredLocalLightCount
      + result.configuration.viewCount,
    'runtime world entity count',
  );
  assertEqual(
    result.workload?.sceneHttpRequestCount,
    1,
    'scene HTTP request count',
  );
  assertEqual(provenance?.value?.meshCount, 24, 'real scene mesh count');
  assertEqual(provenance?.value?.geometryCount, 5, 'real geometry count');
  assertEqual(provenance?.value?.materialCount, 7, 'real material count');
  assertEqual(
    provenance?.value?.skippedComponentCount,
    17,
    'fully attributed skipped component count',
  );
  assertEqual(
    provenance?.value?.intentionallySkippedComponentCount,
    6,
    'intentional skipped component count',
  );
  assertEqual(
    provenance?.value?.unsupportedMaterialMeshCount,
    11,
    'unsupported material Mesh3D count',
  );
  assertEqual(
    provenance?.value?.unsupportedMaterialAffectedEntityCount,
    11,
    'unsupported material affected entity count',
  );
  assertEqual(
    provenance?.value?.physicsBodyCount,
    15,
    'real physics body count',
  );
  assertEqual(
    provenance?.value?.physicsSyncChanged3DTransform,
    true,
    'physics-to-3D motion probe',
  );
  assertEqual(result.sceneProvenance?.status, 'available', 'scene report status');
  assertEqual(result.sceneProvenance?.matches, true, 'scene hash match');
  assertEqual(
    result.sceneProvenance?.expected?.hash,
    `sha256:${BILLIARDS_SCENE.sha256}`,
    'expected scene hash',
  );
  assertEqual(
    result.sceneProvenance?.observed?.hash,
    `sha256:${BILLIARDS_SCENE.sha256}`,
    'observed scene hash',
  );
}

function assertKnownForwardCap(result, authoredLocalLightCount) {
  const rendererLocalLightCapacity = 6;
  const expectedSubmitted = Math.min(
    authoredLocalLightCount,
    rendererLocalLightCapacity,
  );
  const expectedOverflow = authoredLocalLightCount - expectedSubmitted;
  assertEqual(
    result.capability?.status,
    expectedOverflow === 0
      ? 'complete-for-selected-input'
      : 'known-forward-light-cap',
    'Forward capability status',
  );
  assertEqual(
    result.capability?.authoredLocalLightCount,
    authoredLocalLightCount,
    'capability authored light count',
  );
  assertEqual(
    result.capability?.submittedLocalLightCount,
    expectedSubmitted,
    'submitted local light count',
  );
  assertEqual(
    result.capability?.unsubmittedLocalLightCount,
    expectedOverflow,
    'unsubmitted local light count',
  );
  assertEqual(
    result.failureSummary?.counts?.['light-cap-overflow'],
    Number(expectedOverflow > 0),
    'light cap attribution count',
  );
  assertEqual(
    result.capability?.rendererTotalLightCapacity,
    8,
    'renderer total light capacity',
  );
  assertEqual(
    result.capability?.rendererLocalLightCapacity,
    rendererLocalLightCapacity,
    'renderer local light capacity',
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `Lighting fixture ${label} is ${String(actual)}; `
      + `expected ${String(expected)}.`,
    );
  }
}

function numberValue(values, name, fallback) {
  const source = values.get(name);
  if (source === undefined) return fallback;
  const number = Number(source);
  if (!Number.isFinite(number)) {
    throw new Error(`--${name} must be finite.`);
  }
  return number;
}

function positiveInteger(values, name, fallback) {
  const number = numberValue(values, name, fallback);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return number;
}

function nonNegativeInteger(values, name, fallback) {
  const number = numberValue(values, name, fallback);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return number;
}
