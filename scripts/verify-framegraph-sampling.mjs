import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runChromeWebGpuFixture } from './webgpu-gate/chrome-runner.mjs';
import { deferredRuntimeFingerprint, sha256 } from './webgpu-gate/deferred-fixture-policy.mjs';
import { loadFrameGraphQualification, frameGraphBrowserPath, assertFrameGraphQualificationUnchanged } from './webgpu-gate/framegraph-qualification.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './webgpu-gate/framegraph-qualification-policy.mjs';
import { G05_FORWARD_CASES } from './webgpu-gate/deferred-g05-forward-policy.mjs';
import { validateFrameGraphForwardCapture, validateFrameGraphForwardPixels } from './webgpu-gate/framegraph-forward-policy.mjs';
import { captureFrameGraphWindowsHost, validateFrameGraphWindowsHost } from './webgpu-gate/framegraph-windows-host.mjs';
import { waitG05Cooldown } from './webgpu-gate/deferred-g05-cooldown.mjs';
import { captureFrameGraphPixels } from './webgpu-gate/framegraph-pixel-oracle.mjs';
import { compareFrameGraphRoomPixels } from './webgpu-gate/framegraph-parity-policy.mjs';
import { createPerformanceSourceFingerprint } from './webgpu-performance-budget.mjs';
import { createSamplingPlan, validateSamplingCapture, validateSamplingCorrectness, evaluateCalibration, evaluateSteadyBaseline, validateSamplingPowerContinuity, isBatchSampling } from './webgpu-gate/framegraph-sampling-policy.mjs';
import { validateBoundedFrameCompletion } from './webgpu-gate/framegraph-batch-policy.mjs';
import { GPU_STATE_PROTOCOL, gpuStatePlan, analyzeGpuStateCapture, validateGpuStatePopulation } from './webgpu-gate/framegraph-gpu-state-policy.mjs';
import { startGpuStateObserver } from './webgpu-gate/framegraph-gpu-state-observer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || !['--plan', '--smoke', '--fixture-smoke', '--full', '--gpu-state-plan', '--gpu-state-diagnostic', '--gpu-state-smoke'].includes(args[0])) throw Error('Use --plan, --smoke, --fixture-smoke, --full, --gpu-state-plan, --gpu-state-diagnostic or --gpu-state-smoke [workspace-output-directory]');
const gpuState = args[0].startsWith('--gpu-state-'), gpuStateSmoke = args[0] === '--gpu-state-smoke';
const full = args[0] === '--full' || args[0] === '--gpu-state-diagnostic';
const read = async p => JSON.parse(await readFile(resolve(root, p), 'utf8'));
const config = await read('config/framegraph-sampling-021.json'), host = await read(config.hostContract), budgets = await read('config/lighting-performance-021.json');
const plan = createSamplingPlan(config), qualification = await loadFrameGraphQualification(root);
if (args[0] === '--plan') { console.log(JSON.stringify({ config, plan, minimumCooldownMinutes: plan.length * 4, performanceQualified: false }, null, 2)); process.exit(0); }
if (args[0] === '--gpu-state-plan') { console.log(JSON.stringify({ protocol: GPU_STATE_PROTOCOL, config, plan: gpuStatePlan(), minimumCooldownMinutes: 12, approximateMinutes: '25-35', performanceQualified: false, createsBaseline: false }, null, 2)); process.exit(0); }
const generatedAt = new Date().toISOString(), directory = resolve(root, 'artifacts/engine-0.2.1/g09');
const out = args[1] ? resolve(root, args[1]) : resolve(directory, `sampling-${generatedAt.replaceAll(':', '-')}`);
if (!relative(directory, out) || relative(directory, out).startsWith('..') || relative(directory, out).includes(':')) throw Error('Output must be a new child of the G09 artifact directory');
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'run.lock'), `${process.pid}\n`, { flag: 'wx' });
const target = qualification.targets.find(t => t.browserId === host.runner.browserId);
if (!target || qualification.hostname !== host.runner.hostname || qualification.platform !== host.runner.platform) throw Error('Register actual sampling host before capture');
const baseline = await read('artifacts/engine-0.2.1/g09/a0-built/provenance.json'), build = await read('artifacts/engine-0.2.1/g09/fixture-build.json');
const fixed = await read('review/engine-0.2.1/g09/dependency-baseline.json'), inputs = await deferredRuntimeFingerprint(root);
if (baseline.revision !== fixed.revision || inputs.sha256 !== build.inputs.sha256) throw Error('Stale A0/B4 runtime builds');
const sourceFingerprint = createPerformanceSourceFingerprint(root, root);
const filePaths = ['config/framegraph-sampling-021.json', config.hostContract, 'config/lighting-performance-021.json',
  'scripts/verify-framegraph-sampling.mjs', 'scripts/validate-framegraph-sampling.mjs', 'scripts/run-framegraph-unattended.ps1', 'scripts/webgpu-gate/framegraph-sampling-policy.mjs', 'scripts/webgpu-gate/deferred-g05-forward-fixture.mjs',
  'scripts/webgpu-gate/deferred-g05-forward-policy.mjs', 'scripts/webgpu-gate/chrome-runner.mjs', 'scripts/webgpu-gate/framegraph-windows-host.mjs',
  'scripts/webgpu-gate/framegraph-power-observation.ps1', 'scripts/webgpu-gate/framegraph-power-control.ps1',
  'scripts/webgpu-gate/framegraph-gpu-policy.mjs', 'scripts/webgpu-gate/framegraph-gpu-power-control.ps1', 'scripts/webgpu-gate/framegraph-gpu-power-observation.ps1', 'scripts/webgpu-gate/framegraph-nvapi-chrome-power.cs', 'scripts/webgpu-gate/framegraph-background-policy.ps1'];
