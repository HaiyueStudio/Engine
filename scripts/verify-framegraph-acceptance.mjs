import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { deferredRuntimeFingerprint, sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { G09_ACCEPTANCE_CONTRACT, G09_ACCEPTANCE_CASES, G09_OUTSTANDING_ACCEPTANCE, createG09AcceptancePlan, compareG09Pixels } from './webgpu-gate/framegraph-acceptance-cases.mjs';
import { validateG09PreflightCapture, validateG09ServedInputs, auditG09Preflight } from './webgpu-gate/framegraph-acceptance-policy.mjs';
import { captureFrameGraphPixels } from './webgpu-gate/framegraph-pixel-oracle.mjs';
import { createG09AcceptanceRoute } from './webgpu-gate/framegraph-acceptance-routing.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
if (args.length !== 1 || !['--plan', '--smoke', '--correctness'].includes(args[0]) && !args[0]?.startsWith('--audit='))
  throw Error('Use --plan, --smoke, --correctness or --audit=<report>. Correctness does not grant production performance qualification.');
const base = resolve(root, 'artifacts/engine-0.2.1/g09');
const bounded = (directory, file) => {
  const path = resolve(directory, file), name = relative(directory, path);
  if (!name || name.startsWith(`..${sep}`) || name === '..' || /^[A-Za-z]:/.test(name)) throw Error('Evidence path escapes its attempt');
  return path;
};
async function readBoundRaw(directory, binding) {
  const bytes = await readFile(bounded(directory, binding.file));
  if (sha256(bytes) !== binding.sha256) throw Error(`Changed raw evidence: ${binding.file}`);
  return JSON.parse(bytes);
}
if (args[0].startsWith('--audit=')) {
  const path = bounded(base, relative(base, resolve(root, args[0].slice(8))));
  const report = JSON.parse(await readFile(path));
  const directory = resolve(path, '..');
  console.log(JSON.stringify(await auditG09Preflight(report, binding => readBoundRaw(directory, binding)), null, 2));
  process.exit(0);
}
const qualification = await loadFrameGraphQualification(root), tier = args[0] === '--smoke' ? 'smoke' : 'full';
const acceptance = createG09AcceptanceRoute(JSON.parse(await readFile(resolve(root, 'config/framegraph-acceptance-021.json'))));
const plan = createG09AcceptancePlan(qualification, tier);
if (args[0] === '--plan') {
  console.log(JSON.stringify({ contractId: G09_ACCEPTANCE_CONTRACT, qualification, cases: G09_ACCEPTANCE_CASES, plan,
    captures: plan.length, performanceQualified: false, g09Complete: false, acceptance, outstanding: G09_OUTSTANDING_ACCEPTANCE }, null, 2));
  process.exit(0);
}
// Reuse validated builds without overwriting any prior hash-bound artifacts.
const build = JSON.parse(await readFile(resolve(base, 'fixture-build.json')));
const baseline = JSON.parse(await readFile(resolve(base, 'a0-built/provenance.json')));
const fixed = JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json')));
const inputs = await deferredRuntimeFingerprint(root);
if (build.inputs.sha256 !== inputs.sha256 || baseline.revision !== fixed.revision) throw Error('Build fixed A0 and current B4 before preflight');
const generatedAt = new Date().toISOString(), directory = resolve(base, `acceptance-${tier}-${generatedAt.replaceAll(':', '-')}`);
await mkdir(directory);
const harnessPaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'scripts/webgpu-gate', 'scripts/benchmark', 'scripts/verify-framegraph-acceptance.mjs', 'config/release-matrix.json', 'config/framegraph-acceptance-021.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
const hashHarness = async () => Promise.all(harnessPaths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
const harness = await hashHarness();
const distPaths = (await readdir(resolve(root, 'engine/dist'), { recursive: true, withFileTypes: true }))
  .filter(e => e.isFile() && /\.(js|wasm)$/.test(e.name)).map(e => relative(root, resolve(e.parentPath, e.name)).replaceAll('\\', '/')).sort();
const hashDist = async () => Promise.all(distPaths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
const auxiliaryDist = { scope: 'Existing package auxiliary correctness fixtures; explicit served-byte binding, not release source-to-dist qualification', files: await hashDist() };
const report = { schemaVersion: 1, contractId: G09_ACCEPTANCE_CONTRACT, generatedAt, status: 'running', tier,
  performanceQualified: false, g09Complete: false, qualification, inputs, baseline, build, harness, auxiliaryDist,
  sourceFingerprint: createPerformanceSourceFingerprint(root, root),
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  cases: G09_ACCEPTANCE_CASES, plan, acceptance, outstanding: G09_OUTSTANDING_ACCEPTANCE, entries: [], pairs: [] };
async function verifyInputs() {
  if ((await deferredRuntimeFingerprint(root)).sha256 !== inputs.sha256 || JSON.stringify(await hashHarness()) !== JSON.stringify(harness) ||
    createPerformanceSourceFingerprint(root, root) !== report.sourceFingerprint || JSON.stringify(await hashDist()) !== JSON.stringify(auxiliaryDist.files)) throw Error('Acceptance inputs changed during capture');
  for (const [variant, manifest] of [['A0', baseline], ['B4', build]]) for (const chunk of manifest.outputs) {
    if (sha256(await readFile(resolve(base, variant === 'A0' ? 'a0-built' : '.', chunk.file))) !== chunk.sha256) throw Error('Runtime chunk changed');
  }
  await assertFrameGraphQualificationUnchanged(root, qualification);
}
let before;
try {
  await verifyInputs();
  for (const [index, job] of plan.entries()) {
    const spec = G09_ACCEPTANCE_CASES.find(c => c.id === job.caseId);
    const entry = { job, status: 'running' }; report.entries.push(entry);
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    try {
      const runtimeDirectory = resolve(base, job.variant === 'A0' ? 'a0-built' : '.');
      let pixels;
      const raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(job.browserId),
        fixture: `scripts/webgpu-gate/${spec.fixture}-fixture.html`,
        query: { ...spec.parameters, ...(spec.fixture === 'framegraph-acceptance' ? { caseId: spec.id } : {}), powerPreference: job.powerPreference },
        timeoutMs: 300000, acceptedStatuses: ['passed', 'failed'],
        mounts: [{ prefix: '/games', directory: resolve(root, 'scripts/fixtures/lighting-content') },
          ...['g03', 'g04', 'g05', 'g09'].map(goal => ({ prefix: `/artifacts/engine-0.2.1/${goal}`, directory: runtimeDirectory }))],
        ...(spec.pairedPixels ? { interact: async cdp => { pixels = await captureFrameGraphPixels(cdp); } } : {}) });
      if (pixels) raw.framegraphPixels = pixels;
      const file = `${String(index).padStart(3, '0')}-${job.caseId}-${job.browserId}-${job.variant}.json`;
      const bytes = JSON.stringify(raw); await writeFile(resolve(directory, file), bytes);
      entry.raw = { file, sha256: sha256(bytes) };
      validateG09PreflightCapture(raw, job, qualification);
      validateG09ServedInputs(raw, job, report);
      if (spec.pairedPixels) {
        if (job.variant === 'A0') before = pixels;
        else { report.pairs.push({ caseId: spec.id, browserId: job.browserId, views: compareG09Pixels(before, pixels, spec) }); before = null; }
      }
      entry.status = 'passed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; throw error; }
    console.log(`[g09-preflight] ${index + 1}/${plan.length} ${job.caseId} ${job.browserId} ${job.variant}: passed`);
  }
  await verifyInputs(); report.status = 'passed';
  report.audit = await auditG09Preflight(report, binding => readBoundRaw(directory, binding));
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[g09-preflight] ${report.status}: ${directory}`);
  if (report.error) console.error(report.error);
}
