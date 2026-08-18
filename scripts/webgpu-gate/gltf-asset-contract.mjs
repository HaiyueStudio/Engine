export const GLTF_ASSET_BASELINE_SCHEMA_VERSION = 1;
export const GLTF_ASSET_BASELINE_SUITE = 'haiyue-real-gltf-first-visible-frame';

export function validateGltfAssetBaselineResult(result, options = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!result || typeof result !== 'object') return ['result must be an object'];
  if (result.schemaVersion !== GLTF_ASSET_BASELINE_SCHEMA_VERSION) fail(`schemaVersion must be ${GLTF_ASSET_BASELINE_SCHEMA_VERSION}`);
  if (result.suite !== GLTF_ASSET_BASELINE_SUITE) fail(`suite must be ${GLTF_ASSET_BASELINE_SUITE}`);
  if (!result.environment?.adapter || !Object.values(result.environment.adapter).some(Boolean)) fail('adapter identity is missing');
  if (result.asset?.fixtureVersion !== 1) fail('asset.fixtureVersion must be 1');
  if (result.asset?.primitiveCount !== 1 || result.asset?.textureCount !== 2) fail('representative asset shape changed');
  if (result.asset?.animationCount !== 1) fail('representative animation did not load');
  const uv = result.contract?.uvSemantics?.[0];
  if (uv?.capacity !== 2) fail('UV physical channel capacity must be 2');
  if (JSON.stringify(uv?.referencedSemantics) !== JSON.stringify(['TEXCOORD_2', 'TEXCOORD_5'])) fail('dynamic UV references changed');
  if (JSON.stringify(uv?.mappings) !== JSON.stringify([
    { semantic: 'TEXCOORD_2', set: 2, channel: 0 },
    { semantic: 'TEXCOORD_5', set: 5, channel: 1 },
  ])) fail('dynamic UV physical mapping changed');
  const clearcoatExtension = result.contract?.extensions?.find(entry => entry.extension === 'KHR_materials_clearcoat');
  if (JSON.stringify(clearcoatExtension) !== JSON.stringify({
    extension: 'KHR_materials_clearcoat',
    required: true,
    support: 'supported',
    disposition: 'supported',
  })) fail('required KHR_materials_clearcoat capability report changed');
  if (JSON.stringify(result.contract?.clearcoat) !== JSON.stringify([{
    factor: 0.9,
    roughnessFactor: 0.22,
    normalScale: 0.8,
  }])) fail('clearcoat material contract changed');

  for (const [name, value] of Object.entries(result.timings ?? {})) {
    if (!Number.isFinite(value) || value < 0) fail(`timings.${name} must be finite and non-negative`);
  }
  if (!(result.timings?.firstVisibleFrameMs > 0)) fail('firstVisibleFrameMs must be positive');
  const budgets = options.budgets ?? {};
  const firstVisibleFrameMaxMs = budgets.firstVisibleFrameMaxMs ?? 5_000;
  if (result.timings?.firstVisibleFrameMs > firstVisibleFrameMaxMs) fail(`firstVisibleFrameMs exceeds ${firstVisibleFrameMaxMs}ms: ${result.timings.firstVisibleFrameMs}`);
  if (!(result.resources?.peakGpuEstimatedBytes > 0)) fail('peakGpuEstimatedBytes must be positive');
  if (!(result.resources?.peakGpuBufferBytes > 0)) fail('peakGpuBufferBytes must be positive');
  if (!(result.resources?.peakGpuTextureBytes > 0)) fail('peakGpuTextureBytes must be positive');
  if (!(result.resources?.peakCpuStagingBytes >= 0)) fail('peakCpuStagingBytes must be finite and non-negative');
  if (!(result.resources?.assetTransferBytes > 0)) fail('assetTransferBytes must be positive');
  if (!(result.resources?.gpuUploadBytes > 0)) fail('gpuUploadBytes must be positive');
  if (Number.isFinite(budgets.peakGpuEstimatedBytesMax) && result.resources?.peakGpuEstimatedBytes > budgets.peakGpuEstimatedBytesMax) fail('peakGpuEstimatedBytes exceeds its baseline budget');
  if (Number.isFinite(budgets.peakCpuStagingBytesMax) && result.resources?.peakCpuStagingBytes > budgets.peakCpuStagingBytesMax) fail('peakCpuStagingBytes exceeds its baseline budget');
  if (result.resources?.liveGpuResourcesAfterDestroy !== 0) fail('liveGpuResourcesAfterDestroy must be 0');
  if (result.resources?.liveGpuBytesAfterDestroy !== 0) fail('liveGpuBytesAfterDestroy must be 0');
  if (result.resources?.releasedOwnerResiduals !== 0) fail('releasedOwnerResiduals must be 0');
  if (!Array.isArray(result.validation?.errors) || result.validation.errors.length > 0) fail(`WebGPU validation errors: ${(result.validation?.errors ?? []).join('; ')}`);
  if (!Array.isArray(result.validation?.uncapturedErrors) || result.validation.uncapturedErrors.length > 0) fail(`uncaptured WebGPU errors: ${(result.validation?.uncapturedErrors ?? []).join('; ')}`);
  if (result.validation?.deviceLost !== false) fail('GPU device was lost during the asset baseline');
  if (result.validation?.visiblePixel !== true) fail('rendered output remained at the clear value');
  if (result.lifecycle?.cancelledLoadRejected !== true) fail('AbortSignal cancellation scenario did not reject');
  if (result.lifecycle?.recoveryFailures !== 0) fail('asset device recovery reported failures');
  return errors;
}
