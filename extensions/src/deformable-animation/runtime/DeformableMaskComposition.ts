/**
 * CPU oracle for Cubism clipping coverage. The official setup-mask buffer
 * stores remaining coverage; HaiYue stores its complement directly.
 */
export function cubismMaskCoverage(textureAlphas: readonly number[], inverted = false): number {
  let remaining = 1;
  for (const alpha of textureAlphas) {
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) throw new RangeError('Mask texture alpha must be finite and inside [0, 1].');
    remaining *= 1 - alpha;
  }
  const union = 1 - remaining;
  return inverted ? 1 - union : union;
}
