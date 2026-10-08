import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { deferredRuntimeFingerprint, sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
import { G05_FORWARD_CASES } from './webgpu-gate/deferred-g05-forward-policy.mjs';
import { createFrameGraphForwardPlan, validateFrameGraphForwardCapture, validateFrameGraphForwardPixels, evaluateFrameGraphForward } from './webgpu-gate/framegraph-forward-policy.mjs';
import { captureFrameGraphWindowsHost, validateFrameGraphWindowsHost } from './webgpu-gate/framegraph-windows-host.mjs';
import { waitG05Cooldown } from './webgpu-gate/deferred-g05-cooldown.mjs';
import { captureFrameGraphPixels } from './webgpu-gate/framegraph-pixel-oracle.mjs';
import { compareFrameGraphRoomPixels } from './webgpu-gate/framegraph-parity-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
if (args.length !== 1 || !['--smoke', '--full', '--plan'].includes(args[0])) throw Error('Use --smoke, --full or --plan');
const configBytes = await readFile(resolve(root, 'config/framegraph-performance-021.json')), config = JSON.parse(configBytes);
const budgetBytes = await readFile(resolve(root, 'config/lighting-performance-021.json')), budget = JSON.parse(budgetBytes);
const qualification = await loadFrameGraphQualification(root), full = args[0] !== '--smoke', plan = createFrameGraphForwardPlan(config, full);
const target = qualification.targets.find(t => t.browserId === config.runner.browserId);
if (args[0] === '--plan') { console.log(JSON.stringify({ config, qualification, plan, minimumCooldownMinutes: plan.length * 2, performanceQualified: false }, null, 2)); process.exit(0); }
if (!target || qualification.hostname !== config.runner.hostname || qualification.platform !== config.runner.platform) throw Error('Register actual performance host before capture; no device substitution');
const directory = resolve(root, 'artifacts/engine-0.2.1/g09'), generatedAt = new Date().toISOString(), out = resolve(directory, `forward-${generatedAt.replaceAll(':', '-')}`);
await mkdir(out);
const baseline = JSON.parse(await readFile(resolve(directory, 'a0-built/provenance.json'))), build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json')));
const fixed = JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json'))), inputs = await deferredRuntimeFingerprint(root);
if (baseline.revision !== fixed.revision || inputs.sha256 !== build.inputs.sha256) throw Error('Stale A0/B4 builds');
const sourceFingerprint = createPerformanceSourceFingerprint(root, root), wrapperHash = sha256(await readFile(fileURLToPath(import.meta.url)));
const report = { schemaVersion: 1, status: 'running', tier: full ? 'f0-development-cohorts' : 'f0-smoke', performanceQualified: false, generatedAt,
  qualification, config, configSha256: sha256(configBytes), budgetSha256: sha256(budgetBytes), baseline, build, inputs, sourceFingerprint, wrapperHash,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), plan, captures: [], correctness: [], entries: [] };
async function verifyInputs() {
  for (const [variant, manifest] of [['A0', baseline], ['B4', build]]) for (const f of manifest.outputs)
    if (sha256(await readFile(resolve(directory, variant === 'A0' ? 'a0-built' : '.', f.file))) !== f.sha256) throw Error('Runtime chunk changed');
  await assertFrameGraphQualificationUnchanged(root, qualification);
  if (sourceFingerprint !== createPerformanceSourceFingerprint(root, root) || inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 ||
      report.configSha256 !== sha256(await readFile(resolve(root, 'config/framegraph-performance-021.json'))) || report.budgetSha256 !== sha256(await readFile(resolve(root, 'config/lighting-performance-021.json'))) ||
      wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('F0 capture inputs changed');
}
async function capture(job, pixels = false) {
  let images;
  const c = G05_FORWARD_CASES.find(c => c.id === job.caseId);
  const raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(target.browserId), fixture: 'scripts/webgpu-gate/deferred-g05-forward-fixture.html',
    query: { ...c, framegraphRuntime: 1, framegraphOracle: +pixels, powerPreference: target.powerPreference, warmup: job.full ? 120 : 2, samples: job.full ? 300 : 3, gpuSamples: job.full ? 300 : 3, resolution: '720p' },
    mounts: [{ prefix: '/games', directory: resolve(root, 'scripts/fixtures/lighting-content') }, { prefix: '/artifacts/engine-0.2.1/g09/oracle-runtime', directory: resolve(directory, job.variant === 'A0' ? 'a0-built' : '.') }],
    timeoutMs: 300000, ...(pixels ? { interact: async cdp => { images = await captureFrameGraphPixels(cdp); } } : {}) });
  const file = `capture-${String(report.captures.length).padStart(3, '0')}-${job.caseId}-${job.variant}.json`;
  await writeFile(resolve(out, file), JSON.stringify({ ...raw, ...(images ? { framegraphPixels: images } : {}) }));
  report.captures.push({ job, file, sha256: sha256(await readFile(resolve(out, file))) });
  validateFrameGraphForwardCapture(raw, job, config); validateFrameGraphAdapter(raw.adapter, qualification); validateFrameGraphBrowser(raw, target, qualification);
  if (pixels) validateFrameGraphForwardPixels(images);
  return { raw, images };
}
try {
  await verifyInputs();
  // Correctness is completed before measured full populations, never inferred from timings.
  for (const caseId of config.cases) {
    const images = {};
    for (const variant of ['A0', 'B4']) {
      const { raw, images: pixels } = await capture({ caseId, variant, full: false }, true);
      report.correctness.push({ ...report.captures.at(-1) }); images[variant] = pixels;
    }
    const comparison = compareFrameGraphRoomPixels(images.A0, images.B4, { caseId: 'small-8' });
    if (comparison.some(r => r.status !== 'passed')) throw Error(`F0 ${caseId} full-image mismatch; timing blocked`);
    report.correctness.push({ caseId, comparison }); console.log(`[framegraph-forward] ${caseId} A0/B4 full-image parity passed`);
  }
  for (const [index, job] of plan.entries()) {
    const entry = { job, status: 'running' }; report.entries.push(entry);
    try {
      // Let an interactive supervisor keep its own UI/IPC work outside host observations.
      // This timestamp is advisory only: measured cooldown and every existing guard still apply.
      entry.cooldownMs = await waitG05Cooldown(full ? config.sampling.idleMs : 0, { onProgress: ms => console.log(`[framegraph-forward] ${index + 1}/${plan.length} cooling ${Math.ceil(ms / 1000)}s; capture-not-before=${new Date(Date.now() + ms).toISOString()}`) });
      const before = await captureFrameGraphWindowsHost();
      entry.hostSamples = [before];
      if (full) validateFrameGraphWindowsHost([before, before], config.runner);
      const { raw } = await capture(job); entry.result = raw;
      entry.hostSamples = [before, await captureFrameGraphWindowsHost()];
      if (full) validateFrameGraphWindowsHost(entry.hostSamples, config.runner);
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; throw error; }
    finally { await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
    console.log(`[framegraph-forward] ${index + 1}/${plan.length} ${job.caseId} ${job.variant}, cohort ${job.cohort + 1}: passed`);
  }
  await verifyInputs(); validateFrameGraphAdapterConsistency(report.entries.map(e => e.result.adapter));
  if (full) { report.assessment = evaluateFrameGraphForward(report.entries, config, budget.relativeBudgets); report.status = report.assessment.status; }
  else report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`[framegraph-forward] ${out}: ${report.status}`); }
if (report.status !== 'passed') process.exitCode = 1;
