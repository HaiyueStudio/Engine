import { validateG04Suite } from './deferred-g04-suite-policy.mjs';
import { validateG04Output } from './deferred-g04-output-policy.mjs';
import { validateG04Lifecycle } from './deferred-g04-lifecycle-policy.mjs';
import { validateG04Device } from './deferred-g04-device-policy.mjs';
import { validateFrameGraphAdapter, validateFrameGraphBrowser, validateFrameGraphAdapterConsistency } from './framegraph-qualification-policy.mjs';

export const FRAMEGRAPH_CASES = Object.freeze([
  'deferred-g04-suite', 'deferred-g04-output', 'postprocess-multiview',
  'auxiliary-semantics', 'framegraph-reuse', 'framegraph-cache',
  'deferred-g04-lifecycle', 'deferred-g04-device',
]);
export function parseFrameGraphRegressionOptions(args) {
  if (args.length > 1 || args.some(a => !['--smoke', '--full', '--plan'].includes(a)))
    throw Error('Use --smoke, --full or --plan; no argument selects full.');
  return { tier: args[0] === '--smoke' ? 'smoke' : 'full', plan: args[0] === '--plan' };
}
export function createFrameGraphRegressionPlan(tier = 'full', qualification) {
  if (!['smoke', 'full'].includes(tier)) throw Error('Unknown FrameGraph tier');
  if (tier === 'full' && !qualification) throw Error('Full regression requires the selected release qualification path');
  const targets = tier === 'full' ? qualification.targets : [{ powerPreference: 'high-performance' }];
  const cases = tier === 'full' ? FRAMEGRAPH_CASES : ['framegraph-reuse', 'framegraph-cache'];
  return targets.flatMap(target => cases.map(name => ({ name, ...target })));
}
const check = (value, message) => { if (!value) throw Error(message); };
const finite = n => Number.isFinite(n) && n >= 0;
export function validateFrameGraphRegressionResult(result, job, tier = 'full', qualification) {
  if (tier === 'full') {
    check(qualification, 'Full regression requires hardware qualification');
    validateFrameGraphBrowser(result, job, qualification);
  }
  check(FRAMEGRAPH_CASES.includes(job.name), 'Unknown FrameGraph fixture');
  check(result?.schemaVersion === 1 && result.status === 'passed', `${job.name}: ${result?.error ?? 'fixture failed'}`);
  const validator = { 'deferred-g04-suite': validateG04Suite, 'deferred-g04-output': validateG04Output,
    'deferred-g04-lifecycle': validateG04Lifecycle, 'deferred-g04-device': validateG04Device }[job.name];
  if (validator) validator(result);
  if (!job.name.startsWith('framegraph-')) {
    validateFrameGraphAdapter(result.adapter, tier === 'full' ? qualification : null);
    check(Array.isArray(result.validationErrors) && result.validationErrors.length === 0, 'GPU validation errors missing or present');
  }
  if (job.name === 'postprocess-multiview') {
    check(result.frames === 5 && JSON.stringify(result.dimensions) === '[[320,180],[128,96]]', 'Incomplete multiview population');
    check(result.observedAuxiliaryTextures > 0 && result.retiredAuxiliaryTextures === result.observedAuxiliaryTextures, 'Auxiliary texture retirement mismatch');
  }
  if (job.name === 'auxiliary-semantics') check(result.cases?.length === 17 && result.ownerResidual === 0, 'Incomplete auxiliary semantics or residue');
  if (!job.name.startsWith('framegraph-')) return;
  const reuse = job.name === 'framegraph-reuse';
  const expected = [['forward', 1, false], ...(!reuse ? [['forward-msaa', 1, false]] : []),
    ['reference', 4, false], ['tiled', 4, false], ['tiled', 4, true]];
  check(result.cases?.length === expected.length, 'Incomplete ablation population');
  for (const [i, row] of result.cases.entries()) {
    check(finite(row.maxDelta) && row.maxDelta <= 1 / 255, 'Ablation pixel mismatch');
    for (const [name, optimized] of [['baseline', false], ['candidate', true]]) {
      const capture = row[name];
      check(JSON.stringify([capture?.algorithm, capture?.count, capture?.mixed]) === JSON.stringify(expected[i]), 'Ablation identity/order changed');
      check(capture[reuse ? 'reuse' : 'cached'] === optimized, 'Ablation switch mismatch');
      validateFrameGraphAdapter(capture.adapter, tier === 'full' ? qualification : null);
      check(capture.cleanup?.ownerResidual === 0 && capture.cleanup?.liveGpuResources === 0, 'Resource residue');
      check(capture.rgbMaxima?.length === capture.count && capture.rgbMaxima.every(v => finite(v) && v > .1), 'Empty/nonfinite ablation image');
      const dimensions = Array.from({ length: capture.count }, (_, i) => capture.mixed && i % 2 ? [48, 40] : [64, 64]);
      check(JSON.stringify(capture.dimensions) === JSON.stringify(dimensions) &&
        capture.alphaCoverage?.length === capture.count && capture.alphaCoverage.every((v, i) => v === dimensions[i][0] * dimensions[i][1]), 'Incomplete output coverage');
      check(Number.isSafeInteger(capture.actualPasses) && capture.actualPasses > 0, 'Invalid real work count');
      const pools = capture.algorithm.startsWith('forward') ? ['post'] : ['post', 'deferred', 'ao'];
      for (const pool of pools) check(finite(capture.stats?.[pool]?.physicalBytes) && capture.stats[pool].physicalBytes > 0, 'Missing physical resource measurement');
    }
    check(row.baseline.actualPasses === row.candidate.actualPasses, 'Ablation changed real render work');
    for (const pool of Object.keys(row.candidate.stats)) {
      const before = row.baseline.stats[pool]?.physicalBytes, after = row.candidate.stats[pool].physicalBytes;
      check(reuse ? after < before : after === before, 'Unexpected physical allocation delta');
    }
  }
}

// A complete native correctness result is necessary, never sufficient for timing/release qualification.
export function validateFrameGraphRegressionEvidence(evidence, { inputs, sourceFingerprint, tier = 'full', qualification }) {
  check(evidence?.schemaVersion === 3 && evidence.status === 'passed' && evidence.tier === tier, 'Incomplete FrameGraph evidence');
  check(evidence.inputs?.sha256 === inputs && evidence.build?.inputs?.sha256 === inputs && evidence.sourceFingerprint === sourceFingerprint, 'Stale FrameGraph evidence');
  check(evidence.performanceQualified === false, 'Correctness evidence cannot grant performance qualification');
  if (tier === 'full') check(JSON.stringify(evidence.qualification) === JSON.stringify(qualification), 'Qualification contract mismatch');
  const plan = createFrameGraphRegressionPlan(tier, qualification), adapters = [];
  check(evidence.results?.length === plan.length, 'Missing FrameGraph jobs');
  for (const [i, job] of plan.entries()) {
    const entry = evidence.results[i];
    check(entry.name === job.name && entry.powerPreference === job.powerPreference && entry.browserId === job.browserId && entry.status === 'passed', 'Failed/reordered FrameGraph job');
    validateFrameGraphRegressionResult(entry.result, job, tier, qualification);
    if (entry.result.adapter) adapters.push(entry.result.adapter);
    else for (const row of entry.result.cases) adapters.push(row.baseline.adapter, row.candidate.adapter);
  }
  validateFrameGraphAdapterConsistency(adapters);
}
