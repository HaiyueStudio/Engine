export interface ReflectedUniformField {
  readonly name: string;
  readonly type: string;
  readonly offset: number;
}

export interface ReflectedUniformBlock {
  readonly byteSize: number;
  readonly fields: readonly ReflectedUniformField[];
}

export type ReflectedUniformValue = number | readonly number[] | ArrayLike<number>;

export function packReflectedUniforms(
  layout: ReflectedUniformBlock,
  values: Readonly<Record<string, ReflectedUniformValue>>,
): ArrayBuffer {
  const buffer = new ArrayBuffer(layout.byteSize);
  const view = new DataView(buffer);
  for (const field of layout.fields) {
    const value = values[field.name];
    if (value === undefined) throw new Error(`Uniform value ${field.name} is missing.`);
    const normalized = typeof value === 'number' ? [value] : Array.from(value);
    const width = uniformComponentCount(field.type);
    if (normalized.length !== width || normalized.some(component => !Number.isFinite(component))) {
      throw new Error(`Uniform ${field.name} requires ${width} finite ${field.type} components.`);
    }
    for (let index = 0; index < normalized.length; index++) {
      const offset = field.offset + index * 4;
      if (field.type === 'u32') view.setUint32(offset, normalized[index]!, true);
      else if (field.type === 'i32') view.setInt32(offset, normalized[index]!, true);
      else view.setFloat32(offset, normalized[index]!, true);
    }
  }
  return buffer;
}

export function createGpuBufferWithData(
  device: GPUDevice,
  label: string,
  values: ArrayBufferView<ArrayBuffer>,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const size = Math.max(4, Math.ceil(values.byteLength / 4) * 4);
  const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  buffer.unmap();
  return buffer;
}

export function copyPaddedTextureRows(
  mapped: ArrayBuffer,
  width: number,
  height: number,
  bytesPerRow: number,
): Uint8Array<ArrayBuffer> {
  const source = new Uint8Array(mapped);
  const result = new Uint8Array(width * height * 4);
  const tightStride = width * 4;
  for (let row = 0; row < height; row++) {
    result.set(source.subarray(row * bytesPerRow, row * bytesPerRow + tightStride), row * tightStride);
  }
  return result;
}

export function paintRgbaPixels(
  context: CanvasRenderingContext2D,
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  flipY: boolean,
): void {
  const display = flipY ? flipPixelRows(pixels, width, height) : Uint8ClampedArray.from(pixels);
  context.putImageData(new ImageData(display, width, height), 0, 0);
}

export function summarizeVisiblePixels(pixels: Uint8Array, neutralVelocity = false): {
  readonly visiblePixelCount: number;
  readonly averageRgba8: readonly number[];
  readonly maximumNeutralChannelDelta: number;
} {
  let visiblePixelCount = 0;
  const sum = [0, 0, 0, 0];
  let maximumNeutralChannelDelta = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    visiblePixelCount++;
    for (let channel = 0; channel < 4; channel++) sum[channel] = sum[channel]! + pixels[offset + channel]!;
    if (neutralVelocity) {
      maximumNeutralChannelDelta = Math.max(
        maximumNeutralChannelDelta,
        Math.abs(pixels[offset]! - 128),
        Math.abs(pixels[offset + 1]! - 128),
      );
    }
  }
  return Object.freeze({
    visiblePixelCount,
    averageRgba8: Object.freeze(sum.map(value => visiblePixelCount === 0 ? 0 : Math.round(value / visiblePixelCount))),
    maximumNeutralChannelDelta,
  });
}

export function alphaSilhouetteMismatch(images: readonly Uint8Array[]): number {
  if (images.length < 2) return 0;
  let mismatch = 0;
  for (let offset = 0; offset < images[0]!.length; offset += 4) {
    const expected = images[0]![offset + 3]! > 0;
    if (images.slice(1).some(image => (image[offset + 3]! > 0) !== expected)) mismatch++;
  }
  return mismatch;
}

function uniformComponentCount(type: string): number {
  if (type === 'f32' || type === 'u32' || type === 'i32') return 1;
  const vector = /^vec([234])<(?:f32|u32|i32)>$/.exec(type);
  if (vector) return Number(vector[1]);
  const matrix = /^mat([234])x([234])<f32>$/.exec(type);
  if (matrix) return Number(matrix[1]) * Number(matrix[2]);
  throw new Error(`Shader Language Lab uniform packer does not support ${type}.`);
}

function flipPixelRows(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray<ArrayBuffer> {
  const result: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(pixels.length);
  const stride = width * 4;
  for (let row = 0; row < height; row++) {
    result.set(pixels.subarray(row * stride, (row + 1) * stride), (height - row - 1) * stride);
  }
  return result;
}
