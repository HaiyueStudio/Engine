import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'examples/navmesh-first-person/index.html',
  query: { regression: 1 },
  timeoutMs: 90_000,
  visualCapture: {
    viewportWidth: 960,
    viewportHeight: 640,
    sampleWidth: 48,
    sampleHeight: 32,
  },
});

if (result.status !== 'passed' || result.validationErrorCount !== 0) {
  throw new Error(`NavMesh first-person WebGPU validation failed: ${JSON.stringify(result.errors)}.`);
}
const requiredFeatures = [
  'surface-hole',
  'local-surface-sample',
  'first-person-controls',
  'jump',
  'low-steps',
];
for (const feature of requiredFeatures) {
  if (!result.features.includes(feature)) throw new Error(`NavMesh browser fixture lost ${feature} coverage.`);
}
if (!result.regression) throw new Error('NavMesh browser fixture did not execute its interaction regression.');
const requiredInteractions = [
  'movedForward',
  'tallStepBlocked',
  'jumpReachedStep',
  'landedOnStep',
  'fellThroughHole',
  'resetToSpawn',
  'disposeStoppedInput',
];
for (const name of requiredInteractions) {
  if (result.regression[name] !== true) throw new Error(`NavMesh first-person interaction failed: ${name}.`);
}
if (result.visualCapture.darkRatio > 0.98) {
  throw new Error(`NavMesh first-person screenshot is degenerate: ${JSON.stringify(result.visualCapture.meanRgb)}.`);
}

console.log(JSON.stringify({
  schemaVersion: 1,
  suite: 'navmesh-first-person-example',
  status: 'passed',
  validationErrorCount: result.validationErrorCount,
  features: result.features,
  regression: result.regression,
  visual: {
    meanRgb: result.visualCapture.meanRgb,
    darkRatio: result.visualCapture.darkRatio,
    brightRatio: result.visualCapture.brightRatio,
  },
}, null, 2));
