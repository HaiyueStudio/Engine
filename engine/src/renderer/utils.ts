import { alignUp4 } from '../utils/align';

export type BufferSourceLike = {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
};

/**
 * `wgpu-matrix` returns Float32Array<ArrayBufferLike>, which is wider than
 * GPUAllowSharedBufferSource in @webgpu/types. Passing buffer+offset+size keeps
 * renderer code type-safe without copying typed arrays.
 */
export function writeBuffer(
  queue: GPUQueue,
  destination: GPUBuffer,
  destinationOffset: number,
  source: BufferSourceLike,
  sourceOffset = 0,
  size = source.byteLength,
): void {
  queue.writeBuffer(destination, destinationOffset, source.buffer as ArrayBuffer, source.byteOffset + sourceOffset, size);
}

export function writeBufferAligned(
  queue: GPUQueue,
  destination: GPUBuffer,
  destinationOffset: number,
  source: BufferSourceLike,
): void {
  if (source.byteLength % 4 === 0) {
    writeBuffer(queue, destination, destinationOffset, source);
    return;
  }
  const padded = new Uint8Array(alignUp4(source.byteLength));
  padded.set(new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength));
  queue.writeBuffer(destination, destinationOffset, padded.buffer);
}

export function matrixEquals(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < 16; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function colorEquals(
  color: [number, number, number, number],
  r: number,
  g: number,
  b: number,
  a: number,
): boolean {
  return color[0] === r && color[1] === g && color[2] === b && color[3] === a;
}

export function getStripIndexFormat(geometry: {
  topology?: GPUPrimitiveTopology | null;
  indices?: Uint16Array | Uint32Array | null;
}): GPUIndexFormat | undefined {
  if (geometry.topology !== 'line-strip' && geometry.topology !== 'triangle-strip') return undefined;
  if (!geometry.indices) return undefined;
  return geometry.indices instanceof Uint32Array ? 'uint32' : 'uint16';
}

export type LiveIdSet = Pick<ReadonlySet<number>, 'has'>;

export function releaseMapEntriesNotIn<T>(
  cache: Map<number, T>,
  liveIds: LiveIdSet,
  destroy: (value: T) => void,
): void {
  for (const [id, value] of cache) {
    if (!liveIds.has(id)) {
      destroy(value);
      cache.delete(id);
    }
  }
}
