export const GPU_FEATURE_TIMESTAMP_QUERY = 'timestamp-query' as GPUFeatureName;
export const GPU_FEATURE_INDIRECT_FIRST_INSTANCE = 'indirect-first-instance' as GPUFeatureName;
export const GPU_FEATURE_TEXTURE_COMPRESSION_BC = 'texture-compression-bc' as GPUFeatureName;
export const GPU_FEATURE_TEXTURE_COMPRESSION_ETC2 = 'texture-compression-etc2' as GPUFeatureName;
export const GPU_FEATURE_TEXTURE_COMPRESSION_ASTC = 'texture-compression-astc' as GPUFeatureName;

export const OPTIONAL_TEXTURE_COMPRESSION_FEATURES: readonly GPUFeatureName[] = [
  GPU_FEATURE_TEXTURE_COMPRESSION_BC,
  GPU_FEATURE_TEXTURE_COMPRESSION_ETC2,
  GPU_FEATURE_TEXTURE_COMPRESSION_ASTC,
];

export function hasGpuFeature(features: ReadonlySet<string> | readonly string[] | undefined | null, feature: GPUFeatureName): boolean {
  if (!features) return false;
  return typeof (features as ReadonlySet<string>).has === 'function'
    ? (features as ReadonlySet<string>).has(feature)
    : (features as readonly string[]).includes(feature);
}
