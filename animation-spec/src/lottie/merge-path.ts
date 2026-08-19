// Lottie Merge Paths lowering uses polygon-clipping at conversion time only.
// polygon-clipping publishes root declarations, but its ESM bundle subpath has
// no adjacent .d.ts. Importing the ESM file avoids selecting the browser UMD
// build while the public root types below keep the call surface checked.
// @ts-expect-error The package does not map declarations for its ESM subpath.
import polygonClippingRuntime from 'polygon-clipping/dist/polygon-clipping.esm.js';
import type { MultiPolygon, Pair, Polygon } from 'polygon-clipping';

const polygonClipping = polygonClippingRuntime as typeof import('polygon-clipping');

export interface StaticVectorPath {
  readonly commands: string;
  readonly values: readonly number[] | Float32Array;
}

export type Matrix2D = readonly [number, number, number, number, number, number];

/** Performs Lottie Merge/Add/Subtract/Intersect/Exclude on static path operands. */
export function mergeStaticVectorPaths(
  operands: readonly (readonly StaticVectorPath[])[],
  mode: number,
): StaticVectorPath | null {
  const paths = operands.flat();
  if (mode === 1) {
    return paths.length === 0 ? null : {
      commands: paths.map(path => path.commands).join(''),
      values: paths.flatMap(path => Array.from(path.values)),
    };
  }
  const geometries = operands.map(pathsToMultiPolygon).filter(geometry => geometry.length > 0);
  if (geometries.length === 0) return null;
  const [first, ...rest] = geometries;
  const merged = mode === 2
    ? polygonClipping.union(first!, ...rest)
    : mode === 3
      ? polygonClipping.difference(first!, ...rest)
      : mode === 4
        ? polygonClipping.intersection(first!, ...rest)
        : polygonClipping.xor(first!, ...rest);
  return multiPolygonToPath(merged);
}

export function identityMatrix(): Matrix2D {
  return [1, 0, 0, 1, 0, 0];
}

export function translationMatrix(x: number, y: number): Matrix2D {
  return [1, 0, 0, 1, x, y];
}

export function transformMatrix(position: number[], anchor: number[], scale: number[], rotation: number): Matrix2D {
  const scaleX = (scale[0] ?? 100) / 100;
  const scaleY = (scale[1] ?? 100) / 100;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const a = cosine * scaleX;
  const b = sine * scaleX;
  const c = -sine * scaleY;
  const d = cosine * scaleY;
  const anchorX = anchor[0] ?? 0;
  const anchorY = anchor[1] ?? 0;
  return [
    a, b, c, d,
    (position[0] ?? 0) - a * anchorX - c * anchorY,
    (position[1] ?? 0) - b * anchorX - d * anchorY,
  ];
}

export function transformStaticPath(path: StaticVectorPath, matrix: Matrix2D): StaticVectorPath {
  const [a, b, c, d, e, f] = matrix;
  const values: number[] = [];
  for (let index = 0; index < path.values.length; index += 2) {
    const x = path.values[index] ?? 0;
    const y = path.values[index + 1] ?? 0;
    values.push(a * x + c * y + e, b * x + d * y + f);
  }
  return { commands: path.commands, values };
}

function pathsToMultiPolygon(paths: readonly StaticVectorPath[]): MultiPolygon {
  const polygons: Polygon[] = paths.flatMap(path => flattenStaticPath(path).map(ring => [ring]));
  if (polygons.length <= 1) return polygons;
  return polygonClipping.union(polygons[0]!, ...polygons.slice(1));
}

function flattenStaticPath(path: StaticVectorPath, tolerance = 0.35): Pair[][] {
  const rings: Pair[][] = [];
  let valuesIndex = 0;
  let ring: Pair[] = [];
  let current: Pair = [0, 0];
  const nextPair = (): Pair => [Number(path.values[valuesIndex++] ?? 0), Number(path.values[valuesIndex++] ?? 0)];
  const finish = (): void => {
    if (ring.length < 3) { ring = []; return; }
    if (!samePair(ring[0]!, ring.at(-1)!)) ring.push([...ring[0]!] as Pair);
    if (Math.abs(signedRingArea(ring)) > 1e-8) rings.push(ring);
    ring = [];
  };
  for (const command of path.commands) {
    if (command === 'M') {
      finish();
      current = nextPair();
      ring.push(current);
    } else if (command === 'L') {
      current = nextPair();
      ring.push(current);
    } else if (command === 'C') {
      const control1 = nextPair();
      const control2 = nextPair();
      const end = nextPair();
      flattenCubic(current, control1, control2, end, tolerance, ring);
      current = end;
    } else if (command === 'Q') {
      const control = nextPair();
      const end = nextPair();
      flattenQuadratic(current, control, end, tolerance, ring);
      current = end;
    } else if (command === 'Z') {
      finish();
    }
  }
  finish();
  return rings;
}

function flattenCubic(
  start: Pair,
  control1: Pair,
  control2: Pair,
  end: Pair,
  tolerance: number,
  output: Pair[],
  depth = 0,
): void {
  if (depth >= 10 || Math.max(pointLineDistance(control1, start, end), pointLineDistance(control2, start, end)) <= tolerance) {
    output.push(end);
    return;
  }
  const a = midpoint(start, control1);
  const b = midpoint(control1, control2);
  const c = midpoint(control2, end);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const middle = midpoint(d, e);
  flattenCubic(start, a, d, middle, tolerance, output, depth + 1);
  flattenCubic(middle, e, c, end, tolerance, output, depth + 1);
}

function flattenQuadratic(
  start: Pair,
  control: Pair,
  end: Pair,
  tolerance: number,
  output: Pair[],
  depth = 0,
): void {
  if (depth >= 10 || pointLineDistance(control, start, end) <= tolerance) {
    output.push(end);
    return;
  }
  const a = midpoint(start, control);
  const b = midpoint(control, end);
  const middle = midpoint(a, b);
  flattenQuadratic(start, a, middle, tolerance, output, depth + 1);
  flattenQuadratic(middle, b, end, tolerance, output, depth + 1);
}

function pointLineDistance(point: Pair, start: Pair, end: Pair): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-12) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / length;
}

function midpoint(a: Pair, b: Pair): Pair {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function signedRingArea(ring: readonly Pair[]): number {
  let area = 0;
  for (let index = 0; index + 1 < ring.length; index++) {
    area += ring[index]![0] * ring[index + 1]![1] - ring[index + 1]![0] * ring[index]![1];
  }
  return area / 2;
}

function multiPolygonToPath(geometry: MultiPolygon): StaticVectorPath | null {
  let commands = '';
  const values: number[] = [];
  for (const polygon of geometry) {
    for (const sourceRing of polygon) {
      const ring = sourceRing.length > 1 && samePair(sourceRing[0]!, sourceRing.at(-1)!)
        ? sourceRing.slice(0, -1)
        : sourceRing;
      if (ring.length < 3) continue;
      commands += `M${'L'.repeat(ring.length - 1)}Z`;
      values.push(...ring.flat());
    }
  }
  return commands ? { commands, values } : null;
}

function samePair(a: Pair, b: Pair): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}
