/** Capacity admission uses actual limits, not a device-name or browser guess. */
export interface GpuSimulationRequirements {
  readonly stateBytes: number;
  readonly instanceCount: number;
  readonly workgroupSize?: number;
  readonly storageBindings?: number;
}
export function inspectGpuSimulationCapabilities(device: GPUDevice, requirements: GpuSimulationRequirements) {
  const { stateBytes, instanceCount, workgroupSize = 64, storageBindings = 4 } = requirements;
  if (![stateBytes, instanceCount, workgroupSize, storageBindings].every(n => Number.isSafeInteger(n) && n > 0)) throw new RangeError('Simulation requirements must be positive safe integers.');
  const limits = device.limits;
  const checks = [
    ['state-buffer', stateBytes, Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)],
    ['workgroup-size', workgroupSize, Math.min(limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX)],
    ['dispatch-x', Math.ceil(instanceCount / workgroupSize), limits.maxComputeWorkgroupsPerDimension],
    ['storage-bindings', storageBindings, limits.maxStorageBuffersPerShaderStage],
  ] as const;
  return Object.freeze({
    supported: checks.every(([, requested, available]) => requested <= available),
    checks: Object.freeze(checks.map(([name, requested, available]) => Object.freeze({ name, requested, available, supported: requested <= available }))),
    timestampQuery: device.features.has('timestamp-query'),
    indirectFirstInstance: device.features.has('indirect-first-instance'),
  });
}
