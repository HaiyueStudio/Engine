import { FRAMEGRAPH_CASES, validateFrameGraphRegressionResult } from './framegraph-regression-policy.mjs';
import { classifyFrameGraphBlackFrame } from './framegraph-black-frame-policy.mjs';
import { classifyAtomicReadback } from './framegraph-readback-controls-policy.mjs';

export function parseFrameGraphPortableOptions(args) {
  if (args.length > 1 || args.some(arg => arg !== '--plan')) throw Error('Expected no options or --plan');
  return { plan: args.includes('--plan') };
}

/** B4 correctness diagnostics on the available hardware, never frozen-device qualification. */
export function createFrameGraphPortablePlan() {
  const jobs = [];
  for (const round of [0, 1]) for (const powerPreference of ['high-performance', 'low-power'])
    for (const copySource of [false, true]) for (const access of ['audited', 'native', 'native-encoding'])
      jobs.push({ name: 'framegraph-black-frame', round, powerPreference, copySource, access });
  for (const name of FRAMEGRAPH_CASES) jobs.push({ name, powerPreference: 'high-performance' });
  return jobs;
}

export function portableAdapters(result) {
  const adapters = result.adapter ? [result.adapter] : (result.cases ?? []).flatMap(row =>
    [row.baseline?.adapter, row.candidate?.adapter].filter(Boolean));
  return adapters.map(({ vendor, architecture, isFallbackAdapter }) => ({ vendor, architecture, isFallbackAdapter }));
}

export function assessFrameGraphPortableResult(result, job) {
  if (result?.status !== 'passed') throw Error(`${job.name}: ${result?.error ?? 'fixture failed'}`);
  const adapters = portableAdapters(result);
  if (!adapters.length || adapters.some(a => a.isFallbackAdapter !== false || !a.vendor || !a.architecture))
    throw Error('Native identified GPU required; a power preference does not identify a device class');
  if (result.browserEvidence?.nativeBackend !== true || result.browserDiagnostics?.unclassifiedFailureCount !== 0)
    throw Error('Missing native browser identity or browser errors');
  if (job.name !== 'framegraph-black-frame') {
    // Reuse every workload/pixel/lifecycle assertion. Complete platform-path
    // qualification belongs to the full gate, never this separate diagnostic.
    validateFrameGraphRegressionResult(result, job, 'smoke');
    return { status: 'passed' };
  }
  if (result.coverage !== 'production' || result.chain !== 'full' || result.aoScratch !== 'r8unorm' ||
      result.readback !== 'atomic' || result.access !== job.access || result.copySource !== job.copySource ||
      result.shaderSubstitutions?.length !== 0 || JSON.stringify(result.clearSentinel) !== '[1,0,1,0]')
    throw Error('Black-frame workload changed');
  const capture = classifyAtomicReadback(result);
  const image = capture.failureStage ? null : classifyFrameGraphBlackFrame(result);
  return { status: capture.status === 'passed' && image?.status === 'passed' ? 'passed' : 'failed', capture, image };
}
