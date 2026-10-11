import { G09_ACCEPTANCE_CASES, validateG09PreflightCoverage, compareG09Pixels } from './framegraph-acceptance-cases.mjs';
import { validateG05RoomResult } from './deferred-g05-policy.mjs';
import { validateG05InstanceResult } from './deferred-g05-instance-policy.mjs';
import { validateFrameGraphRegressionResult } from './framegraph-regression-policy.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser } from './framegraph-qualification-policy.mjs';

export function validateG09PreflightCapture(raw, job, qualification) {
  const spec = G09_ACCEPTANCE_CASES.find(c => c.id === job.caseId);
  if (!spec) throw Error('Unregistered capture');
  if (raw?.status !== 'passed') throw Error(`Native fixture failed: ${raw?.error ?? 'missing result'}`);
  validateFrameGraphBrowser(raw, job, qualification);
  if (['F6', 'F7'].includes(spec.group)) {
    validateFrameGraphRegressionResult(raw, { ...job, name: spec.fixture }, 'full', qualification);
    return;
  }
  validateFrameGraphAdapter(raw.adapter, qualification);
  if (spec.fixture === 'deferred-g05-instance') validateG05InstanceResult(raw, { ...spec.parameters, full: false });
  else if (spec.fixture.startsWith('deferred-g05-')) {
    validateG05RoomResult(raw, { ...spec.parameters, moving: true, full: false });
    if (spec.group === 'F2' && (raw.creationCosts?.ao !== 'gtao' || raw.creationCosts?.settings?.quality !== 'high' || raw.creationCosts?.settings?.resolutionScale !== 1)) throw Error('F2 AO quality changed');
  } else {
    if (raw.status !== 'passed' || raw.schemaVersion !== 1 || raw.suite !== 'g09-acceptance-scenes' || raw.caseId !== spec.id ||
      JSON.stringify(raw.parameters) !== JSON.stringify(spec.parameters) || JSON.stringify(raw.dimensions) !== JSON.stringify(spec.dimensions) ||
      raw.performanceQualified !== false || raw.validationErrors?.length !== 0 || raw.cleanup?.ownerResidual !== 0 || raw.cleanup?.liveGpuResources !== 0) throw Error('Scene identity, validation or cleanup failed');
    if (raw.settlingFrames !== (spec.group === 'F3' ? 32 : 8)) throw Error('History/correctness frame population changed');
    if (spec.group === 'F0' && (raw.effects?.length !== 0 || raw.deferredAllocations?.deferredCreated?.length !== 0 || raw.diagnostics !== null)) throw Error('Effects-off Forward allocated Deferred work');
    if (spec.group === 'F3' && JSON.stringify(raw.effects) !== JSON.stringify(['TaaPass', 'GaussianBlurPass', 'OutlinePass'])) throw Error('Temporal effect chain changed');
    if (spec.group !== 'F0' && spec.parameters.scene !== 'mirror' && raw.diagnostics?.completeCoverage !== true) throw Error('Incomplete Deferred light coverage');
    if (spec.parameters.count && raw.source?.pointCount !== spec.parameters.count) throw Error('Authored and processed light counts differ');
    if (spec.parameters.scene === 'mirror' && (raw.diagnostics?.effective !== 'forward' || raw.diagnostics?.completeCoverage !== false)) throw Error('Mirror fallback identity changed');
  }
}

// Re-read every raw capture and recompute pixel pairs; a summary marked passed
// is not accepted as a substitute for evidence bytes or for full coverage.
export async function auditG09Preflight(report, loadRaw) {
  validateG09PreflightCoverage(report);
  const pairs = [], browserVersions = new Map(), adapters = new Set(); let before;
  for (const entry of report.entries) {
    const raw = await loadRaw(entry.raw);
    validateG09PreflightCapture(raw, entry.job, report.qualification);
    validateG09ServedInputs(raw, entry.job, report);
    const browser = raw.browserEvidence;
    const browserKey = JSON.stringify([browser.product, browser.userAgent, browser.angleBackend]);
    const oldBrowser = browserVersions.get(entry.job.browserId);
    if (oldBrowser && oldBrowser !== browserKey) throw Error('Browser version/backend changed during population');
    browserVersions.set(entry.job.browserId, browserKey);
    if (raw.adapter) adapters.add(JSON.stringify([raw.adapter.vendor, raw.adapter.architecture]));
    else for (const capture of raw.cases ?? []) for (const side of ['baseline', 'candidate']) {
      if (capture[side]?.adapter) adapters.add(JSON.stringify([capture[side].adapter.vendor, capture[side].adapter.architecture]));
    }
    const spec = G09_ACCEPTANCE_CASES.find(c => c.id === entry.job.caseId);
    if (spec.pairedPixels) {
      if (entry.job.variant === 'A0') before = raw.framegraphPixels;
      else {
        pairs.push({ caseId: spec.id, browserId: entry.job.browserId, views: compareG09Pixels(before, raw.framegraphPixels, spec) });
        before = null;
      }
    }
  }
  if (adapters.size !== 1) throw Error('Adapter class changed during population');
  if (JSON.stringify(pairs) !== JSON.stringify(report.pairs)) throw Error('Stored pair assessment differs from raw pixels');
  return validateG09PreflightCoverage(report);
}

export function validateG09ServedInputs(raw, job, report) {
  const manifest = job.variant === 'A0' ? report.baseline : report.build;
  if (!manifest?.outputs?.length || !report.harness?.length) throw Error('Missing runtime/harness bindings');
  const expected = new Map(manifest.outputs.map(file => [file.file, file.sha256]));
  const harness = new Map(report.harness.map(file => [file.path, file.sha256]));
  const auxiliary = new Map((report.auxiliaryDist?.files ?? []).map(file => [file.path, file.sha256]));
  const spec = G09_ACCEPTANCE_CASES.find(c => c.id === job.caseId);
  const packageFixture = ['postprocess-multiview', 'auxiliary-semantics'].includes(spec?.fixture);
  const files = raw.httpProvenance?.files;
  if (raw.httpProvenance?.transport !== 'http' || !files?.length) throw Error('Missing served-byte provenance');
  let entryLoaded = false;
  for (const file of files) {
    const match = /^artifacts\/engine-0\.2\.1\/g0[3459]\/(.+)$/.exec(file.sourcePath);
    if (match) {
      if (expected.get(match[1]) !== file.sha256) throw Error('Served runtime differs from selected A0/B4');
      if (match[1] === 'fixture.js') entryLoaded = true;
    } else if (file.sourcePath.startsWith('engine/dist/')) {
      if (!packageFixture || job.variant !== 'B4' || auxiliary.get(file.sourcePath) !== file.sha256) throw Error('Unbound/incorrect package runtime');
      entryLoaded = true;
    } else if (file.sourcePath.startsWith('scripts/') && harness.get(file.sourcePath) !== file.sha256) {
      throw Error(`Served fixture differs from frozen harness: ${file.sourcePath}`);
    }
  }
  if (!entryLoaded) throw Error('Selected runtime entry was not served');
}
