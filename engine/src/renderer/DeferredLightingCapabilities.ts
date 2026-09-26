import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';
import { DEFERRED_LIGHTING_ABI as ABI } from '../shaders/generated/deferred-lighting-abi.generated';

export function validateDeferredDevice(device: GPUDevice): void {
  const requirements: Partial<Record<keyof GPUSupportedLimits, number>> = {
    maxColorAttachments: 3, maxColorAttachmentBytesPerSample: 24,
    maxStorageBuffersPerShaderStage: 3, maxComputeInvocationsPerWorkgroup: 64,
    maxStorageBufferBindingSize: ABI.blocks.sourceHeader.byteSize + (ABI.maxPoints + ABI.maxDirectionals) * ABI.blocks.light.byteSize,
    maxUniformBufferBindingSize: 272,
  };
  for (const [key, value] of Object.entries(requirements)) {
    const actual = device.limits[key as keyof GPUSupportedLimits];
    if (typeof actual !== 'number' || actual < value) throw new DeferredLightingCapabilityError(`device-limit:${key}`, typeof actual === 'number' ? actual : 0, value);
  }
}

export function validateDeferredViewConfiguration(device: GPUDevice, width: number, height: number, samples: number): void {
  if (samples !== 1) throw new DeferredLightingCapabilityError('sample-count', samples, 1);
  for (const dimension of [width, height]) if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > device.limits.maxTextureDimension2D) {
    throw new DeferredLightingCapabilityError('texture-dimension', dimension, device.limits.maxTextureDimension2D);
  }
  if (28 * width * height > 64 * 1024 * 1024) throw new DeferredLightingCapabilityError('view-gbuffer-bytes', 28 * width * height, 64 * 1024 * 1024);
}
