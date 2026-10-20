import { validateDeferredView, type DeferredLightSource, type DeferredLightView } from '../frame/DeferredLightTable';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import { SceneFrameUniformLayout } from '../frame/SceneFrameUniformLayout';
const inverseOffset = SceneFrameUniformLayout.fields.find(field => field.name === 'inverseViewProjection')!.offset / 4;

/** A sphere containing all four near-plane corners contains their convex hull.
 * Every tile touches that quad, so these lights cannot be removed by tile/frustum culling.
 * The full-list resolve is always exact; uncertain arithmetic simply keeps normal culling. */
export function deferredTileBypassReason(source: DeferredLightSource, view: DeferredLightView, frame: SceneFrameUniformSnapshot,
  reverseZ: boolean): 'empty-source' | 'all-lights-cover-near-plane' | null {
  validateDeferredView(view, source);
  if (!view.pointIndices.length) return 'empty-source';
  const m = frame.data, corners: number[][] = [];
  for (const y of [-1, 1]) for (const x of [-1, 1]) {
    const z = reverseZ ? 1 : 0;
    const h = [0, 1, 2, 3].map(row => m[inverseOffset + row]! * x + m[inverseOffset + 4 + row]! * y
      + m[inverseOffset + 8 + row]! * z + m[inverseOffset + 12 + row]!);
    if (!h.every(Number.isFinite) || Math.abs(h[3]!) < 1e-12) return null;
    corners.push(h.slice(0, 3).map(value => value / h[3]!));
  }
  for (const local of view.pointIndices) {
    const light = source.records[source.stats.directionalCount + local];
    if (!light || light.identity[0] !== 2) throw new Error('Invalid tile source index.');
    const p = light.positionRange, radius = Math.max(p[3], .0001);
    const conservativeRadius = radius - Math.max(1e-5, radius * 1e-5);
    if (conservativeRadius <= 0) return null;
    for (const corner of corners) {
      const distanceSquared = (corner[0]! - p[0]) ** 2 + (corner[1]! - p[1]) ** 2 + (corner[2]! - p[2]) ** 2;
      if (!Number.isFinite(distanceSquared) || distanceSquared > conservativeRadius ** 2) return null;
    }
  }
  return 'all-lights-cover-near-plane';
}
