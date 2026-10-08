import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { deferredRuntimeFingerprint, sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createFrameGraphRegressionPlan, parseFrameGraphRegressionOptions,
  validateFrameGraphRegressionResult, validateFrameGraphRegressionEvidence } from './webgpu-gate/framegraph-regression-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = parseFrameGraphRegressionOptions(process.argv.slice(2));
const qualification = options.tier === 'full' ? await loadFrameGraphQualification(root) : null;
const plan = createFrameGraphRegressionPlan(options.tier, qualification);
if (options.plan) { console.log(JSON.stringify({ tier: options.tier, qualification, jobs: plan, performanceQualified: false }, null, 2)); process.exit(0); }
const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const inputs = await deferredRuntimeFingerprint(root);
let build;
try { build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (inputs.sha256 !== build?.inputs?.sha256) {
  console.log('[framegraph-regressions] Building current private fixture once before native execution');
  execFileSync(process.execPath, ['scripts/webgpu-gate/build-deferred-fixture.mjs', '--framegraph'], { cwd: root, stdio: 'inherit' });
  build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json'), 'utf8'));
}
if (inputs.sha256 !== build.inputs.sha256) throw Error('G09 inputs changed during fixture build');
async function validateChunks() {
  for (const output of build.outputs) {
    if (sha256(await readFile(resolve(directory, output.file))) !== output.sha256) throw Error(`Stale G09 chunk ${output.file}`);
  }
}
await validateChunks();
const sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const wrapperHash = sha256(await readFile(fileURLToPath(import.meta.url)));
const evidence = { schemaVersion: 3, status: 'running', tier: options.tier, qualification, performanceQualified: false, generatedAt: new Date().toISOString(),
  scope: 'G09 compatibility/lifecycle/device correctness; not performance or release acceptance', inputs, build, sourceFingerprint, wrapperHash,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), results: [] };
const output = resolve(directory, `regressions-${evidence.generatedAt.replaceAll(':', '-')}.json`);
await mkdir(directory, { recursive: true });
try {
  for (const job of plan) {
    const { name, powerPreference } = job;
    const entry = { ...job, status: 'running' }; evidence.results.push(entry);
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    try {
      const result = await runChromeWebGpuFixture({ root, browserPath: job.browserId ? frameGraphBrowserPath(job.browserId) : undefined, fixture: `scripts/webgpu-gate/${name}-fixture.html`,
        query: { powerPreference }, timeoutMs: 240000, acceptedStatuses: ['passed', 'failed'],
        mounts: [{ prefix: '/artifacts/engine-0.2.1/g04', directory }] });
      entry.result = result;
      validateFrameGraphRegressionResult(result, job, options.tier, qualification);
      entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed'; entry.error = error.stack;
      // Preserve this population; a rerun cannot fill its missing jobs.
      throw error;
    }
    console.log(`[framegraph-regressions] ${job.browserId ?? 'smoke'} ${name} ${powerPreference}: ${entry.status}`);
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  }
  if (inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 || sourceFingerprint !== createPerformanceSourceFingerprint(root, root) ||
      wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('G09 verification inputs changed');
  await validateChunks();
  if (qualification) await assertFrameGraphQualificationUnchanged(root, qualification);
  evidence.status = 'passed';
  validateFrameGraphRegressionEvidence(evidence, { inputs: inputs.sha256, sourceFingerprint, tier: options.tier, qualification });
} catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
finally { evidence.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n'); console.log(`[framegraph-regressions] evidence: ${output}`); }
console.log(`[framegraph-regressions] ${output}`);
