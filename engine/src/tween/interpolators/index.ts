import { ColorSRGB } from '../../color/ColorSRGB';
import { requiredNumberAt } from '../../math/arrayAccess';

export type InterpolatorFn<T = unknown> = (from: T, to: T, t: number, out?: T) => T;

function isFloat32Array(v: unknown): v is Float32Array {
  return v instanceof Float32Array;
}

function isColorSRGB(v: unknown): v is ColorSRGB {
  return v instanceof ColorSRGB;
}

/** Linear interpolate two numbers */
export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Component-wise lerp for Float32Array (vec2, vec3, vec4, mat4, etc.) */
export function lerpFloat32Array(
  a: Float32Array,
  b: Float32Array,
  t: number,
  out?: Float32Array<ArrayBufferLike>,
): Float32Array<ArrayBufferLike> {
  if (a.length !== b.length) {
    throw new RangeError(`Cannot interpolate Float32Arrays with different lengths (${a.length} and ${b.length}).`);
  }
  if (out && out.length !== a.length) {
    throw new RangeError(`Float32Array interpolation output length ${out.length} must match input length ${a.length}.`);
  }
  const target = out ?? new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const from = requiredNumberAt(a, i, 'tween interpolation source');
    target[i] = from + (requiredNumberAt(b, i, 'tween interpolation target') - from) * t;
  }
  return target;
}

/** Lerp between two sRGB colors */
export function lerpColorSRGB(a: ColorSRGB, b: ColorSRGB, t: number, out = new ColorSRGB()): ColorSRGB {
  return out.set(
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
    a.a + (b.a - a.a) * t,
  );
}

/** Automatically select interpolator based on value type. */
export function interpolate(from: unknown, to: unknown, t: number, out?: unknown): unknown {
  if (typeof from === 'number' && typeof to === 'number') {
    return lerpNumber(from, to, t);
  }
  if (isFloat32Array(from) && isFloat32Array(to)) {
    return lerpFloat32Array(from, to, t, isFloat32Array(out) && out.length === from.length ? out : undefined);
  }
  if (isColorSRGB(from) && isColorSRGB(to)) {
    return lerpColorSRGB(from, to, t, isColorSRGB(out) ? out : undefined);
  }
  // Fallback: snap to end value
  return t < 1 ? from : to;
}

/** Registry for custom interpolators keyed by a type tag string. */
export const interpolatorRegistry = new Map<string, InterpolatorFn>([
  ['number', lerpNumber as unknown as InterpolatorFn],
  ['float32array', lerpFloat32Array as unknown as InterpolatorFn],
  ['colorsrgb', lerpColorSRGB as unknown as InterpolatorFn],
]);
