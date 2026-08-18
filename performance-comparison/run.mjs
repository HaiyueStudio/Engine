import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from '../scripts/webgpu-gate/chrome-runner.mjs';
import { evaluateComparisonReport } from './lib/policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const enforce = process.argv.includes('--enforce');
const formal = process.argv.includes('--formal');
if (formal && !full) throw new Error('Formal comparison evidence requires --full.');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const versions = {
  haiyue: JSON.parse(readFileSync(resolve(root, 'engine/package.json'), 'utf8')).version,
  three: packageJson.devDependencies.three,
  babylon: packageJson.devDependencies['@babylonjs/core'],
  galacean: packageJson.devDependencies['@galacean/engine'],
  playcanvas: packageJson.devDependencies.playcanvas,
};
const visualEvidence = {};
for (const engineId of ['haiyue', 'three', 'babylon', 'playcanvas', 'galacean']) {
  console.log(`[performance-comparison] Capturing ${engineId} parity frame.`);
  const probe = await runChromeWebGpuFixture({
    root,
    fixture: 'performance-comparison/index.html',
    query: { visualOnly: engineId, versions: JSON.stringify(versions) },
    timeoutMs: 180_000,
    visualCapture: { viewportWidth: 1280, viewportHeight: 720, sampleWidth: 48, sampleHeight: 27 },
  });
  visualEvidence[engineId] = evaluateVisualCapture(probe.visualCapture);
}
const result = await runChromeWebGpuFixture({
  root,
  fixture: 'performance-comparison/index.html',
  query: { profile: full ? 'full' : 'smoke', versions: JSON.stringify(versions) },
  timeoutMs: full ? 600_000 : 240_000,
});
for (const engine of result.engines) {
  engine.visual = visualEvidence[engine.engineId];
  if (engine.backend === 'webgpu') {
    const adapterDescription = JSON.stringify(engine.adapterInfo ?? {});
    const softwareAdapter = /swiftshader|software|warp|llvmpipe/i.test(adapterDescription);
    engine.nativeBackend = result.browserEvidence?.nativeBackend === true && !softwareAdapter;
  }
}
result.hostEvidence = {
  platform: platform(),
  osRelease: release(),
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCpuCount: cpus().length,
  totalMemoryBytes: totalmem(),
  node: process.version,
  revision: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']).length > 0,
};
result.dependencyVersions = versions;
result.policy = evaluateComparisonReport(result);
result.evidenceKind = formal ? 'formal' : 'candidate';
if (formal && result.hostEvidence.dirty) {
  result.policy.status = 'failed';
  result.policy.violations.push('formal comparison requires a clean revision');
}
const outputPath = formal && result.policy.status === 'passed'
  ? resolve(root, 'artifacts/performance-comparison/formal.json')
  : resolve(root, 'performance-comparison/data/local/latest.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`[performance-comparison] Wrote ${outputPath}`);
for (const entry of result.policy.ranking) {
  console.log(`[performance-comparison] ${entry.engineId}: P50 ${entry.medianP50Ms.toFixed(3)} ms, P95 ${entry.medianP95Ms.toFixed(3)} ms`);
}
console.log(`[performance-comparison] policy=${result.policy.status}; backend=${result.policy.rankedBackend}; host=${result.hostEvidence.osRelease}`);
if (enforce && result.policy.status !== 'passed') {
  throw new Error(`Cross-engine comparison policy failed:\n${result.policy.violations.join('\n')}`);
}

function git(args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
}

function evaluateVisualCapture(capture) {
  const channelValues = capture.signature ?? [];
  const uniqueValues = new Set(channelValues).size;
  const failures = [];
  if (uniqueValues < 5) failures.push(`only ${uniqueValues} quantized channel values were observed`);
  if (capture.darkRatio > 0.98) failures.push(`darkRatio=${capture.darkRatio}`);
  if (capture.brightRatio > 0.98) failures.push(`brightRatio=${capture.brightRatio}`);
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    sampleWidth: capture.sampleWidth,
    sampleHeight: capture.sampleHeight,
    meanRgb: capture.meanRgb,
    darkRatio: capture.darkRatio,
    brightRatio: capture.brightRatio,
    uniqueQuantizedChannelValues: uniqueValues,
  };
}
