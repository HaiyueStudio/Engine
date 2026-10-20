import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
import { createFrameGraphParityPlan, compareFrameGraphRoomPixels } from './webgpu-gate/framegraph-parity-policy.mjs';
import { validateG05RoomResult } from './webgpu-gate/deferred-g05-policy.mjs';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { captureFrameGraphPixels } from './webgpu-gate/framegraph-pixel-oracle.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.slice(2).some(a => a !== '--plan') || process.argv.length > 3) throw Error('Use --plan or no arguments; no partial passing populations');
const qualification = await loadFrameGraphQualification(root), plan = createFrameGraphParityPlan(qualification);
if (process.argv.includes('--plan')) { console.log(JSON.stringify({ qualification, jobs: plan, performanceQualified: false }, null, 2)); process.exit(0); }
const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const baseline = JSON.parse(await readFile(resolve(directory, 'a0-built/provenance.json')));
const fixed = JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json')));
const inputs = await deferredRuntimeFingerprint(root), build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json')));
if (baseline.revision !== fixed.revision || build.inputs.sha256 !== inputs.sha256) throw Error('Build fixed A0 and current B4 before paired correctness');
const sourceFingerprint = createPerformanceSourceFingerprint(root, root), wrapperHash = sha256(await readFile(fileURLToPath(import.meta.url)));
async function verifyBuilds() {
  for (const [variant, manifest] of [['A0', baseline], ['B4', build]]) for (const file of manifest.outputs)
    if (sha256(await readFile(resolve(directory, variant === 'A0' ? 'a0-built' : '.', file.file))) !== file.sha256) throw Error('Paired runtime chunk changed');
}
await verifyBuilds();
const generatedAt = new Date().toISOString(), out = resolve(directory, `parity-${generatedAt.replaceAll(':', '-')}`);
await mkdir(out);
const report = { schemaVersion: 1, contractId: qualification.contractId, status: 'running', qualification, generatedAt,
  scope: 'G05 room E/G and high-quality GTAO full-resolution A0/B4 pixel preflight; not full F0-F8 or timing qualification', performanceQualified: false,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  inputs, build, baseline, sourceFingerprint, wrapperHash, plan, results: [], pairs: [] };
const adapters = []; let before;
try {
  for (const [index, job] of plan.entries()) {
    const entry = { ...job, index, status: 'running' }; report.results.push(entry);
    try {
      let pixels;
      const raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId),
        fixture: `scripts/webgpu-gate/deferred-g05-${job.fixture}-fixture.html`,
        query: { caseId: job.caseId, algorithm: job.algorithm, ao: job.ao, moving: +job.moving, full: 0, framegraphOracle: 1, powerPreference: job.powerPreference },
        mounts: [{ prefix: '/artifacts/engine-0.2.1/g03', directory: resolve(directory, job.variant === 'A0' ? 'a0-built' : '.') }],
        timeoutMs: 300000, acceptedStatuses: ['passed', 'failed'], interact: async cdp => { pixels = await captureFrameGraphPixels(cdp); } });
      if (pixels) raw.framegraphPixels = pixels;
      const file = `${String(index).padStart(3, '0')}-${job.browserId}-${job.caseId}-${job.algorithm}-${job.variant}.json`;
      await writeFile(resolve(out, file), JSON.stringify(raw) + '\n');
      entry.raw = { file, sha256: sha256(await readFile(resolve(out, file))) };
      validateG05RoomResult(raw, { ...job, full: false });
      validateFrameGraphAdapter(raw.adapter, qualification); validateFrameGraphBrowser(raw, job, qualification); adapters.push(raw.adapter);
      entry.resources = raw.resourceAttribution; entry.adapter = raw.adapter;
      if (job.variant === 'A0') before = raw.framegraphPixels;
      else {
        const views = compareFrameGraphRoomPixels(before, raw.framegraphPixels, job);
        report.pairs.push({ ...job, views }); before = null;
        if (views.some(v => v.status !== 'passed')) throw Error('A0/B4 full-image pixel mismatch; timing remains blocked');
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; throw error; }
    finally { await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
    console.log(`[framegraph-parity] ${index + 1}/${plan.length} ${job.browserId} ${job.caseId} moving=${job.moving} ${job.algorithm} ${job.variant}: passed`);
  }
  validateFrameGraphAdapterConsistency(adapters); await verifyBuilds(); await assertFrameGraphQualificationUnchanged(root, qualification);
  if (sourceFingerprint !== createPerformanceSourceFingerprint(root, root) || inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 || wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('Paired inputs changed');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(`[framegraph-parity] ${out}: ${report.status}`); }
