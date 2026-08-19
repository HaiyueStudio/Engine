import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
if (browser === 'edge') {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!existsSync(edge)) throw new Error(`Edge is unavailable at ${edge}.`);
  process.env.CHROME_PATH = edge;
}
process.env.WEBGPU_REQUIRE_NATIVE = '1';
if (!existsSync(resolve(root, 'engine/dist/experimental.js'))) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', './engine'], { cwd: root, stdio: 'inherit' });
const buildParent = resolve(root, 'scripts/visual-regression');
const build = mkdtempSync(join(buildParent, '.ray-path-build-'));
if (!build.startsWith(`${buildParent}${sep}`)) throw new Error(`Refusing G05 build outside ${buildParent}.`);
try {
  execFileSync(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types',
    '--rootDir', resolve(root, 'extensions/src'), '--outDir', build,
    resolve(root, 'extensions/src/ray-tracing/renderer/index.ts'), resolve(root, 'extensions/src/ray-tracing/material/index.ts'),
    resolve(root, 'extensions/src/ray-tracing/scene/index.ts'), resolve(root, 'extensions/src/ray-tracing/acceleration/index.ts'),
  ], { cwd: root, stdio: 'inherit' });
  const buildUrl = `/${relative(root, build).split(sep).join('/')}`;
  const result = await runChromeWebGpuFixture({
    root, fixture: 'scripts/visual-regression/ray-path-tracing-fixture.html', query: { build: buildUrl }, timeoutMs: 120_000,
    visualCapture: { viewportWidth: 640, viewportHeight: 430, sampleWidth: 24, sampleHeight: 16 },
  });
  const failures = [];
  if (result.schemaVersion !== 1 || result.suite !== 'ray-pbr-path-tracing' || result.status !== 'passed') failures.push('invalid result identity');
  if (result.artifactVersion !== 2 || !/^[a-f0-9]{64}$/u.test(result.artifactHash ?? '')) failures.push(`artifact=${result.artifactVersion}/${result.artifactHash}`);
  if (!/^fnv1a32:[a-f0-9]{8}$/u.test(result.candidateHash ?? '') || !Array.isArray(result.candidatePixel)) failures.push('candidate pixels missing');
  if (!result.deterministicReplay || !result.resizePassed || !result.environmentPassed || !result.normalTransformPassed || !result.deviceLossClassified) failures.push('determinism/resize/environment/normal-transform/device-loss evidence missing');
  if (!(result.counters?.pixels === 32 * 18 && result.counters?.hits > 0 && result.counters?.shadowRays > 0 && result.counters?.emissiveHits > 0)) failures.push(`path counters=${JSON.stringify(result.counters)}`);
  if (result.validationErrorCount !== 0 || result.uncapturedErrorCount !== 0 || result.residualCount !== 0 || result.unclassifiedFailureCount !== 0) failures.push('GPU error/residual/unclassified failure');
  if (result.browserEvidence?.nativeBackend !== true || /swiftshader|software|warp/iu.test(result.browserEvidence?.angleBackend ?? '')) failures.push(`non-native=${JSON.stringify(result.browserEvidence)}`);
  if (!(result.gpuTimeSamples > 0 && result.maxPeakBytes > 0 && result.maxLiveResources === 11)) failures.push(`timing/memory=${result.gpuTimeSamples}/${result.maxPeakBytes}/${result.maxLiveResources}`);
  if (!result.visualCapture?.pngBase64 || result.visualCapture.darkRatio >= 1) failures.push('candidate screenshot missing or empty');
  if (failures.length) throw new Error(`G05 native WebGPU gate failed:\n- ${failures.join('\n- ')}\n${JSON.stringify({ ...result, visualCapture: result.visualCapture ? { ...result.visualCapture, pngBase64: '<omitted>' } : null }, null, 2)}`);
  console.log(`[ray-path:webgpu:${browser}] passed: ${result.width}x${result.height}, candidate=${result.candidateHash}, pixels=${result.counters.pixels}, rays=${result.counters.rays}, bounces=${result.counters.bounces}, gpu-times=${result.gpuTimeSamples}, peak=${result.maxPeakBytes}B, browser=${result.browserEvidence?.product}, backend=${result.browserEvidence?.angleBackend}.`);
} finally {
  const resolvedBuild = resolve(build);
  if (!resolvedBuild.startsWith(`${buildParent}${sep}`)) throw new Error(`Refusing cleanup outside ${buildParent}: ${resolvedBuild}`);
  rmSync(resolvedBuild, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