if (isBatchSampling(config)) filePaths.push('scripts/webgpu-gate/framegraph-batch-completion.mjs', 'scripts/webgpu-gate/framegraph-batch-policy.mjs', 'scripts/webgpu-gate/completed-fixture-transfer.mjs',
  'scripts/start-framegraph-calibration.ps1', 'scripts/start-framegraph-unattended.ps1', 'scripts/webgpu-gate/framegraph-build-preflight.ps1',
  'scripts/webgpu-gate/check-framegraph-build.mjs', 'scripts/webgpu-gate/framegraph-build-policy.mjs', 'scripts/webgpu-gate/framegraph-desktop-preflight.ps1',
  'scripts/webgpu-gate/check-framegraph-desktop.mjs', 'scripts/webgpu-gate/framegraph-desktop-policy.mjs', 'scripts/webgpu-gate/framegraph-launch-permissions.ps1', 'scripts/webgpu-gate/framegraph-sampling-lease.ps1');
if (gpuState) filePaths.push('scripts/webgpu-gate/framegraph-gpu-state-policy.mjs', 'scripts/webgpu-gate/framegraph-gpu-state-observer.mjs', 'scripts/validate-framegraph-gpu-state.mjs');
const bindings = await Promise.all(filePaths.map(async path => ({ path, sha256: sha256(await readFile(resolve(root, path))) })));
for (const { path } of bindings) { const to = resolve(out, 'producer', path); await mkdir(dirname(to), { recursive: true }); await copyFile(resolve(root, path), to); }
const report = { schemaVersion: 1, status: 'running', tier: gpuState ? gpuStateSmoke ? 'gpu-state-engineering-smoke' : 'gpu-state-diagnostic-only' : args[0] === '--full' ? 'g09-cold-steady-development' : 'smoke', performanceQualified: false,
  generatedAt, config, hostContract: host, qualification, plan, baseline, build, inputs, sourceFingerprint, bindings,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), correctness: [], captures: [], calibrationEntries: [], baselineEntries: [] };
