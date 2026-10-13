// G09 stage-six registry. IDs and workloads are fixed before collecting results.
// Correctness preflight never grants timing, G05, or clean-release qualification.
const rows = [];
const add = (group, id, fixture, parameters, dimensions, pairedPixels = true) => rows.push({
  group, id, fixture, parameters, dimensions, pairedPixels,
  hdrDimensions: dimensions.map(([w, h], i) => parameters.layout === 'mixed-viewport' && i % 2 ? [w - 32, h - 32] : [w, h]),
});
for (const lights of [1, 8]) add('F0', `f0-forward-${lights}-effects-off`, 'framegraph-acceptance',
  { scene: 'forward', lights, effects: 'off' }, [[1280, 720]]);
for (const count of [128, 256]) for (const overlap of [false, true]) for (const moving of [false, true]) {
  for (const algorithm of ['reference', 'tiled']) add('F1', `f1-${count}-${overlap ? 'overlap' : 'sparse'}-${moving ? 'dynamic' : 'static'}-${algorithm}`,
    'framegraph-acceptance', { scene: 'room', count, overlap, moving, algorithm }, [[1280, 720]]);
}
for (const algorithm of ['reference', 'tiled']) {
  add('F2', `f2-gtao-${algorithm}`, 'deferred-g05-cost',
    { caseId: '1080p-128', algorithm, ao: 'gtao', moving: 1, full: 0, framegraphOracle: 1 }, [[1920, 1080]]);
  add('F3', `f3-transparent-history-${algorithm}`, 'framegraph-acceptance',
    { scene: 'temporal', count: 128, overlap: false, moving: true, algorithm }, [[1280, 720]]);
  for (const layout of ['single', 'four', 'mixed-viewport']) add('F4', `f4-${layout}-${algorithm}`, 'framegraph-acceptance',
    { scene: 'multiview', layout, count: 128, overlap: false, moving: true, algorithm },
    layout === 'single' ? [[1280, 720]] : layout === 'four' ? Array.from({ length: 4 }, () => [1280, 720]) : [[1280, 720], [640, 360], [960, 540], [640, 480]]);
  for (const scene of ['rtt', 'mirror']) add('F5', `f5-${scene}-${algorithm}`, 'framegraph-acceptance',
    { scene, algorithm }, scene === 'rtt' ? [[1280, 720], [640, 360]] : [[1280, 720]]);
  for (const count of [512, 1024]) add('F8', `f8-stress-${count}-${algorithm}`, 'deferred-g05-room',
    { caseId: `stress-${count}`, algorithm, moving: 1, full: 0, framegraphOracle: 1 }, [[1920, 1080]]);
}
for (const count of [1000, 10000]) for (const views of [1, 4]) for (const variant of ['lod-on', 'lod-off', 'frustum-visible', 'frustum-rejected']) {
  add('F8', `f8-instances-${count}-${views}-${variant}`, 'deferred-g05-instance',
    { count, views, variant, full: 0 }, Array.from({ length: views }, () => [1280, 720]), false);
}
// These retain the existing independent pixel/geometry and lifecycle oracles.
// Instance captures also use independent CPU ID/pose/normal/pixel oracles; their
// internal quality-changing LOD comparison is never an A0/B4 speedup.
for (const [group, fixture] of [
  ['F6', 'framegraph-reuse'], ['F6', 'framegraph-cache'],
  ['F7', 'deferred-g04-suite'], ['F7', 'deferred-g04-output'],
  ['F7', 'postprocess-multiview'], ['F7', 'auxiliary-semantics'],
  ['F7', 'deferred-g04-lifecycle'], ['F7', 'deferred-g04-device'],
]) add(group, `${group.toLowerCase()}-${fixture}`, fixture, {}, [], false);

export const G09_ACCEPTANCE_CONTRACT = 'g09-f0-f8-correctness-preflight-v1';
export const G09_ACCEPTANCE_CASES = Object.freeze(rows.map(row => Object.freeze({
  ...row, parameters: Object.freeze(row.parameters), dimensions: Object.freeze(row.dimensions.map(Object.freeze)), hdrDimensions: Object.freeze(row.hdrDimensions.map(Object.freeze)),
})));
export const G09_OUTSTANDING_ACCEPTANCE = Object.freeze([
  'independent-long-batch-diagnostic-and-common-sampling-freeze',
  'F0-F5-F8-three-cohort-A0-B4-performance-with-original-budgets',
  'non-overlapping-CPU-phase-and-cold-start-attribution',
  'active-idle-pending-persistent-resource-high-water-and-bandwidth-proxies',
  'preregistered-A-B1-B2-B3-B4-ablations-in-F0-F2-F3-F4',
  'paired-cohort-uncertainty-and-at-least-one-attributed-production-benefit',
  'F6-observer-export-root-transitions-and-F7-pending-device-recovery',
  'same-candidate-G05-G07-performance-evidence-consumption',
]);

