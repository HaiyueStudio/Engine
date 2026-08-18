/**
 * Reads an element whose presence is part of the caller's data contract.
 *
 * Keeping the bounds check here makes fixed-width vector/matrix access explicit
 * without scattering non-null assertions throughout numerical code.
 */
export function requiredNumberAt(
  values: ArrayLike<number>,
  index: number,
  label = 'numeric array',
): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`${label} is missing required element ${index} (length ${values.length}).`);
  }
  return value;
}

/** Reads an object element whose presence is guaranteed by a validated range. */
export function requiredItemAt<T>(
  values: ArrayLike<T>,
  index: number,
  label = 'array',
): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`${label} is missing required element ${index} (length ${values.length}).`);
  }
  return value;
}

export type RequiredVec3Array = Float32Array & {
  0: number;
  1: number;
  2: number;
};

export type RequiredMat4Array = Float32Array & {
  0: number; 1: number; 2: number; 3: number;
  4: number; 5: number; 6: number; 7: number;
  8: number; 9: number; 10: number; 11: number;
  12: number; 13: number; 14: number; 15: number;
};

/** Narrows a runtime-validated Float32Array to its required vec3 elements. */
export function requiredVec3Array(values: Float32Array, label = 'vec3'): RequiredVec3Array {
  if (values.length < 3) {
    throw new RangeError(`${label} requires at least 3 elements (length ${values.length}).`);
  }
  return values as RequiredVec3Array;
}

/** Narrows a runtime-validated Float32Array to its required 4x4 matrix elements. */
export function requiredMat4Array(values: Float32Array, label = 'mat4'): RequiredMat4Array {
  if (values.length < 16) {
    throw new RangeError(`${label} requires at least 16 elements (length ${values.length}).`);
  }
  return values as RequiredMat4Array;
}
