import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, deferredRuntimeFingerprint } from './webgpu-gate/deferred-fixture-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { validateFrameGraphForwardPixels } from './webgpu-gate/framegraph-forward-policy.mjs';
import { compareFrameGraphRoomPixels } from './webgpu-gate/framegraph-parity-policy.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
import { evaluateCalibration, evaluateSteadyBaseline, validateSamplingPowerContinuity } from './webgpu-gate/framegraph-sampling-policy.mjs';
const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
if (args.length !== 1) throw Error('Use a completed G09 sampling artifact directory');
const out = resolve(root, args[0]), read = async file => JSON.parse(await readFile(resolve(out, file), 'utf8'));
const check = (v, message) => { if (!v) throw Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const r = await read('report.json');
check(r.schemaVersion === 1 && r.tier === 'g09-cold-steady-development' && r.performanceQualified === false && r.finishedAt, 'Not a completed development population');
check(r.sourceFingerprint === createPerformanceSourceFingerprint(root, root) && r.inputs.sha256 === (await deferredRuntimeFingerprint(root)).sha256, 'Source/runtime input fingerprint changed');
for (const [variant, manifest] of [['A0', r.baseline], ['B4', r.build]]) for (const f of manifest.outputs) {
  check(!f.file.includes('..') && !f.file.includes(':') && !f.file.startsWith('/') && !f.file.startsWith('\\'), 'Unsafe runtime manifest path');
  const path = resolve(root, 'artifacts/engine-0.2.1/g09', variant === 'A0' ? 'a0-built' : '.', f.file);
  check(sha256(await readFile(path)) === f.sha256, 'Runtime chunk changed');
}
for (const binding of r.bindings) {
  check(binding.path && !binding.path.includes('..') && !binding.path.includes(':') && !binding.path.startsWith('/') && !binding.path.startsWith('\\'), 'Unsafe producer path');
  check(sha256(await readFile(resolve(out, 'producer', binding.path))) === binding.sha256, 'Changed producer snapshot');
  check(sha256(await readFile(resolve(root, binding.path))) === binding.sha256, 'Current validator/input differs from captured producer');
}
check(equal(r.config, await read('producer/config/framegraph-sampling-021.json')) && equal(r.hostContract, await read('producer/config/framegraph-performance-021.json')), 'Embedded config mismatch');
const captures = new Map();
const target = r.qualification.targets.find(t => t.browserId === r.hostContract.runner.browserId);
for (const artifact of r.captures) {
  check(/^\d{3}-(correctness|calibration|baseline)-(forward-small-1|forward-cap-8)-(A0|B4)\.json$/.test(artifact.file), 'Unsafe capture path');
  const bytes = await readFile(resolve(out, artifact.file));
  check(sha256(bytes) === artifact.sha256 && !captures.has(artifact.file), 'Changed or duplicate capture');
  const raw = JSON.parse(bytes); captures.set(artifact.file, raw);
  validateFrameGraphAdapter(raw.adapter, r.qualification); validateFrameGraphBrowser(raw, target, r.qualification);
}
validateFrameGraphAdapterConsistency([...captures.values()].map(c => c.adapter));
for (const caseId of r.config.cases) {
  const images = {};
  for (const variant of ['A0', 'B4']) {
    const a = r.captures.filter(c => c.mode === 'correctness' && c.job.caseId === caseId && c.job.variant === variant);
    check(a.length === 1, 'Incomplete correctness population');
    images[variant] = captures.get(a[0].file).framegraphPixels; validateFrameGraphForwardPixels(images[variant]);
  }
  check(compareFrameGraphRoomPixels(images.A0, images.B4, { caseId: 'small-8' }).every(c => c.status === 'passed'), 'Pixel parity failed during revalidation');
}
function hydrate(entries, mode) {
  return entries.map(e => {
    check(e.artifact?.mode === mode && equal(e.job, e.artifact.job), 'Entry/capture job mismatch');
    check(equal(e.artifact, r.captures.find(c => c.file === e.artifact.file)), 'Unbound entry');
    return { ...e, result: captures.get(e.artifact.file) };
  });
}
const calibration = evaluateCalibration(hydrate(r.calibrationEntries, 'calibration'), r.config, r.hostContract);
check(equal(calibration, r.calibration), 'Calibration re-evaluation mismatch');
const result = { schemaVersion: 1, verifiedAt: new Date().toISOString(), sourceFingerprint: r.sourceFingerprint,
  reportSha256: sha256(await readFile(resolve(out, 'report.json'))), capturesChecked: captures.size, calibration,
  performanceQualified: false, status: 'calibration-failed' };
if (calibration.status === 'passed') {
  validateSamplingPowerContinuity(r.calibrationEntries, r.baselineEntries, r.config);
  const frozen = await read('frozen-protocol.json'), c = await read('calibration.json');
  if (r.config.powerControl) check(equal(frozen.powerControl, r.config.powerControl) && frozen.powerSchemeId === r.calibrationEntries[0].hostSamples[0].powerScheme.id, 'Frozen power condition mismatch');
  check(equal(frozen, r.frozenProtocol) && equal(c.assessment, calibration) && frozen.calibrationHash === sha256(await readFile(resolve(out, 'calibration.json'))) && frozen.warmup === calibration.selectedWarmup, 'Frozen calibration mismatch');
  check(equal(c.captures, r.captures.filter(a => a.mode === 'calibration')), 'Calibration capture set mismatch');
  check(Date.parse(frozen.frozenAt) >= Date.parse(r.calibrationEntries.at(-1).captureFinishedAt) && Date.parse(frozen.frozenAt) <= Date.parse(r.baselineEntries[0].captureStartedAt), 'Protocol was not frozen before fresh baseline');
  check(new Set([...r.calibrationEntries, ...r.baselineEntries].map(e => e.artifact.file)).size === 24, 'Reused calibration captures as baseline');
  const budget = await read('producer/config/lighting-performance-021.json');
  result.assessment = evaluateSteadyBaseline(hydrate(r.baselineEntries, 'baseline'), r.config, r.hostContract, calibration, budget.relativeBudgets);
  check(equal(result.assessment, r.assessment) && result.assessment.status === r.status, 'Baseline re-evaluation mismatch');
  const a0 = await read('same-host-baseline.json');
  check(equal(a0.captures, r.captures.filter(a => a.mode === 'baseline' && a.job.variant === 'A0')) && equal(a0.frozenProtocol, frozen), 'A0 baseline binding mismatch');
  check(equal(a0.rows, result.assessment.rows.map(row => ({ caseId: row.caseId, metric: row.metric, gated: row.gated, ...row.A0 }))), 'A0 baseline statistics mismatch');
  result.status = r.status;
}
await writeFile(resolve(out, 'revalidation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, capturesChecked: result.capturesChecked, selectedWarmup: calibration.selectedWarmup, baselineStable: result.assessment?.baselineStable, performanceQualified: false }));
if (result.status !== 'passed') process.exitCode = 1;
