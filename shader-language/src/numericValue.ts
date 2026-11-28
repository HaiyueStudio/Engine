/** Shared scalar admission for IR literals and specialization values. */
export function isShaderNumericValue(type: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (type === 'f32') return Number.isFinite(Math.fround(value));
  if (type === 'i32') return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
  if (type === 'u32') return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  return false;
}
