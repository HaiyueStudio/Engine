import { createPathExtrusion3D } from '@haiyue/engine/geometry';

export const PATH_RINGS = 512;
export const SHAPE_EDGES = 64;

/** A ribbed cross-section swept around a closed trefoil: 512 × 64 × 2 = 65,536 triangles. */
export function createExtrudedKnot() {
  const shape = Array.from({ length: SHAPE_EDGES }, (_, index): [number, number] => {
    const angle = -index / SHAPE_EDGES * Math.PI * 2;
    const radius = 0.32 * (1 + 0.14 * Math.cos(angle * 8));
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  const path = Array.from({ length: PATH_RINGS }, (_, index) => {
    const t = index / PATH_RINGS * Math.PI * 2;
    const radius = 2 + 0.65 * Math.cos(t * 3);
    return {
      position: [radius * Math.cos(t * 2), radius * Math.sin(t * 2), 0.9 * Math.sin(t * 3)] as const,
      roll: Math.sin(t * 3) * 0.35,
    };
  });
  return createPathExtrusion3D({ path, shape, closedPath: true, closedShape: true });
}
