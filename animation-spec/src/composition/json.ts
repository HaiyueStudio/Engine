import {HyaCompositionError} from './errors.js';
import {DEFAULT_HYA_COMPOSITION_LIMITS, type HyaCompositionLimits, type HyaCompositionValue} from './types.js';

export function compositionLimits(requested: Partial<HyaCompositionLimits> = {}): HyaCompositionLimits {
  const result = {...DEFAULT_HYA_COMPOSITION_LIMITS};
  for (const [key, value] of Object.entries(requested)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value <= 0 || value > result[key as keyof HyaCompositionLimits])
      throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', '$options.limits.' + key, 'Limits may only tighten positive hard ceilings.');
    (result as unknown as Record<string, number>)[key] = value;
  }
  return Object.freeze(result);
}

function utf8Bytes(text: string, json: boolean): number {
  let bytes = json ? 2 : 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (json && (code === 34 || code === 92)) bytes += 2;
    else if (json && code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {bytes += 4; i++;}
    else if (code >= 0xd800 && code <= 0xdfff) bytes += json ? 6 : 3;
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
  }
  return bytes;
}

/** Check the entire tree before cloning, stringifying or invoking a part parser. */
export function checkedCompositionJson(value: unknown, limits: HyaCompositionLimits): HyaCompositionValue {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  const fail = (path: string, message: string): never => {throw new HyaCompositionError('E_HYA_COMPOSITION_FORMAT', path, message);};
  const add = (size: number, path: string): void => {
    bytes += size;
    if (bytes > limits.maxInputBytes) throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'JSON bytes exceed the input ceiling.');
  };
  const string = (text: string, path: string): void => {
    if (text.length > limits.maxStringBytes || utf8Bytes(text, false) > limits.maxStringBytes)
      throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'String exceeds the UTF-8 ceiling.');
    add(utf8Bytes(text, true), path);
  };
  const visit = (item: unknown, path: string, depth: number): void => {
    if (++nodes > limits.maxJsonNodes || depth > limits.maxDepth)
      throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'JSON nodes or depth exceed the ceiling.');
    if (item === null) {add(4, path); return;}
    if (typeof item === 'boolean') {add(item ? 4 : 5, path); return;}
    if (typeof item === 'number') {if (!Number.isFinite(item)) fail(path, 'Numbers must be finite.'); add(String(item).length, path); return;}
    if (typeof item === 'string') {string(item, path); return;}
    if (typeof item !== 'object') fail(path, 'Only JSON data is allowed.');
    const object = item as object;
    if (active.has(object)) fail(path, 'JSON cycles are forbidden.');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) && (array || Object.getPrototypeOf(item) !== null))
      fail(path, 'Only plain objects and arrays are allowed.');
    if (array && item.length > limits.maxJsonNodes) throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'Array exceeds the node ceiling.');
    const keys = Reflect.ownKeys(object);
    if (keys.length > limits.maxJsonNodes + (array ? 1 : 0)) throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', path, 'Object exceeds the node ceiling.');
    if (array && keys.length !== item.length + 1) fail(path, 'Arrays must be dense and have no extra properties.');
    active.add(object); add(2 + Math.max(0, keys.length - (array ? 2 : 1)), path);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw new HyaCompositionError('E_HYA_COMPOSITION_FORMAT', path, 'Symbols are forbidden.');
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(path, 'Reserved keys are forbidden.');
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) fail(path, 'Accessors and hidden properties are forbidden.');
      if (array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length)) fail(path, 'Array property is not an index.');
      if (!array) {string(key, path); add(1, path);}
      visit(descriptor.value, array ? `${path}[${key}]` : `${path}.${key}`, depth + 1);
    }
    active.delete(object);
  };
  visit(value, '$', 1);
  return value as HyaCompositionValue;
}

export function canonicalCompositionJson(value: HyaCompositionValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalCompositionJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalCompositionJson((value as {[key: string]: HyaCompositionValue})[key]!)).join(',') + '}';
}

export function readCompositionSource(source: unknown, limits: HyaCompositionLimits): HyaCompositionValue {
  let value = source;
  if (source instanceof ArrayBuffer || source instanceof Uint8Array) {
    if (source.byteLength > limits.maxInputBytes) throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', '$', 'Input byte ceiling exceeded.');
    try {value = new TextDecoder('utf-8', {fatal: true}).decode(source);}
    catch {throw new HyaCompositionError('E_HYA_COMPOSITION_FORMAT', '$', 'Input is not valid UTF-8.');}
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxInputBytes || utf8Bytes(value, false) > limits.maxInputBytes)
      throw new HyaCompositionError('E_HYA_COMPOSITION_LIMIT', '$', 'Input byte ceiling exceeded.');
    try {value = JSON.parse(value);}
    catch {throw new HyaCompositionError('E_HYA_COMPOSITION_FORMAT', '$', 'Input is not valid JSON.');}
  }
  return JSON.parse(canonicalCompositionJson(checkedCompositionJson(value, limits))) as HyaCompositionValue;
}

export function freezeComposition<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeComposition(child);
    Object.freeze(value);
  }
  return value;
}
