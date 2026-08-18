export const RENDERER_DEPTH_QUANTIZATION_SCALE = 16;
export const TRANSPARENT_DEPTH_KEY_MAX = 0x7fff;
export const OPAQUE_DEPTH_KEY_MAX = 0xffff;

/** Quantizes camera-space depth for every CPU/GPU renderer sorting path. */
export function quantizeRendererDepth(viewDepth: number, maxKey: number): number {
  if (!Number.isFinite(viewDepth)) return viewDepth === Number.POSITIVE_INFINITY ? maxKey : 0;
  return Math.max(0, Math.min(maxKey, Math.round(viewDepth * RENDERER_DEPTH_QUANTIZATION_SCALE)));
}

export function quantizeTransparentDepth(viewDepth: number): number {
  return quantizeRendererDepth(viewDepth, TRANSPARENT_DEPTH_KEY_MAX);
}

export function quantizeTransparentDepthBackToFront(viewDepth: number): number {
  return TRANSPARENT_DEPTH_KEY_MAX - quantizeTransparentDepth(viewDepth);
}

export function compareTransparentDepthBackToFront(a: number, b: number): number {
  return quantizeTransparentDepth(b) - quantizeTransparentDepth(a);
}

export function quantizeOpaqueDepthFrontToBack(viewDepth: number): number {
  return quantizeRendererDepth(viewDepth, OPAQUE_DEPTH_KEY_MAX);
}

export function quantizeOpaqueDepthBackToFront(viewDepth: number): number {
  return OPAQUE_DEPTH_KEY_MAX - quantizeOpaqueDepthFrontToBack(viewDepth);
}
