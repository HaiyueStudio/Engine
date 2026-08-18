export function requiredItemAt<T>(values: ArrayLike<T>, index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`${label} is missing index ${index} (length ${values.length}).`);
  return value;
}

export function requiredNumberAt(values: ArrayLike<number>, index: number, label: string): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value)) {
    throw new RangeError(`${label} has no finite number at index ${index} (length ${values.length}).`);
  }
  return value;
}