if (gpuState) Object.assign(report, { diagnosticProtocol: GPU_STATE_PROTOCOL, diagnosticPlan: gpuStatePlan(gpuStateSmoke), diagnosticEntries: [], createsBaseline: false });
async function atomic(file, value) { const p = resolve(out, file); await writeFile(`${p}.tmp`, JSON.stringify(value, null, 2) + '\n'); await rename(`${p}.tmp`, p); }
const save = () => atomic('report.json', JSON.parse(JSON.stringify(report, (key, value) => key === 'result' ? undefined : value)));
const status = (phase, details = {}) => atomic('status.json', { phase, at: new Date().toISOString(), ...details });
async function verifyInputs() {
  for (const [variant, manifest] of [['A0', baseline], ['B4', build]]) for (const f of manifest.outputs)
    if (sha256(await readFile(resolve(directory, variant === 'A0' ? 'a0-built' : '.', f.file))) !== f.sha256) throw Error('Runtime chunk changed');
  await assertFrameGraphQualificationUnchanged(root, qualification);
  if (sourceFingerprint !== createPerformanceSourceFingerprint(root, root) || inputs.sha256 !== (await deferredRuntimeFingerprint(root)).sha256) throw Error('Sampling source changed');
  for (const b of bindings) if (sha256(await readFile(resolve(root, b.path))) !== b.sha256) throw Error(`Sampling input changed: ${b.path}`);
}
async function capture(job, mode, warmup, gpuWarmup = 120) {
  const diagnostic = mode === 'gpu-state', pixels = mode.startsWith('correctness'), engineering = mode.startsWith('engineering'), batch = isBatchSampling(config), c = G05_FORWARD_CASES.find(c => c.id === job.caseId); let images;
  const arm = mode === 'correctness-serial' ? 'S8' : 'B8';
  const gpuSamples = pixels ? batch ? 19 : 3 : batch && (diagnostic || ['calibration', 'engineering-calibration'].includes(mode)) ? config.gpuCalibration.totalFrames - gpuWarmup : 300;
  const file = `${String(report.captures.length).padStart(3, '0')}-${mode}-${job.caseId}-${job.variant}.json`;
  const telemetryFile = file.replace('.json', '.gpu.jsonl'), observerFile = file.replace('.json', '.observer.json');
  let monitor, observer, raw;
  try {
  if (diagnostic) monitor = await startGpuStateObserver(resolve(out, telemetryFile));
  raw = await runChromeWebGpuFixture({ root, browserPath: frameGraphBrowserPath(target.browserId), fixture: 'scripts/webgpu-gate/deferred-g05-forward-fixture.html',
    query: { ...c, framegraphRuntime: 1, framegraphOracle: +pixels, powerPreference: target.powerPreference, resolution: '720p',
      warmup: pixels ? 2 : warmup, samples: pixels ? gpuSamples : engineering ? 120 : diagnostic || mode === 'calibration' ? config.calibration.totalCpuFrames - warmup : 3000, gpuSamples,
      ...(batch ? { gpuWarmup: pixels ? 5 : gpuWarmup, framegraphSamplingProtocol: config.contractId, framegraphBatchArm: arm } : {}),
      ...(!pixels && !engineering ? { framegraphSampling: diagnostic ? 'calibration' : mode, framegraphSamplingProtocol: config.contractId } : {}) },
    mounts: [{ prefix: '/games', directory: resolve(root, 'scripts/fixtures/lighting-content') },
      { prefix: '/artifacts/engine-0.2.1/g09/oracle-runtime', directory: resolve(directory, job.variant === 'A0' ? 'a0-built' : '.') }],
    timeoutMs: 900000, disableDx12InfoCollection: config.browserControl?.disableDx12InfoCollection === true, chunkedResult: batch,
    ...(pixels ? { interact: async cdp => { images = await captureFrameGraphPixels(cdp); } } : {}) });
  } catch (error) { if (error.observer) await atomic(observerFile, error.observer); throw error; }
  finally { if (monitor) { observer = await monitor.stop(); await atomic(observerFile, observer); } }
  const bytes = JSON.stringify({ ...raw, ...(images ? { framegraphPixels: images } : {}) });
  await writeFile(resolve(out, file), bytes);
  const artifact = { job, mode, file, sha256: sha256(bytes) }; report.captures.push(artifact);
  validateFrameGraphAdapter(raw.adapter, qualification); validateFrameGraphBrowser(raw, target, qualification);
  if (pixels) {
    if (batch) validateSamplingCorrectness(raw, job, config, host, arm);
    else validateFrameGraphForwardCapture(raw, { ...job, full: false }, host);
    validateFrameGraphForwardPixels(images);
  }
  else if (!engineering) validateSamplingCapture(raw, job, config, diagnostic ? 'calibration' : mode, warmup, gpuWarmup);
  if (batch) validateBoundedFrameCompletion(raw.g09GpuCompletion, { arm, warmup: pixels ? 5 : gpuWarmup, samples: gpuSamples });
  if (engineering && (raw.execution.validation.errorCount !== 0 || raw.g05Forward.cleanup.liveGpuResources !== 0 || raw.g05Forward.cleanup.ownerResidual !== 0)) throw Error('Engineering validation/cleanup failed');
  let telemetry;
  if (diagnostic) telemetry = { file: telemetryFile, sha256: sha256(await readFile(resolve(out, telemetryFile))),
    observerFile, observerSha256: sha256(await readFile(resolve(out, observerFile))), rows: monitor.rows, observer };
  return { raw, images, artifact, telemetry };
}
async function population(mode, warmup, jobs, gpuWarmup = 120) {
  const entries = mode === 'gpu-state' ? report.diagnosticEntries : mode === 'calibration' ? report.calibrationEntries : report.baselineEntries;
  for (const [i, job] of jobs.entries()) {
    const e = { job, status: 'running', readiness: [] }; entries.push(e);
    try {
      const idleMs = full ? 120000 : 0;
      e.cooldownStartedAt = new Date().toISOString();
      await status('cooldown', { mode, index: i + 1, total: jobs.length, job, captureNotBefore: new Date(Date.now() + idleMs).toISOString() });
      e.cooldownMs = await waitG05Cooldown(idleMs);
      e.cooldownFinishedAt = new Date().toISOString();
      // Readiness retries happen before any measured frame; every observation is kept.
      // They may delay a job, but may never replace or discard a completed capture.
      const started = performance.now(); let before, quietSamples = 0;
      while (true) {
        before = await captureFrameGraphWindowsHost(config.powerControl, config.gpuControl); e.readiness.push(before);
        try {
          validateFrameGraphWindowsHost([before, before], host.runner, config.powerControl, config.gpuControl);
          quietSamples = before.cpu.loadPercent <= 5 ? quietSamples + 1 : 0;
          if (quietSamples >= 3) break;
          if (performance.now() - started >= 600000) throw Error('Host did not reach three quiet entry observations (CPU <=5%)');
          await status('waiting-for-idle', { mode, index: i + 1, cpu: before.cpu.loadPercent, quietSamples, requiredQuietSamples: 3 });
          await new Promise(r => setTimeout(r, 3000));
        }
        catch (error) {
          if (!error.message.startsWith('Host busy:') || performance.now() - started >= 600000) throw error;
          quietSamples = 0;
          await status('waiting-for-idle', { mode, index: i + 1, cpu: before.cpu.loadPercent, error: error.message });
          await new Promise(r => setTimeout(r, 15000));
        }
      }
      e.hostSamples = [before]; e.captureStartedAt = new Date().toISOString();
      await status('capture', { mode, index: i + 1, total: jobs.length, job });
      const { raw, artifact, telemetry } = await capture(job, mode, warmup, gpuWarmup); e.result = raw; e.artifact = artifact;
      if (telemetry) {
        const { rows, observer, ...binding } = telemetry; e.telemetry = binding;
        const gpu = before.gpu.rows;
        if (gpu.length !== 1) throw Error('GPU state diagnosis requires exactly one observed NVIDIA adapter');
        e.analysis = analyzeGpuStateCapture(raw, rows, observer, job, config, host, { name: gpu[0][0], driver: gpu[0][1] });
      }
      e.hostSamples.push(await captureFrameGraphWindowsHost(config.powerControl, config.gpuControl));
      e.captureFinishedAt = new Date().toISOString();
      validateFrameGraphWindowsHost(e.hostSamples, host.runner, config.powerControl, config.gpuControl); e.status = 'passed';
    } catch (error) { e.status = 'failed'; e.error = error.stack; throw error; }
    finally { await save(); }
  }
  validateFrameGraphAdapterConsistency(entries.map(e => e.result.adapter));
  await verifyInputs();
  return entries;
}
console.log(`[framegraph-sampling] Independent worker started: ${out}`);
try {
  await save(); await verifyInputs(); await status('correctness');
  for (const caseId of gpuState ? [GPU_STATE_PROTOCOL.caseId] : config.cases) {
    const images = {}, completionComparisons = [];
    for (const variant of ['A0', 'B4']) {
      const value = await capture({ caseId, variant }, 'correctness', 2); images[variant] = value.images;
      if (isBatchSampling(config)) {
        const control = await capture({ caseId, variant }, 'correctness-serial', 2);
        const comparison = compareFrameGraphRoomPixels(control.images, value.images, { caseId: 'small-8' });
        if (comparison.some(c => c.status !== 'passed')) throw Error('Serial/batched full-image parity failed');
        completionComparisons.push({ variant, comparison });
      }
    }
    const comparison = compareFrameGraphRoomPixels(images.A0, images.B4, { caseId: 'small-8' });
    if (comparison.some(c => c.status !== 'passed')) throw Error('A0/B4 full-image parity failed');
    report.correctness.push({ caseId, comparison, ...(isBatchSampling(config) ? { completionComparisons } : {}) });
  }
  if (gpuState) {
    await population('gpu-state', 120, gpuStatePlan(gpuStateSmoke));
    report.diagnostic = validateGpuStatePopulation(report.diagnosticEntries, gpuStateSmoke);
    await atomic('gpu-state-diagnostic.json', { protocol: GPU_STATE_PROTOCOL, assessment: report.diagnostic, rows: report.diagnosticEntries.map(e => e.analysis) });
    report.status = 'passed';
  } else if (args[0] === '--fixture-smoke') {
    for (const mode of ['engineering-calibration', 'engineering-baseline']) for (const caseId of config.cases) for (const variant of ['A0', 'B4']) {
      await status(mode, { caseId, variant }); await capture({ caseId, variant }, mode, 120); await save();
    }
    await verifyInputs(); report.status = 'passed';
  } else {
  const calibration = await population('calibration', 120, args[0] === '--full' ? plan : plan.slice(0, 1));
  if (args[0] === '--smoke') report.status = 'passed';
  else {
    report.calibration = evaluateCalibration(calibration, config, host);
    await atomic('calibration.json', { generatedAt: new Date().toISOString(), sourceFingerprint, bindings, captures: report.captures.filter(c => c.mode === 'calibration'), assessment: report.calibration });
    if (report.calibration.status !== 'passed') throw Error('No shared stable CPU/GPU plateau; fresh baseline blocked');
    const calibrationHash = sha256(await readFile(resolve(out, 'calibration.json')));
    report.frozenProtocol = { contractId: config.contractId, warmup: report.calibration.selectedWarmup, sampling: config.sampling,
      ...(isBatchSampling(config) ? { gpuWarmup: report.calibration.selectedGpuWarmup, gpuCompletion: config.gpuCompletion, browserControl: config.browserControl } : {}),
      powerControl: config.powerControl ?? null, gpuControl: config.gpuControl ?? null, powerSchemeId: calibration[0].hostSamples[0].powerScheme.id,
      calibrationHash, frozenAt: new Date().toISOString(), sourceFingerprint, bindings };
    await atomic('frozen-protocol.json', report.frozenProtocol); await save();
    const entries = await population('baseline', report.frozenProtocol.warmup, plan, report.frozenProtocol.gpuWarmup ?? 120);
    validateSamplingPowerContinuity(calibration, entries, config);
    if (sha256(await readFile(resolve(out, 'calibration.json'))) !== calibrationHash) throw Error('Calibration changed after freeze');
    report.assessment = evaluateSteadyBaseline(entries, config, host, report.calibration, budgets.relativeBudgets);
    report.status = report.assessment.status;
    if (report.status !== 'passed') report.error = report.assessment.rows.filter(r => r.gated && !r.passed)
      .map(r => `${r.caseId}/${r.metric}: B4/A0 P95=${r.ratio}, limit=${r.limit ?? 'stability-only'}, A0 stable=${r.A0.stability.stable}, B4 stable=${r.B4.stability.stable}`).join('; ');
    await atomic('same-host-baseline.json', { schemaVersion: 1, status: report.assessment.baselineStable ? 'stable-development-baseline' : 'unstable', performanceQualified: false,
      sourceFingerprint, inputs, qualification, frozenProtocol: report.frozenProtocol, fixedA0: baseline,
      captures: report.captures.filter(c => c.mode === 'baseline' && c.job.variant === 'A0'),
      rows: report.assessment.rows.map(r => ({ caseId: r.caseId, metric: r.metric, gated: r.gated, ...r.A0 })) });
  }
  }
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); await save(); await status('finished', { status: report.status, error: report.error, calibration: report.calibration?.selectedWarmup, gpuCalibration: report.calibration?.selectedGpuWarmup }); console.log(`[framegraph-sampling] ${report.status}: ${out}`); }
if (report.status !== 'passed') process.exitCode = 1;
