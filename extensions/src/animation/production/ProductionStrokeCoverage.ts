// The original tessellator owns curves, dashes, caps, joins, holes and triangle emission.
// This port unions its overlapping coverage polygons once before alpha compositing.
// @ts-expect-error The dependency's ESM build has no adjacent declaration mapping.
import clipping from 'polygon-clipping/dist/polygon-clipping.esm.js';
import type {Polygon} from 'polygon-clipping';
import type {AnimationStrokeCoveragePort} from '../AnimationPathTessellator.js';
const polygonClipping = clipping as typeof import('polygon-clipping');
export const productionStrokeCoverage: AnimationStrokeCoveragePort = Object.freeze({union(contours: Parameters<AnimationStrokeCoveragePort['union']>[0]) {
  const polygons: Polygon[] = contours.filter(ring => ring.length >= 3 && Math.abs(ring.reduce((sum, point, index) => {const next = ring[(index + 1) % ring.length]!;return sum + point.x * next.y - next.x * point.y;}, 0)) > 1e-12)
    .map(ring => [ring.map(point => [point.x, point.y] as [number, number])]);
  if (!polygons.length) return Object.freeze([]);
  const merged = polygonClipping.union(polygons[0]!, ...polygons.slice(1));
  return Object.freeze(merged.map(polygon => Object.freeze({rings: Object.freeze(polygon.map(ring => Object.freeze(ring.slice(0, -1).map(([x, y]) => Object.freeze({x, y})))))})));
}});
