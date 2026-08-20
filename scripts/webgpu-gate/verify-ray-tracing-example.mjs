import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browsers = [
  ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
].filter(([, path]) => existsSync(path));
if (browsers.length === 0) throw new Error('Ray tracing example verification requires Chrome or Edge.');

const evidence = [];
for (const [browser, path] of browsers) {
  process.env.CHROME_PATH = path;
  process.env.WEBGPU_ANGLE_BACKEND = 'd3d11';
  const result = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/ray-tracing/index.html',
    query: { evidence: 1, resolution: '96x54', quality: 'low', view: 'denoised' },
    timeoutMs: 90_000,
  });
  if (result.status !== 'passed' || result.unclassifiedFailureCount !== 0 || result.cases?.length !== 2) {
    throw new Error(`${browser} ray tracing example failed: ${JSON.stringify(result)}`);
  }
  for (const candidate of result.cases) {
    if (!/^sha256:[0-9a-f]{64}$/.test(candidate.sourceSha256)
      || !/^sha256:[0-9a-f]{64}$/.test(candidate.candidateSha256)
      || candidate.liveResourceCount < 1
      || candidate.peakBytes < 1
      || candidate.pixelSummary?.maximumChannel < 8
      || candidate.pixelSummary?.nonBlackPixelCount < 1
      || candidate.diagnostics.length !== 0
      || (candidate.sceneId === 'material' && (candidate.counters?.path?.hits < 1 || candidate.counters?.path?.invalidAccesses !== 0 || candidate.counters?.path?.stackOverflows !== 0))
      || candidate.unclassifiedFailureCount !== 0) {
      throw new Error(`${browser} returned invalid ${candidate.sceneId} candidate evidence.`);
    }
    if (candidate.width !== 96 || candidate.height !== 54 || candidate.pixelRatio !== 1 || candidate.resolutionSource !== 'evidence-fixed') {
      throw new Error(`${browser} returned non-deterministic evidence resolution for ${candidate.sceneId}.`);
    }
  }
  const responsive = await runChromeWebGpuFixture({
    root,
    fixture: 'examples/ray-tracing/index.html',
    query: { scene: 'analytic', quality: 'low', pixelRatio: '0.5' },
    timeoutMs: 90_000,
    visualCapture: { viewportWidth: 960, viewportHeight: 650, sampleWidth: 8, sampleHeight: 8 },
  });
  if (responsive.status !== 'passed'
    || responsive.resolutionSource !== 'viewport'
    || responsive.pixelRatio !== 0.5
    || responsive.width !== Math.round(responsive.displayWidth * responsive.pixelRatio)
    || responsive.height !== Math.round(responsive.displayHeight * responsive.pixelRatio)) {
    throw new Error(`${browser} responsive pixel-ratio resolution failed: ${JSON.stringify(responsive)}`);
  }
  evidence.push({
    browser,
    responsiveResolution: `${responsive.width}x${responsive.height}@${responsive.pixelRatio}`,
    cases: result.cases.map(candidate => ({
      sceneId: candidate.sceneId,
      fixedSceneId: candidate.fixedSceneId,
      fixedCameraReplayId: candidate.fixedCameraReplayId,
      sourceSha256: candidate.sourceSha256,
      candidateSha256: candidate.candidateSha256,
      buildMs: candidate.buildMs,
      gpuTimeNs: candidate.gpuTimeNs,
      peakBytes: candidate.peakBytes,
      liveResourceCount: candidate.liveResourceCount,
      diagnosticCount: candidate.diagnostics.length,
      unclassifiedFailureCount: candidate.unclassifiedFailureCount,
    })),
    browserEvidence: result.browserEvidence,
    browserDiagnostics: result.browserDiagnostics,
    httpProvenance: result.httpProvenance,
  });
  console.log(`[ray-example:${browser}] passed ${result.cases.map(value => value.sceneId).join(', ')}.`);
}
console.log(JSON.stringify({ status: 'passed', browsers: evidence }, null, 2));
