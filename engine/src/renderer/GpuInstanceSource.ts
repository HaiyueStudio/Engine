/** Borrowed GPU-produced instance streams. Renderer never uploads or destroys
 * them. Matrix/color indices are stable application IDs; visibleIndices maps
 * each draw instance back to that ID. All buffers belong to `device`. */
export interface GpuInstanceSource {
  readonly device: GPUDevice;
  readonly transforms: GPUBuffer;
  readonly colors: GPUBuffer;
  readonly visibleIndices: GPUBuffer;
  readonly capacity: number;
  /** Direct draw count, or maximum count when using an indirect command. */
  readonly count: number;
  /** Byte offset of an aligned visibility slice (for example one LOD bucket). */
  readonly visibleOffset?: number;
}
export function validateGpuInstanceSource(device: GPUDevice, source: GpuInstanceSource): void {
  if (source.device !== device) throw new Error('GPU instance source belongs to a different device; rebuild after device loss.');
  if (!Number.isSafeInteger(source.capacity) || source.capacity < 1 || !Number.isSafeInteger(source.count) || source.count < 0 || source.count > source.capacity) throw new RangeError('GPU instance count/capacity is invalid.');
  const offset = source.visibleOffset ?? 0;
  const alignment = device.limits?.minStorageBufferOffsetAlignment ?? 256;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % alignment !== 0) throw new RangeError('GPU visibility offset must satisfy storage-buffer alignment.');
  for (const [buffer, bytes] of [[source.transforms, source.capacity * 64], [source.colors, source.capacity * 16], [source.visibleIndices, offset + source.capacity * 4]] as const) {
    if (!(buffer.usage & GPUBufferUsage.STORAGE) || buffer.size < bytes || buffer.mapState !== 'unmapped') throw new RangeError('GPU instance source requires unmapped STORAGE buffers with sufficient capacity.');
  }
  const maxBinding = device.limits?.maxStorageBufferBindingSize ?? Infinity;
  if (source.capacity * 64 > maxBinding) throw new RangeError('GPU instance matrices exceed maxStorageBufferBindingSize.');
}
