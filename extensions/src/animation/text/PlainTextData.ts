type Data = null | boolean | string | number | readonly Data[] | {readonly [name: string]: Data};
/** Copies plain text metadata; opaque font/bitmap resources are outside this boundary. */
export function snapshotPlainTextData(value: unknown, path: string, fail: (path: string, message: string, limit?: boolean) => never,
  options: Readonly<{strict?: boolean; maxBytes?: number}> = {}): Data {
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const count = (value: string, path: string): void => {if (options.maxBytes !== undefined && (bytes += new TextEncoder().encode(value).byteLength) > options.maxBytes) fail(path, 'metadata exceeds the composition JSON byte ceiling', true);};
  function visit(value: unknown, path: string, depth: number): Data {
    if (++nodes > 1_000_000 || depth > 128) fail(path, 'text metadata exceeds the composition node/depth ceilings', true);
    if (value === null || typeof value === 'boolean') {count(String(value), path); return value;}
    if (typeof value === 'string') {if (value.length > 4 * 1024 * 1024) fail(path, 'text exceeds the composition string ceiling', true); count(JSON.stringify(value), path); return value;}
    if (typeof value === 'number' && Number.isFinite(value)) {count(JSON.stringify(value), path); return value;}
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail(path, 'text metadata must be finite plain data');
    if (active.has(value)) fail(path, 'cyclic text metadata');
    if (options.strict) for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable && !(Array.isArray(value) && key === 'length')
        || ['__proto__', 'prototype', 'constructor'].includes(key)
        || Array.isArray(value) && key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        fail(path, 'metadata requires visible JSON value properties without prototype keys');
    }
    active.add(value); let result: Data;
    if (Array.isArray(value)) {
      count('[]', path);
      const array: Data[] = [];
      for (let index = 0; index < value.length; index++) {
        if (index) count(',', path);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) fail(`${path}[${index}]`, 'text metadata arrays must be dense values without accessors');
        array.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
      }
      result = Object.freeze(array);
    } else {
      count('{}', path); let index = 0;
      const record: Record<string, Data> = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        count((index++ ? ',' : '') + JSON.stringify(key) + ':', path);
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor)) fail(`${path}.${key}`, 'text metadata cannot contain accessors');
        record[key] = visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
      result = Object.freeze(record);
    }
    active.delete(value); return result;
  }
  return visit(value, path, 0);
}
