import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.argv.includes('--edge') ? 'edge' : 'chrome';
if (browser === 'edge') {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (!existsSync(edge)) throw new Error(`Edge is unavailable at ${edge}.`);
  process.env.CHROME_PATH = edge;
}
process.env.WEBGPU_REQUIRE_NATIVE = '1';
const buildParent = resolve(root, 'scripts/webgpu-gate');
const build = mkdtempSync(join(buildParent, '.ray-gpu-build-'));
if (!build.startsWith(`${buildParent}${sep}`)) throw new Error(`Refusing ray GPU build outside ${buildParent}.`);
try {
  execFileSync(process.execPath, [
    resolve(root, 'node_modules/typescript/bin/tsc'), '--target', 'ESNext', '--module', 'ESNext', '--moduleResolution', 'bundler',
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', '@webgpu/types',
    '--rootDir', resolve(root, 'extensions/src'), '--outDir', build,
    resolve(root, 'extensions/src/ray-tracing/traversal/index.ts'),
  ], { cwd: root, stdio: 'inherit' });
  const buildUrl = `/${relative(root, build).split(sep).join('/')}`;
  const result = await runChromeWebGpuFixture({ root, fixture: 'scripts/webgpu-gate/ray-traversal-fixture.html', query: { build: buildUrl }, timeoutMs: 120_000 });
  const failures = [];
  if (result.schemaVersion !== 1 || result.suite !== 'ray-traversal-gpu-parity' || result.status !== 'passed') failures.push('invalid result identity');
  if (result.artifactVersion !== 2 || !/^[a-f0-9]{64}$/u.test(result.artifactHash ?? '')) failures.push(`artifact=${result.artifactVersion}/${result.artifactHash}`);
  if (result.fixedCases !== 3 || result.edgeCases !== 4 || result.randomizedCases !== 256 || result.anyHitCases !== 256) failures.push(`corpus=${result.fixedCases}/${result.edgeCases}/${result.randomizedCases}/${result.anyHitCases}`);
  if (result.mismatchCount !== 0 || result.validationErrorCount !== 0 || result.uncapturedErrorCount !== 0 || result.residualCount !== 0 || result.unclassifiedFailureCount !== 0) failures.push('fixture reported mismatch/error/residual');
  if (result.browserEvidence?.nativeBackend !== true || /swiftshader|software|warp/iu.test(result.browserEvidence?.angleBackend ?? '')) failures.push(`non-native browser evidence=${JSON.stringify(result.browserEvidence)}`);
  if (!result.overflowClassified || !result.deviceLossClassified || !result.deterministicReplay) failures.push('overflow/device-loss/deterministic replay evidence missing');
  if (!(result.dispatchCount > 20 && result.totalNodeTests > 0 && result.totalPrimitiveTests > 0)) failures.push('dispatch/traversal counters missing');
  if (!(result.gpuTimeSamples > 0 && result.maxPeakBytes > 0 && result.maxLiveResources === 5)) failures.push(`timing/memory evidence=${result.gpuTimeSamples}/${result.maxPeakBytes}/${result.maxLiveResources}`);
  if (failures.length > 0) throw new Error(`Ray GPU traversal gate failed:\n- ${failures.join('\n- ')}\n${JSON.stringify(result, null, 2)}`);
  console.log(`[ray-traversal:webgpu:${browser}] passed: fixed=${result.fixedCases}, edge=${result.edgeCases}, randomized=${result.randomizedCases}, any-hit=${result.anyHitCases}, dispatches=${result.dispatchCount}, mismatches=0, gpu-times=${result.gpuTimeSamples}, peak=${result.maxPeakBytes}B, browser=${result.browserEvidence?.product}, backend=${result.browserEvidence?.angleBackend}, adapter=${result.adapter?.description || result.adapter?.device || 'privacy-redacted'}.`);
} finally {
  const resolvedBuild = resolve(build);
  if (!resolvedBuild.startsWith(`${buildParent}${sep}`)) throw new Error(`Refusing cleanup outside ${buildParent}: ${resolvedBuild}`);
  rmSync(resolvedBuild, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
