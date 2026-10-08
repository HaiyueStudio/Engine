import { validateFrameGraphAdapter, validateFrameGraphAdapterConsistency } from './framegraph-qualification-policy.mjs';
export function validateReadbackDeviceLoss(result, qualification) {
  if (result?.schemaVersion !== 1 || result.status !== 'passed' || result.scope !== 'readback-device-loss-lifecycle' ||
      result.performanceQualified !== false || result.cases?.length !== 3) throw Error('Incomplete readback device-loss evidence');
  const modes = ['reserved', 'mapping', 'disposed-reservation'];
  for (const [i, value] of result.cases.entries()) {
    const cancelled = i === 2;
    if (value.mode !== modes[i] || value.status !== (cancelled ? 'cancelled' : 'failed') || value.bytes !== null ||
        value.stats?.pending !== 0 || value.stats.completed !== 0 || value.stats.failed !== (cancelled ? 0 : 1) ||
        value.stats.cancelled !== (cancelled ? 1 : 0) || value.errors?.length !== 0)
      throw Error(`Invalid readback loss lifecycle: ${modes[i]}`);
    validateFrameGraphAdapter(value.adapter, qualification);
  }
  validateFrameGraphAdapterConsistency(result.cases.map(row => row.adapter));
}
