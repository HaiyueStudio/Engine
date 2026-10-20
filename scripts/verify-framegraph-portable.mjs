import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, release, arch } from 'node:os';
import { runChromeWebGpuFixture, defaultChromePath } from './webgpu-gate/chrome-runner.mjs';
import { deferredRuntimeFingerprint, sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { compareFrameGraphProbePixels } from './webgpu-gate/framegraph-black-frame-policy.mjs';
import { parseFrameGraphPortableOptions, createFrameGraphPortablePlan, assessFrameGraphPortableResult, portableAdapters } from './webgpu-gate/framegraph-portable-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const options = parseFrameGraphPortableOptions(process.argv.slice(2));
const plan = createFrameGraphPortablePlan();
const scope = { tier: 'portable-b4-diagnostic', performanceQualified: false, frozenDeviceQualified: false,
  baselineComparison: false, scope: 'Current B4 correctness on available hardware; not A0/B4, integrated-GPU or F0-F8 qualification' };
if (options.plan) { console.log(JSON.stringify({ ...scope, plan }, null, 2)); process.exit(0); }
// Two compatibility fixtures consume public dist modules; rebuild them before
// freezing the input fingerprint instead of silently testing an older install.
execFileSync(process.execPath, [resolve(root, 'scripts/build-rollup-once.mjs')], { cwd: resolve(root, 'engine'), stdio: 'inherit' });
execFileSync(process.execPath, [resolve(root, 'scripts/prune-package-declarations.mjs'), 'engine'], { cwd: root, stdio: 'inherit' });
const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const inputs = await deferredRuntimeFingerprint(root);
let build;
try { build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (inputs.sha256 !== build?.inputs?.sha256) {
  execFileSync(process.execPath, ['scripts/webgpu-gate/build-deferred-fixture.mjs', '--framegraph'], { cwd: root, stdio: 'inherit' });
  build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json'), 'utf8'));
}
async function verifyChunks() {
  if (build.inputs.sha256 !== inputs.sha256) throw Error('Runtime identity changed during build');
  for (const output of build.outputs)
    if (sha256(await readFile(resolve(directory, output.file))) !== output.sha256) throw Error(`Changed chunk: ${output.file}`);
}
await verifyChunks();
const generatedAt = new Date().toISOString();
const out = resolve(directory, `portable-${generatedAt.replaceAll(':', '-')}`);
await mkdir(out);
const sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const wrapperHash = sha256(await readFile(fileURLToPath(import.meta.url)));
const report = { schemaVersion: 1, status: 'running', ...scope, generatedAt, inputs, build, sourceFingerprint, wrapperHash,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  host: { platform: platform(), release: release(), arch: arch(), node: process.version, browserPath: process.env.CHROME_PATH ?? defaultChromePath() },
  plan, results: [], repeats: [] };
const references = new Map(), identities = new Map();
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`[framegraph-portable] ${out}; ${plan.length} jobs; ${report.host.browserPath}`);
try {
  await save();
  for (const [index, job] of plan.entries()) {
    const entry = { ...job, index, status: 'running', startedAt: new Date().toISOString() };
    report.results.push(entry);
    await save();
    try {
      const black = job.name === 'framegraph-black-frame';
      const result = await runChromeWebGpuFixture({ root, fixture: `scripts/webgpu-gate/${job.name}-fixture.html`,
        query: { powerPreference: job.powerPreference, ...(black ? { copySource: +job.copySource, access: job.access, readback: 'atomic', coverage: 'production' } : {}) },
        timeoutMs: 240000, acceptedStatuses: ['passed', 'failed'],
        mounts: [{ prefix: '/artifacts/engine-0.2.1/g04', directory }, { prefix: '/artifacts/engine-0.2.1/g09/oracle-runtime', directory }] });
      const file = `${String(index).padStart(2, '0')}-${job.name}.json`;
      const raw = JSON.stringify(result, null, 2) + '\n';
      await writeFile(resolve(out, file), raw);
      entry.raw = { file, sha256: sha256(raw) };
      entry.adapters = portableAdapters(result);
      entry.browserEvidence = result.browserEvidence;
      entry.assessment = assessFrameGraphPortableResult(result, job);
      for (const adapter of entry.adapters) {
        const identity = JSON.stringify(adapter);
        if (!identities.has(job.powerPreference)) identities.set(job.powerPreference, identity);
        if (identities.get(job.powerPreference) !== identity) throw Error('Adapter changed within requested preference');
      }
      if (black) {
        const key = `${job.powerPreference}:${job.copySource}:${job.access}`;
        if (job.round === 0) references.set(key, result.computed);
        else {
          const pair = { key, ...compareFrameGraphProbePixels(references.get(key), result.computed) };
          report.repeats.push(pair);
          if (pair.status !== 'passed') throw Error('Repeated B4 image mismatch');
        }
      }
      entry.status = entry.assessment.status;
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    entry.finishedAt = new Date().toISOString();
    await save();
    console.log(`[framegraph-portable] ${index + 1}/${plan.length} ${job.name} ${job.powerPreference} ${job.access ?? ''}: ${entry.status}${entry.error ? ' ' + entry.error.split('\n')[0] : ''}`);
  }
  if (inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 || sourceFingerprint !== createPerformanceSourceFingerprint(root, root) ||
      wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('Verification inputs changed');
  await verifyChunks();
  report.observedAdaptersByPreference = Object.fromEntries([...identities].map(([key, value]) => [key, JSON.parse(value)]));
  report.status = report.results.length === plan.length && report.results.every(r => r.status === 'passed') &&
    report.repeats.length === 12 && report.repeats.every(r => r.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
finally { report.finishedAt = new Date().toISOString(); await save(); console.log(`[framegraph-portable] ${report.status}: ${out}`); }
if (report.status !== 'passed') process.exitCode = 1;