export function createG09AcceptancePlan(qualification, tier = 'full') {
  if (!['full', 'smoke'].includes(tier) || !qualification?.targets?.length) throw Error('Explicit tier and native qualification required');
  const cases = tier === 'full' ? G09_ACCEPTANCE_CASES : ['F0', 'F1', 'F3', 'F4', 'F5'].map(group =>
    G09_ACCEPTANCE_CASES.find(c => c.group === group && (group !== 'F4' || c.parameters.layout === 'mixed-viewport')));
  return qualification.targets.flatMap(target => cases.flatMap(c =>
    // Legacy structural fixtures directly exercise new graph internals; fixed
    // A0 has no such internals. Their own independent oracles are retained.
    (c.group === 'F6' || c.group === 'F7' ? ['B4'] : ['A0', 'B4']).map(variant => ({
      caseId: c.id, ...target, variant,
    }))));
}

export function compareG09Pixels(before, after, spec) {
  if (before?.length !== spec.dimensions.length || after?.length !== before.length) throw Error('Missing paired views');
  return spec.dimensions.map(([width, height], view) => {
    const a = before[view], b = after[view];
    if (!a?.key || a.key !== b?.key) throw Error('View identity changed');
    const [hdrWidth, hdrHeight] = spec.hdrDimensions?.[view] ?? [width, height];
    const row = { key: a.key, width, height, hdrWidth, hdrHeight, hdrMaxToleranceRatio: 0, ldrMaxDelta: 0, litPixels: 0, failures: 0 };
    for (const channel of ['hdr', 'ldr']) {
      const decode = image => {
        const components = (channel === 'hdr' ? hdrWidth * hdrHeight : width * height) * 4;
        if (image?.encoding !== 'float32-le-base64' || image.components !== components) throw Error('Image dimensions/encoding changed');
        const bytes = Buffer.from(image.bytes, 'base64');
        if (bytes.length !== image.components * 4 || bytes.toString('base64') !== image.bytes) throw Error('Truncated image');
        return new Float32Array(bytes.buffer, bytes.byteOffset, image.components);
      };
      const x = decode(a[channel]), y = decode(b[channel]);
      for (let i = 0; i < x.length; i++) {
        if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) throw Error('Nonfinite image');
        const delta = Math.abs(x[i] - y[i]);
        if (channel === 'hdr') {
          const ratio = delta / Math.max(.002, Math.abs(x[i]) * .002);
          row.hdrMaxToleranceRatio = Math.max(row.hdrMaxToleranceRatio, ratio);
          if (ratio > 1) row.failures++;
        } else {
          row.ldrMaxDelta = Math.max(row.ldrMaxDelta, delta);
          if (delta > 1 / 255 + 1e-7) row.failures++;
          if (i % 4 === 0 && x[i] + x[i + 1] + x[i + 2] > .01 && y[i] + y[i + 1] + y[i + 2] > .01) row.litPixels++;
        }
      }
    }
    // Retain the established room oracle's ten-percent non-black floor.
    if (row.litPixels < width * height * .1) throw Error('Empty or insufficient paired output');
    if (row.failures) throw Error(`A0/B4 pixel mismatch ${spec.id}/${a.key}: ${JSON.stringify(row)}`);
    return row;
  });
}

export function validateG09PreflightCoverage(report) {
  if (report?.schemaVersion !== 1 || report.contractId !== G09_ACCEPTANCE_CONTRACT || report.status !== 'passed' ||
      report.performanceQualified !== false || report.g09Complete !== false) throw Error('Invalid correctness-only evidence');
  const plan = createG09AcceptancePlan(report.qualification, report.tier);
  if (JSON.stringify(report.plan) !== JSON.stringify(plan) || report.entries?.length !== plan.length) throw Error('Missing/changed preflight population');
  for (const [i, job] of plan.entries()) {
    const entry = report.entries[i];
    if (JSON.stringify(entry.job) !== JSON.stringify(job) || entry.status !== 'passed' || !/^[a-f0-9]{64}$/.test(entry.raw?.sha256 ?? '')) throw Error('Failed/reordered/unbound capture');
  }
  const expectedPairs = plan.filter(j => j.variant === 'B4' && G09_ACCEPTANCE_CASES.find(c => c.id === j.caseId).pairedPixels);
  if (report.pairs?.length !== expectedPairs.length || report.pairs.some((p, i) =>
    p.caseId !== expectedPairs[i].caseId || p.browserId !== expectedPairs[i].browserId || !p.views?.length)) throw Error('Missing/reordered pixel pairs');
  return { status: 'passed', tier: report.tier, captures: plan.length, pixelPairs: expectedPairs.length, performanceQualified: false, g09Complete: false };
}
