import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { validateSamplingCorrectness } from './webgpu-gate/framegraph-sampling-policy.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
import { validateFrameGraphWindowsHost } from './webgpu-gate/framegraph-windows-host.mjs';
import { validateFrameGraphForwardPixels } from './webgpu-gate/framegraph-forward-policy.mjs';
import { compareFrameGraphRoomPixels } from './webgpu-gate/framegraph-parity-policy.mjs';
import { GPU_STATE_PROTOCOL, analyzeGpuStateCapture, validateGpuStatePopulation, gpuStatePlan } from './webgpu-gate/framegraph-gpu-state-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.length !== 3) throw Error('Use a completed GPU state diagnostic directory');
const out = resolve(root, process.argv[2]), check = (v, m) => { if (!v) throw Error(m); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safe = (base, name) => { const p = resolve(base, name), r = relative(base, p); check(r && !r.startsWith('..') && !r.includes(':'), 'Unsafe diagnostic artifact path'); return p; };
const read = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const r = await read(resolve(out, 'report.json')), smoke = r.tier === 'gpu-state-engineering-smoke';
check(r.status === 'passed' && r.finishedAt && (smoke || r.tier === 'gpu-state-diagnostic-only') && r.performanceQualified === false && r.createsBaseline === false, 'Not a completed diagnostic');
check(equal(r.diagnosticProtocol, GPU_STATE_PROTOCOL) && equal(r.diagnosticPlan, gpuStatePlan(smoke)), 'Diagnostic protocol/plan changed');
check(r.calibrationEntries.length === 0 && r.baselineEntries.length === 0 && !r.calibration && !r.frozenProtocol && !r.assessment, 'Diagnostic cannot create calibration or a baseline');
for (const f of ['frozen-protocol.json', 'same-host-baseline.json', 'calibration.json']) {
  const exists = await access(resolve(out, f)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; }); check(!exists, 'Diagnostic baseline artifact exists');
}
check(r.sourceFingerprint === createPerformanceSourceFingerprint(root, root) && r.inputs.sha256 === (await deferredRuntimeFingerprint(root)).sha256, 'Diagnostic source/build fingerprint changed');
check(equal(r.baseline, await read(resolve(root, 'artifacts/engine-0.2.1/g09/a0-built/provenance.json'))) && equal(r.build, await read(resolve(root, 'artifacts/engine-0.2.1/g09/fixture-build.json'))), 'Diagnostic build manifest changed');
check(r.baseline.revision === (await read(resolve(root, 'review/engine-0.2.1/g09/dependency-baseline.json'))).revision, 'Diagnostic historical baseline revision changed');
for (const b of r.bindings) {
  check(sha256(await readFile(safe(root, b.path))) === b.sha256 && sha256(await readFile(safe(resolve(out, 'producer'), b.path))) === b.sha256, 'Diagnostic producer binding changed');
}
check(equal(r.config, await read(resolve(out, 'producer/config/framegraph-sampling-021.json'))) && equal(r.hostContract, await read(resolve(out, 'producer/config/framegraph-performance-021.json'))), 'Embedded diagnostic config mismatch');
for (const [variant, manifest] of [['A0', r.baseline], ['B4', r.build]]) for (const f of manifest.outputs) {
  check(sha256(await readFile(safe(resolve(root, 'artifacts/engine-0.2.1/g09', variant === 'A0' ? 'a0-built' : '.'), f.file))) === f.sha256, 'Diagnostic runtime changed');
}
const captures = new Map(), target = r.qualification.targets.find(t => t.browserId === r.hostContract.runner.browserId);
for (const a of r.captures) {
  check(/^\d{3}-(correctness(?:-serial)?|gpu-state)-forward-small-1-(A0|B4)\.json$/.test(a.file) && !captures.has(a.file), 'Invalid diagnostic capture path/population');
  const bytes = await readFile(resolve(out, a.file)); check(sha256(bytes) === a.sha256, 'Changed diagnostic capture');
  const raw = JSON.parse(bytes); captures.set(a.file, raw);
  validateFrameGraphAdapter(raw.adapter, r.qualification); validateFrameGraphBrowser(raw, target, r.qualification);
}
validateFrameGraphAdapterConsistency([...captures.values()].map(c => c.adapter));
const images = {}, completionComparisons = [];
for (const variant of ['A0', 'B4']) {
  const byMode = {};
  for (const mode of ['correctness', 'correctness-serial']) {
    const matching = r.captures.filter(a => a.mode === mode && a.job.variant === variant); check(matching.length === 1, 'Incomplete diagnostic correctness');
    const a = matching[0], raw = captures.get(a.file);
    check(a.job.caseId === GPU_STATE_PROTOCOL.caseId, 'Wrong diagnostic correctness case');
    validateSamplingCorrectness(raw, a.job, r.config, r.hostContract, mode === 'correctness' ? 'B8' : 'S8');
    validateFrameGraphForwardPixels(raw.framegraphPixels); byMode[mode] = raw.framegraphPixels;
  }
  images[variant] = byMode.correctness;
  completionComparisons.push({ variant, comparison: compareFrameGraphRoomPixels(byMode['correctness-serial'], byMode.correctness, { caseId: 'small-8' }) });
}
const correctness = [{ caseId: GPU_STATE_PROTOCOL.caseId, comparison: compareFrameGraphRoomPixels(images.A0, images.B4, { caseId: 'small-8' }), completionComparisons }];
check(equal(correctness, r.correctness) && [...correctness[0].comparison, ...completionComparisons.flatMap(c => c.comparison)].every(c => c.status === 'passed'), 'Diagnostic pixel parity changed');
for (const e of r.diagnosticEntries) {
  check(equal(e.artifact, r.captures.find(a => a.file === e.artifact?.file)) && e.artifact.mode === 'gpu-state' && equal(e.artifact.job, e.job), 'Unbound diagnostic entry');
  check(e.cooldownMs >= (smoke ? 0 : 120000) && e.readiness.length >= 3 && e.readiness.slice(-3).every(s => s.cpu.loadPercent <= 5), 'Missing diagnostic cooldown/readiness');
  check(equal(e.readiness.at(-1), e.hostSamples[0]), 'Diagnostic readiness mismatch');
  for (const h of e.readiness.slice(-3)) validateFrameGraphWindowsHost([h, h], r.hostContract.runner, r.config.powerControl, r.config.gpuControl);
  validateFrameGraphWindowsHost(e.hostSamples, r.hostContract.runner, r.config.powerControl, r.config.gpuControl);
  const telemetryFile = e.artifact.file.replace('.json', '.gpu.jsonl'), observerFile = e.artifact.file.replace('.json', '.observer.json');
  check(e.telemetry.file === telemetryFile && e.telemetry.observerFile === observerFile, 'Wrong telemetry binding');
  const bytes = await readFile(resolve(out, telemetryFile)), observerBytes = await readFile(resolve(out, observerFile));
  check(sha256(bytes) === e.telemetry.sha256 && sha256(observerBytes) === e.telemetry.observerSha256, 'Changed GPU telemetry/observer');
  const rows = bytes.toString().trim().split(/\r?\n/).map(JSON.parse), gpu = e.hostSamples[0].gpu.rows; check(gpu.length === 1, 'Ambiguous GPU identity');
  const analysis = analyzeGpuStateCapture(captures.get(e.artifact.file), rows, JSON.parse(observerBytes), e.job, r.config, r.hostContract, { name: gpu[0][0], driver: gpu[0][1] });
  check(equal(analysis, e.analysis), 'GPU state analysis re-evaluation mismatch');
}
check(new Set(r.diagnosticEntries.map(e => e.artifact.file)).size === r.diagnosticEntries.length && r.captures.length === r.diagnosticEntries.length + 4, 'Duplicate or extra diagnostic population');
check(new Set(r.diagnosticEntries.flatMap(e => e.hostSamples.map(s => s.powerScheme.id))).size === 1, 'Mixed diagnostic power schemes');
check(new Set([...captures.values()].map(c => c.browserEvidence.product)).size === 1, 'Mixed diagnostic browser versions');
const assessment = validateGpuStatePopulation(r.diagnosticEntries, smoke), saved = await read(resolve(out, 'gpu-state-diagnostic.json'));
check(equal(assessment, r.diagnostic) && equal(saved, { protocol: GPU_STATE_PROTOCOL, assessment, rows: r.diagnosticEntries.map(e => e.analysis) }), 'Diagnostic summary changed');
const result = { schemaVersion: 1, verifiedAt: new Date().toISOString(), status: 'diagnostic-complete', tier: r.tier, capturesChecked: captures.size, reportSha256: sha256(await readFile(resolve(out, 'report.json'))), assessment, performanceQualified: false, createsBaseline: false };
await writeFile(resolve(out, 'gpu-state-revalidation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
