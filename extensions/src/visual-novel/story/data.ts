import { array, object, text } from '../../narrative/validation';
import type { StorySource } from './types';

export class StoryDataError extends TypeError {
  constructor(readonly source: StorySource, readonly code: string, message: string) {
    super(message);
  }
}

export function at(source: StorySource, ...path: (string | number)[]): StorySource {
  return { file: source.file, path: [...source.path, ...path] };
}

export function reject(source: StorySource, code: string, message: string): never {
  throw new StoryDataError(source, code, message);
}

export function read<T>(source: StorySource, operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof StoryDataError) throw error;
    if (error instanceof TypeError || error instanceof RangeError) reject(source, 'invalid-data', error.message);
    throw error;
  }
}

export function fields(raw: unknown, source: StorySource, allowed?: readonly string[]): Record<string, unknown> {
  const record = read(source, () => object(raw, 'Value'));
  for (const key of Object.keys(record)) {
    if (allowed && !allowed.includes(key)) reject(at(source, key), 'unknown-field', `Unknown field "${key}".`);
  }
  return record;
}

export function items(raw: unknown, source: StorySource): unknown[] {
  return read(source, () => array(raw, 'Value'));
}

export function label(raw: unknown, source: StorySource): string {
  return read(source, () => text(raw, 'Value'));
}

export function stableId(raw: unknown, source: StorySource): string {
  const id = label(raw, source);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) reject(source, 'invalid-id', `Invalid stable ID "${id}".`);
  return id;
}

export function finite(raw: unknown, source: StorySource, minimum = -Infinity): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < minimum) {
    reject(source, 'invalid-number', Number.isFinite(minimum) ? `Expected a finite number >= ${minimum}.` : 'Expected a finite number.');
  }
  return raw;
}

export function relativeFile(raw: unknown, source: StorySource): string {
  const path = label(raw, source);
  if (/[:\\\x00-\x1f]/.test(path) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    reject(source, 'invalid-path', 'Expected a project-relative path with forward slashes.');
  }
  return path;
}
