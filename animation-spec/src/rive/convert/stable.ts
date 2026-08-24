import { conversionFail } from './diagnostics.js';
const ENCODER = new TextEncoder();
export function stableStringify(value: unknown): string { return JSON.stringify(canonicalJson(value, '$')); }
export function stableJsonBytes(value: unknown): Uint8Array { return ENCODER.encode(`${stableStringify(value)}\n`); }
export function canonicalJson(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Expected a finite number.', path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Uint8Array || value instanceof Uint32Array || value instanceof Float32Array) return Array.from(value, item => canonicalJson(item, path));
  if (Array.isArray(value)) return value.map((item, index) => canonicalJson(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') conversionFail('E_RIVE_CONVERT_FORMAT', 'Value is not canonical JSON.', path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) conversionFail('E_RIVE_CONVERT_FORMAT', 'Only plain records are accepted.', path);
  const descriptors = Object.getOwnPropertyDescriptors(value as Record<string, unknown>);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable) continue;
    if (!('value' in descriptor) || descriptor.value === undefined) conversionFail('E_RIVE_CONVERT_FORMAT', 'Undefined values and accessors are forbidden.', `${path}.${key}`);
    result[key] = canonicalJson(descriptor.value, `${path}.${key}`);
  }
  return result;
}
export function canonicalClone<T>(value: T, path = '$'): T { return canonicalJson(value, path) as T; }
export async function sha256(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes.byteLength); source.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', source);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function normalizePackagePath(path: string, sourcePath = '$.path'): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('//') || normalized.includes('\0')) conversionFail('E_RIVE_CONVERT_FORMAT', 'Package path must be relative and normalized.', sourcePath);
  if (normalized.split('/').some(segment => segment === '.' || segment === '..' || !segment)) conversionFail('E_RIVE_CONVERT_FORMAT', 'Package path traversal is forbidden.', sourcePath);
  return normalized;
}
export function compareUtf8(left: string, right: string): number {
  const a = ENCODER.encode(left), b = ENCODER.encode(right), length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) { const difference = a[index]! - b[index]!; if (difference !== 0) return difference; }
  return a.length - b.length;
}
