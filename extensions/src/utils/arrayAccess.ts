/** Reads an element whose presence is an internal runtime invariant. */
export function requiredItemAt<T>(values: ArrayLike<T>, index: number, label: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`${label} is missing element ${index} (length ${values.length}).`);
  }
  return value;
}

/** Reads a number whose presence is an internal runtime invariant. */
export function requiredNumberAt(values: ArrayLike<number>, index: number, label: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new RangeError(`${label} requires a finite value at ${index} (length ${values.length}).`);
  }
  return value;
}
