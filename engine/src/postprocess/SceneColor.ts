/** All 3-D lighting, blending, transmission and temporal history use scene-linear HDR. */
export const SCENE_COLOR_FORMAT: GPUTextureFormat = 'rgba16float';

export function isLinearColorTarget(format: GPUTextureFormat): boolean {
  return format === 'rgba16float' || format === 'rgba32float' || format === 'rg11b10ufloat';
}
