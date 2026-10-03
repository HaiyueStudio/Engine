export function validateReadbackDeviceLoss(result, preference) {
  if (result?.schemaVersion !== 1 || result.status !== 'passed' || result.scope !== 'readback-device-loss-lifecycle' ||
      result.performanceQualified !== false || result.cases?.length !== 3) throw Error('Incomplete readback device-loss evidence');
  const modes = ['reserved', 'mapping', 'disposed-reservation'];
  for (const [i, value] of result.cases.entries()) {
    const cancelled = i === 2;
    if (value.mode !== modes[i] || value.status !== (cancelled ? 'cancelled' : 'failed') || value.bytes !== null ||
        value.stats?.pending !== 0 || value.stats.completed !== 0 || value.stats.failed !== (cancelled ? 0 : 1) ||
        value.stats.cancelled !== (cancelled ? 1 : 0) || value.errors?.length !== 0)
      throw Error(`Invalid readback loss lifecycle: ${modes[i]}`);
    if (value.adapter?.isFallbackAdapter !== false || value.adapter.vendor !== (preference === 'low-power' ? 'intel' : 'amd') ||
        value.adapter.architecture !== (preference === 'low-power' ? 'gen-9' : 'rdna-1')) throw Error('Unexpected native adapter');
  }
}
