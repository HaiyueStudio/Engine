import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { classifyFrameGraphBlackFrame, compareFrameGraphProbePixels, parseFrameGraphBlackFrameOptions } from './webgpu-gate/framegraph-black-frame-policy.mjs';
import { classifyAtomicReadback } from './webgpu-gate/framegraph-readback-controls-policy.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const options = parseFrameGraphBlackFrameOptions(process.argv.slice(2));
const qualification = await loadFrameGraphQualification(root), adapters = [];
const directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const inputs = await deferredRuntimeFingerprint(root), sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const baseline = JSON.parse(await readFile(resolve(directory, 'a0-built/provenance.json'), 'utf8'));
const build = JSON.parse(await readFile(resolve(directory, 'fixture-build.json'), 'utf8'));
const fixed = JSON.parse(await readFile(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json'), 'utf8'));
if (baseline.revision !== fixed.revision || build.inputs.sha256 !== inputs.sha256) throw Error('A0 or B4 runtime identity mismatch');
async function verifyChunks() {
  for (const [name, manifest] of [['A0', baseline], ['B4', build]]) for (const output of manifest.outputs) {
    const path = resolve(directory, name === 'A0' ? 'a0-built' : '.', output.file);
    if (sha256(await readFile(path)) !== output.sha256) throw Error(`Changed ${name} chunk ${output.file}`);
  }
}
await verifyChunks();
const out = resolve(directory, `black-frame-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(out);
const report = { schemaVersion: 2, qualification, status: 'running', performanceQualified: false, scope: 'A0/B4 Forward black-frame attribution only; not complete F0-F8 acceptance',
  generatedAt: new Date().toISOString(), options, inputs, sourceFingerprint, wrapperHash: sha256(await readFile(fileURLToPath(import.meta.url))), baseline, build, results: [], pairs: [] };
const controls = new Map();
try {
  for (const job of qualification.targets) for (const copySource of [false, true])
    for (const access of options.readback === 'atomic' ? ['audited', 'native', 'native-encoding'] : ['audited'])
    for (const [round, variant] of ['A0', 'B4', 'B4', 'A0'].entries()) {
    const { powerPreference, browserId } = job;
    const entry = { ...job, copySource, access, round, variant }; report.results.push(entry);
    try {
      const result = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(browserId), fixture: 'scripts/webgpu-gate/framegraph-black-frame-fixture.html',
        query: { powerPreference, copySource: +copySource, coverage: options.coverage,
          readback: options.readback ?? 'sequential', access }, timeoutMs: 120000, acceptedStatuses: ['passed', 'failed'],
        mounts: [{ prefix: '/artifacts/engine-0.2.1/g09/oracle-runtime', directory: resolve(directory, variant === 'A0' ? 'a0-built' : '.') }] });
      const file = `${browserId}-${+copySource}-${access}-${round}-${variant}.json`;
      await writeFile(resolve(out, file), JSON.stringify(result, null, 2) + '\n');
      entry.raw = { file, sha256: sha256(await readFile(resolve(out, file))) };
      if (result.coverage !== options.coverage || JSON.stringify(result.clearSentinel) !== '[1,0,1,0]' ||
          result.chain !== 'full' || result.aoScratch !== 'r8unorm' ||
          (options.readback === 'atomic' ? result.readback !== 'atomic' || result.access !== access : !result.sourcePixels || !result.readbackWitness))
        throw Error('Coverage experiment identity or source readback missing');
      if (!Array.isArray(result.shaderSubstitutions) || (options.coverage === 'arithmetic-chain' ? result.shaderSubstitutions.length !== 6 : result.shaderSubstitutions.length !== 0))
        throw Error('Fullscreen shader substitution population changed');
      if (options.readback === 'atomic') entry.captureAssessment = classifyAtomicReadback(result);
      entry.assessment = entry.captureAssessment?.failureStage
        ? { status: 'failed', reason: `GPU ${entry.captureAssessment.failureStage}; image assessment unavailable` }
        : classifyFrameGraphBlackFrame(result);
      entry.classification = entry.captureAssessment?.status === 'failed' ? 'capture-unreliable'
        : entry.assessment.status === 'failed' ? 'image-mismatch' : 'passed';
      const key = `${browserId}:${copySource}:${access}`;
      if (round === 0) controls.set(key, result.computed);
      else {
        const comparison = options.readback === 'atomic' && (!controls.get(key) || !result.computed)
          ? { status: 'failed', reason: 'Mapping unavailable in fixed A0 or paired capture', maxDelta: null, changedComponents: null }
          : compareFrameGraphProbePixels(controls.get(key), result.computed);
        const pair = { ...job, copySource, access, variant, round, ...comparison };
        report.pairs.push(pair);
      }
      validateFrameGraphAdapter(result.adapter, qualification);
      validateFrameGraphBrowser(result, job, qualification); adapters.push(result.adapter);
      entry.status = entry.assessment.status === 'passed' && entry.captureAssessment?.status !== 'failed' ? 'passed' : 'failed';
    } catch (error) { entry.status = 'failed'; entry.error = error.stack; }
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`[framegraph-black-frame] ${powerPreference} copy=${copySource} ${access} ${variant}/${round}: ${entry.status} ${entry.classification ?? ''}`);
  }
  if (sourceFingerprint !== createPerformanceSourceFingerprint(root, root) || inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256 ||
      report.wrapperHash !== sha256(await readFile(fileURLToPath(import.meta.url)))) throw Error('Probe inputs changed');
  await verifyChunks();
  await assertFrameGraphQualificationUnchanged(root, qualification);
  validateFrameGraphAdapterConsistency(adapters);
  report.status = report.results.length === qualification.targets.length * (options.readback === 'atomic' ? 24 : 8) &&
    report.results.every(r => r.status === 'passed') && report.pairs.length === qualification.targets.length * (options.readback === 'atomic' ? 18 : 6) &&
    report.pairs.every(r => r.status === 'passed') ? 'passed' : 'failed';
} catch (error) { report.status = 'failed'; report.error = error.stack; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`[framegraph-black-frame] ${out}`);
}
if (report.status !== 'passed') process.exitCode = 1;
