import { mat4n, vec3n } from 'wgpu-matrix';
import type { RayMatrix4, RayVec3 } from '../reference/index.js';
import type { RayBounds3 } from './types.js';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function vec3(x: number, y: number, z: number): RayVec3 {
  return Object.freeze([zero(x), zero(y), zero(z)]);
}

export function bounds(min: RayVec3, max: RayVec3): RayBounds3 {
  return Object.freeze({ min, max });
}

export function emptyBounds(): RayBounds3 {
  return bounds(vec3(Infinity, Infinity, Infinity), vec3(-Infinity, -Infinity, -Infinity));
}

export function isEmptyBounds(value: RayBounds3): boolean {
  return value.min[0] > value.max[0] || value.min[1] > value.max[1] || value.min[2] > value.max[2];
}

export function unionBounds(a: RayBounds3, b: RayBounds3): RayBounds3 {
  if (isEmptyBounds(a)) return b;
  if (isEmptyBounds(b)) return a;
  return bounds(
    vec3(Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])),
    vec3(Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])),
  );
}

export function boundsFromPoints(points: readonly RayVec3[]): RayBounds3 {
  let value = emptyBounds();
  for (const point of points) value = unionBounds(value, bounds(point, point));
  return value;
}

export function boundsCentroid(value: RayBounds3): RayVec3 {
  return vec3(
    value.min[0] * 0.5 + value.max[0] * 0.5,
    value.min[1] * 0.5 + value.max[1] * 0.5,
    value.min[2] * 0.5 + value.max[2] * 0.5,
  );
}

export function transformBounds(value: RayBounds3, matrix: RayMatrix4): RayBounds3 {
  let result = emptyBounds();
  for (let mask = 0; mask < 8; mask++) {
    const point = vec3(
      mask & 1 ? value.max[0] : value.min[0],
      mask & 2 ? value.max[1] : value.min[1],
      mask & 4 ? value.max[2] : value.min[2],
    );
    const transformed = transformPoint(matrix, point);
    result = unionBounds(result, bounds(transformed, transformed));
  }
  return result;
}

export function transformPoint(matrix: ArrayLike<number>, point: RayVec3): RayVec3 {
  const transformed = vec3n.transformMat4(point, matrix);
  return vec3(transformed[0]!, transformed[1]!, transformed[2]!);
}

export function inverseMatrix4(matrix: RayMatrix4): RayMatrix4 | null {
  if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) return null;
  const determinant = mat4n.determinant(matrix);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON) return null;
  const output = mat4n.inverse(matrix);
  return output.every(Number.isFinite) ? Object.freeze(output) : null;
}

export function outwardF32Min(value: number): number {
  const rounded = Math.fround(value);
  return rounded > value ? nextF32(rounded, -1) : rounded;
}

export function outwardF32Max(value: number): number {
  const rounded = Math.fround(value);
  return rounded < value ? nextF32(rounded, 1) : rounded;
}

export function outwardF32Bounds(value: RayBounds3): RayBounds3 {
  return bounds(
    vec3(outwardF32Min(value.min[0]), outwardF32Min(value.min[1]), outwardF32Min(value.min[2])),
    vec3(outwardF32Max(value.max[0]), outwardF32Max(value.max[1]), outwardF32Max(value.max[2])),
  );
}

export function fingerprintText(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function numberToken(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function nextF32(value: number, direction: -1 | 1): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return direction < 0 ? -1.401298464324817e-45 : 1.401298464324817e-45;
  f32[0] = value;
  const bits = u32[0]!;
  u32[0] = value > 0 === direction > 0 ? bits + 1 : bits - 1;
  return f32[0]!;
}

function zero(value: number): number { return Object.is(value, -0) ? 0 : value; }
