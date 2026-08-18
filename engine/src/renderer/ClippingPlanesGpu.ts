import { MAX_CLIPPING_PLANES, type ClippingPlanes } from '../components/ClippingPlanes';

export const CLIPPING_PLANE_FLOATS = MAX_CLIPPING_PLANES * 4;
export const CLIPPING_BLOCK_FLOATS = CLIPPING_PLANE_FLOATS + 4;

/** Writes one fixed-width record in the object-slot-aligned clipping companion table. */
export function writeClippingBlock(
  target: Float32Array,
  offset: number,
  clipping: ClippingPlanes | null,
): void {
  target.fill(0, offset, offset + CLIPPING_BLOCK_FLOATS);
  if (!clipping || clipping.disabled || clipping.count === 0) return;
  target.set(clipping.packedPlanes as Float32Array, offset);
  target[offset + CLIPPING_PLANE_FLOATS] = clipping.count;
}

export function clippingStateKey(clipping: ClippingPlanes | null): string {
  return clipping && !clipping.disabled && clipping.count > 0
    ? `${clipping.id}:${clipping.revision}`
    : 'none';
}
