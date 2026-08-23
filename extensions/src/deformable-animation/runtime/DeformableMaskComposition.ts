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

export type DeformableTriangleWinding = 'ccw' | 'cw' | 'degenerate';

/**
 * CPU oracle for the source-neutral drawable winding contract. Input positions
 * are model-space Y-up. `modelToClipYFlipped` represents a real projection
 * reflection; the WebGPU viewport convention itself must not be applied twice.
 */
export function deformableWebGpuTriangleWinding(
  positions: readonly number[],
  indices: readonly number[] = [0, 1, 2],
  scale: readonly [number, number] = [1, 1],
  modelToClipYFlipped = false,
): DeformableTriangleWinding {
  if (positions.length < 6 || indices.length < 3) throw new RangeError('Triangle winding requires three indexed xy vertices.');
  const [a = -1, b = -1, c = -1] = indices;
  if (![a, b, c].every(index => Number.isInteger(index) && index >= 0 && index * 2 + 1 < positions.length)) {
    throw new RangeError('Triangle winding indices must reference existing xy vertices.');
  }
  if (![...positions, ...scale].every(Number.isFinite)) throw new RangeError('Triangle winding inputs must be finite.');
  const yDirection = modelToClipYFlipped ? -1 : 1;
  const ax = positions[a * 2]! * scale[0];
  const ay = positions[a * 2 + 1]! * scale[1] * yDirection;
  const bx = positions[b * 2]! * scale[0];
  const by = positions[b * 2 + 1]! * scale[1] * yDirection;
  const cx = positions[c * 2]! * scale[0];
  const cy = positions[c * 2 + 1]! * scale[1] * yDirection;
  const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area2) <= Number.EPSILON) return 'degenerate';
  return area2 > 0 ? 'ccw' : 'cw';
}

export function deformableTriangleSurvivesBackFaceCulling(
  winding: DeformableTriangleWinding,
  culling: boolean,
): boolean {
  if (winding === 'degenerate') return false;
  return !culling || winding === 'ccw';
}
