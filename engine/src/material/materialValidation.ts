import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';

const COLOR_SCRATCH = new Float32Array(4);
const COLOR_COMPARE_SCRATCH = new Float32Array(4);

export function materialColor(value: ColorLike, property: string): ColorValue {
  const color = resolveColor(value);
  color.writeLinear(COLOR_SCRATCH);
  for (let channel = 0; channel < 4; channel++) {
    if (!Number.isFinite(COLOR_SCRATCH[channel])) {
      throw new RangeError(`${property} must resolve to finite RGBA channels.`);
    }
  }
  return color;
}

export function sameMaterialColor(a: ColorValue, b: ColorValue): boolean {
  if (a.colorSpace !== b.colorSpace) return false;
  a.writeLinear(COLOR_SCRATCH);
  b.writeLinear(COLOR_COMPARE_SCRATCH);
  return COLOR_SCRATCH[0] === COLOR_COMPARE_SCRATCH[0]
    && COLOR_SCRATCH[1] === COLOR_COMPARE_SCRATCH[1]
    && COLOR_SCRATCH[2] === COLOR_COMPARE_SCRATCH[2]
    && COLOR_SCRATCH[3] === COLOR_COMPARE_SCRATCH[3];
}

export function finiteNumber(value: number, property: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${property} must be finite; received ${value}.`);
  return value;
}

export function clampedNumber(value: number, min: number, max: number, property: string): number {
  return Math.min(max, Math.max(min, finiteNumber(value, property)));
}

export function nonNegativeNumber(value: number, property: string): number {
  return Math.max(0, finiteNumber(value, property));
}

export function positiveNumber(value: number, property: string): number {
  const resolved = finiteNumber(value, property);
  if (resolved <= 0) throw new RangeError(`${property} must be greater than 0; received ${value}.`);
  return resolved;
}

export function integerInRange(value: number, min: number, max: number, property: string): number {
  const resolved = finiteNumber(value, property);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`${property} must be an integer in [${min}, ${max}]; received ${value}.`);
  }
  return resolved;
}

export function enumValue<T extends string>(value: T, allowed: readonly T[], property: string): T {
  if (!allowed.includes(value)) {
    throw new RangeError(`${property} must be one of ${allowed.join(', ')}; received ${String(value)}.`);
  }
  return value;
}

export function booleanValue(value: boolean, property: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${property} must be a boolean; received ${String(value)}.`);
  return value;
}

export function finiteVec3(
  value: readonly [number, number, number],
  property: string,
  minimum = -Infinity,
): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RangeError(`${property} must contain exactly 3 numbers.`);
  }
  const result = value.map((channel, index) => {
    const resolved = finiteNumber(channel, `${property}[${index}]`);
    return Math.max(minimum, resolved);
  }) as [number, number, number];
  return Object.freeze(result);
}

export function sameVec3(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function samplerDescriptor(
  value: GPUSamplerDescriptor | null,
  property: string,
): GPUSamplerDescriptor | null {
  if (value === null) return null;
  if (typeof value !== 'object') throw new TypeError(`${property} must be a sampler descriptor or null.`);
  const result = { ...value };
  for (const key of ['addressModeU', 'addressModeV', 'addressModeW'] as const) {
    if (result[key] !== undefined) {
      result[key] = enumValue(result[key], ['clamp-to-edge', 'repeat', 'mirror-repeat'], `${property}.${key}`);
    }
  }
  for (const key of ['magFilter', 'minFilter', 'mipmapFilter'] as const) {
    if (result[key] !== undefined) result[key] = enumValue(result[key], ['nearest', 'linear'], `${property}.${key}`);
  }
  if (result.compare !== undefined) {
    result.compare = enumValue(
      result.compare,
      ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'],
      `${property}.compare`,
    );
  }
  if (result.lodMinClamp !== undefined) result.lodMinClamp = nonNegativeNumber(result.lodMinClamp, `${property}.lodMinClamp`);
  if (result.lodMaxClamp !== undefined) result.lodMaxClamp = nonNegativeNumber(result.lodMaxClamp, `${property}.lodMaxClamp`);
  const minLod = result.lodMinClamp ?? 0;
  const maxLod = result.lodMaxClamp ?? 32;
  if (maxLod < minLod) throw new RangeError(`${property}.lodMaxClamp must be greater than or equal to lodMinClamp.`);
  if (result.maxAnisotropy !== undefined) {
    result.maxAnisotropy = integerInRange(result.maxAnisotropy, 1, 16, `${property}.maxAnisotropy`);
  }
  return Object.freeze(result);
}

export function sameSamplerDescriptor(a: GPUSamplerDescriptor | null, b: GPUSamplerDescriptor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aRecord = a as unknown as Record<string, unknown>;
  const bRecord = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
  for (const key of keys) if (aRecord[key] !== bRecord[key]) return false;
  return true;
}
