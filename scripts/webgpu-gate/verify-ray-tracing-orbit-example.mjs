import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browsers = [
  ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
].filter(([, path]) => existsSync(path));
if (browsers.length === 0) {
  throw new Error('Interactive ray tracing example verification requires Chrome or Edge.');
}

const evidence = [];
for (const [browser, path] of browsers) {
  process.env.CHROME_PATH = path;
  process.env.WEBGPU_ANGLE_BACKEND = 'd3d11';
  const result = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/ray-tracing-orbit/index.html',
    query: {
      evidence: 1,
      resolution: '128x72',
      bounces: 2,
      view: 'raw',
    },
    timeoutMs: 120_000,
    visualCapture: {
      viewportWidth: 960,
      viewportHeight: 650,
      sampleWidth: 8,
      sampleHeight: 8,
    },
  });
  const expectedInitial = Array.from({ length: 12 }, (_, index) => index + 1);
  const expectedPostOrbit = Array.from({ length: 6 }, (_, index) => index + 1);
  if (
    result.status !== 'passed'
    || result.unclassifiedFailureCount !== 0
    || result.resolution?.width !== 128
    || result.resolution?.height !== 72
    || result.resolution?.source !== 'evidence-fixed'
    || JSON.stringify(result.initialSampleCounts) !== JSON.stringify(expectedInitial)
    || JSON.stringify(result.postOrbitSampleCounts) !== JSON.stringify(expectedPostOrbit)
    || !result.cameraResetReasons?.includes('camera')
    || result.convergence?.improved !== true
    || !(result.convergence.lateMeanDelta < result.convergence.earlyMeanDelta)
    || result.liveResourceCount < 1
    || result.browserDiagnostics?.unclassifiedFailureCount !== 0
  ) {
    throw new Error(browser + ' interactive ray tracing evidence failed: ' + JSON.stringify(result));
  }
  evidence.push({
    browser,
    resolution: result.resolution,
    initialSampleCounts: result.initialSampleCounts,
    postOrbitSampleCounts: result.postOrbitSampleCounts,
    cameraResetReasons: result.cameraResetReasons,
    convergence: result.convergence,
    liveResourceCount: result.liveResourceCount,
    browserEvidence: result.browserEvidence,
    browserDiagnostics: result.browserDiagnostics,
    httpProvenance: result.httpProvenance,
  });
  console.log('[ray-orbit-example:' + browser + '] progressive convergence and camera reset passed.');
}

console.log(JSON.stringify({ status: 'passed', browsers: evidence }, null, 2));
