import { summarizeG05ResourceRecords } from './deferred-g05-memory-policy.mjs';

/** Physical attachment ownership after G09 reuse; logical view coverage is checked independently. */
export function validateG05ContinuousMemory(result, config) {
  const memory = config.memory, checks = [];
  if (!memory || memory.maxViews !== 4 || memory.maxLiveTargetGenerations !== 2 || memory.driverResidentMemoryClaim !== false ||
      !Number.isSafeInteger(result.views) || result.views < 1 || result.views > memory.maxViews) throw Error('Invalid frozen memory contract or view count');
  const keys = Array.from({ length: result.views }, (_, i) => `real-frame-view:${i}`);
  for (const phase of ['warm', 'cpu', 'gpu']) {
    const snapshot = result.resourceAttribution?.[phase];
    if (snapshot?.schemaVersion !== 1 || snapshot.driverResidentMemory !== false) throw Error('Missing physical resource attribution');
    const actual = summarizeG05ResourceRecords(snapshot.records);
    for (const key of ['allocationEstimateBytes', 'deferredEstimateBytes', 'totals', 'views']) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(snapshot[key])) throw Error('Resource attribution summary mismatch');
    }
    for (const type of ['buffer', 'texture']) {
      const rows = snapshot.records.filter(r => r.type === type), totals = result.resources?.[phase]?.[type];
      if (totals?.current !== rows.length || totals.estimatedBytes !== rows.reduce((n, r) => n + r.estimatedBytes, 0)) throw Error('Resource attribution differs from tracker');
    }
    if (actual.totals['other-deferred'].count) throw Error('Unattributed Deferred allocation');
    const sets = actual.views.filter(v => v.gbufferTextures > 0), bytesPerSet = 28 * result.width * result.height;
    if (!sets.length || sets.length > result.views || actual.views.some(v => !keys.includes(v.key) || v.tileBuffers > 1) ||
        sets.some(v => v.gbufferTextures !== 4 || v.gbufferBytes !== bytesPerSet)) throw Error('Invalid physical G-buffer generation');
    // Labels identify first allocation ownership, not every later sequential borrower.
    const shared = actual.deferredEstimateBytes - actual.totals.gbuffer.bytes - actual.totals.tiles.bytes;
    for (const key of keys) {
      const observed = bytesPerSet + (actual.views.find(v => v.key === key)?.tileBytes ?? 0) + shared;
      checks.push({ phase, view: key, metric: 'conservativeViewAllocationBytes', observed,
        limit: memory.maxDeferredBytesPerViewGeneration, passed: observed <= memory.maxDeferredBytesPerViewGeneration });
    }
    checks.push({ phase, metric: 'totalDeferredAllocationBytes', observed: actual.deferredEstimateBytes,
      limit: memory.maxDeferredTargetBytesTotal, passed: actual.deferredEstimateBytes <= memory.maxDeferredTargetBytesTotal });
  }
  for (const phase of ['cpu', 'gpu']) if (result.resourceAttribution[phase].deferredEstimateBytes !== result.resourceAttribution.warm.deferredEstimateBytes) throw Error('Deferred allocation grew after warmup');
  return { status: checks.every(c => c.passed) ? 'passed' : 'failed', checks,
    scope: 'Physical steady allocations and conservative per-logical-view ceiling; separate lifecycle tests own two pending generations and AO. No driver residency claim.' };
}
