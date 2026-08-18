import { ColorHSL } from './ColorHSL';
import { ColorLinear } from './ColorLinear';
import { ColorSRGB } from './ColorSRGB';
import type { ColorValue } from './Color';

export type ColorTuple = readonly [r: number, g: number, b: number, a?: number];

/** Structural sRGB input, compatible with WebGPU-style channel objects. */
export interface ColorChannels {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a?: number;
}

/** Compatibility protocol for external color models that only expose conversion. */
export interface ColorConvertible {
  toSRGB(): ColorChannels;
}

export type ColorObject = ColorSRGB | ColorLinear | ColorHSL;
/** Tuples and structural channel objects are interpreted as display-encoded sRGB. */
export type ColorLike = ColorValue | ColorConvertible | ColorTuple | ColorChannels;

/** Preserve mutable color semantics by cloning ColorValue inputs without changing their model. */
export function resolveColor(
  value: ColorLike | undefined,
  fallback: ColorLike = [1, 1, 1, 1],
): ColorValue {
  const resolved = value ?? fallback;
  if (isColorValue(resolved)) return resolved.clone();
  if (isColorConvertible(resolved)) {
    const color = resolved.toSRGB();
    return new ColorSRGB(color.r, color.g, color.b, color.a ?? 1);
  }
  if (Array.isArray(resolved)) {
    return new ColorSRGB(resolved[0], resolved[1], resolved[2], resolved[3] ?? 1);
  }
  const channels = resolved as ColorChannels;
  return new ColorSRGB(channels.r, channels.g, channels.b, channels.a ?? 1);
}

/** Explicit one-off conversion. Prefer resolveColor when storing a user-provided color. */
export function toColorSRGB(
  value: ColorLike | undefined,
  fallback: ColorLike = [1, 1, 1, 1],
): ColorSRGB {
  const resolved = value ?? fallback;
  if (resolved instanceof ColorSRGB) return resolved.clone();
  if (resolved instanceof ColorLinear || resolved instanceof ColorHSL) return resolved.toSRGB();
  const data = new Float32Array(4);
  writeColorSRGB(resolved, data);
  return new ColorSRGB(data[0]!, data[1]!, data[2]!, data[3]!);
}

export function writeColorSRGB(
  value: ColorLike,
  out: Float32Array,
  offset = 0,
): Float32Array {
  if (isColorValue(value)) return value.writeSRGB(out, offset);
  if (isColorConvertible(value)) {
    const color = value.toSRGB();
    out[offset] = color.r;
    out[offset + 1] = color.g;
    out[offset + 2] = color.b;
    out[offset + 3] = color.a ?? 1;
    return out;
  }
  if (Array.isArray(value)) {
    out[offset] = value[0];
    out[offset + 1] = value[1];
    out[offset + 2] = value[2];
    out[offset + 3] = value[3] ?? 1;
    return out;
  }
  const channels = value as ColorChannels;
  out[offset] = channels.r;
  out[offset + 1] = channels.g;
  out[offset + 2] = channels.b;
  out[offset + 3] = channels.a ?? 1;
  return out;
}

/** Write linear RGB values for lighting/PBR uniforms; alpha is never transfer-encoded. */
export function writeColorLinear(
  value: ColorLike,
  out: Float32Array,
  offset = 0,
): Float32Array {
  if (isColorValue(value)) return value.writeLinear(out, offset);
  const scratch = new Float32Array(4);
  writeColorSRGB(value, scratch);
  out[offset] = ColorSRGB.srgbToLinear(scratch[0]!);
  out[offset + 1] = ColorSRGB.srgbToLinear(scratch[1]!);
  out[offset + 2] = ColorSRGB.srgbToLinear(scratch[2]!);
  out[offset + 3] = scratch[3]!;
  return out;
}

export function isColorValue(value: unknown): value is ColorValue {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ColorValue>;
  return typeof candidate.colorSpace === 'string'
    && typeof candidate.version === 'number'
    && typeof candidate.clone === 'function'
    && typeof candidate.setFromSRGB === 'function'
    && typeof candidate.setFromLinear === 'function'
    && typeof candidate.writeSRGB === 'function'
    && typeof candidate.writeLinear === 'function';
}

function isColorConvertible(value: ColorLike): value is ColorConvertible {
  return typeof (value as Partial<ColorConvertible>).toSRGB === 'function';
}
