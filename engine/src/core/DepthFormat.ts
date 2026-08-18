export function resolveDepthFormat(reverseZ = false): GPUTextureFormat {
  return reverseZ ? 'depth32float' : 'depth24plus';
}
