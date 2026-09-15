/** Pass-local command elision. This reduces native JS/Metal bridge traffic without
 * changing draw order, resource ownership, or state shared between renderers. */
const cachedPasses = new WeakMap<GPURenderPassEncoder, GPURenderPassEncoder>();
const emptyOffsets: readonly number[] = [];

export function cacheRenderPassState(pass: GPURenderPassEncoder): GPURenderPassEncoder {
  const cached = cachedPasses.get(pass);
  if (cached) return cached;
  let pipeline: GPURenderPipeline | undefined;
  const groups = new Map<number, { group: GPUBindGroup | null | undefined; offsets: number[] }>();
  const vertices = new Map<number, { buffer: GPUBuffer | null; offset: number | undefined; size: number | undefined }>();
  let indices: { buffer: GPUBuffer; format: GPUIndexFormat; offset: number | undefined; size: number | undefined } | undefined;
  const reset = (): void => { pipeline = undefined; groups.clear(); vertices.clear(); indices = undefined; };
  const methods = new Map<PropertyKey, unknown>();
  methods.set('setPipeline', (next: GPURenderPipeline): void => {
    if (pipeline === next) return;
    pass.setPipeline(next); pipeline = next;
  });
  methods.set('setBindGroup', (index: number, group: GPUBindGroup | null | undefined, offsets?: Iterable<number>, start?: number, length?: number): void => {
    const values = offsets ?? emptyOffsets;
    const typedValues = ArrayBuffer.isView(values) && Object.prototype.toString.call(values) === '[object Uint32Array]'
      ? values as Uint32Array : null;
    // Arbitrary iterators may have observable iteration; let WebGPU consume them.
    if (!typedValues && (!Array.isArray(values) || values[Symbol.iterator] !== Array.prototype[Symbol.iterator])) {
      groups.delete(index); pass.setBindGroup(index, group, values); return;
    }
    const data = typedValues ?? values as number[];
    const from = typedValues ? start ?? 0 : 0;
    const count = typedValues ? length ?? data.length - from : data.length;
    const old = groups.get(index);
    let same = old !== undefined && old.group === group && old.offsets.length === count;
    for (let i = 0; same && i < count; i++) same = old!.offsets[i] === data[from + i];
    if (same) return;
    if (typedValues) pass.setBindGroup(index, group, typedValues, from, count);
    else pass.setBindGroup(index, group, values);
    groups.set(index, { group, offsets: Array.from(data.slice(from, from + count)) });
  });
  methods.set('setVertexBuffer', (slot: number, buffer: GPUBuffer | null, offset?: number, size?: number): void => {
    const old = vertices.get(slot);
    if (old?.buffer === buffer && old.offset === offset && old.size === size) return;
    pass.setVertexBuffer(slot, buffer, offset, size);
    vertices.set(slot, { buffer, offset, size });
  });
  methods.set('setIndexBuffer', (buffer: GPUBuffer, format: GPUIndexFormat, offset?: number, size?: number): void => {
    if (indices?.buffer === buffer && indices.format === format && indices.offset === offset && indices.size === size) return;
    pass.setIndexBuffer(buffer, format, offset, size);
    indices = { buffer, format, offset, size };
  });
  methods.set('executeBundles', (bundles: Iterable<GPURenderBundle>): void => {
    // WebGPU clears pipeline/bind groups/vertex/index state even for an empty list.
    reset(); pass.executeBundles(bundles);
  });
  methods.set('end', (): void => { reset(); pass.end(); });
  const wrapped = new Proxy(pass, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const bound = value.bind(target);
      methods.set(key, bound);
      return bound;
    },
  });
  cachedPasses.set(pass, wrapped);
  cachedPasses.set(wrapped, wrapped);
  return wrapped;
}
