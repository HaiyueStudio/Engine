// Paint identity is private. Logical sequences and UTF-16 editing offsets never change.
const sequences = new WeakMap<object, string>();
export function rememberTextPaintSequence<T extends object>(value: T, sequence: string | undefined): T {
  if (sequence !== undefined) sequences.set(value, sequence);
  return value;
}
export function textPaintSequence(value: object): string | undefined { return sequences.get(value); }
