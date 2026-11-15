export const regressionCrop = { x: 440, y: 40, width: 500, height: 560 };
export const regressionExtent = { width: 960, height: 640 };

/** Copy the final resolved color before the browser can retire its canvas texture. */
export async function readRegressionCrop(device: GPUDevice, texture: GPUTexture): Promise<string> {
  if (texture.width !== regressionExtent.width || texture.height !== regressionExtent.height || texture.sampleCount !== 1) {
    throw new Error('Motion blur capture requires a resolved 960×640 color texture.');
  }
  const bgra = texture.format === 'bgra8unorm';
  if (!bgra && texture.format !== 'rgba8unorm') {
    throw new Error(`Unexpected motion blur capture format ${texture.format}.`);
  }
  const { x, y, width, height } = regressionCrop;
  const rowSize = width * 4;
  const bytesPerRow = Math.ceil(rowSize / 256) * 256;
  const buffer = device.createBuffer({
    label: 'motion-blur.regression-readback', size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: 'motion-blur.regression-readback' });
    encoder.copyTextureToBuffer({ texture, origin: [x, y] }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const rgba = new Uint8Array(rowSize * height);
    for (let row = 0; row < height; row++) {
      rgba.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + rowSize), row * rowSize);
    }
    if (bgra) {
      for (let offset = 0; offset < rgba.length; offset += 4) {
        const red = rgba[offset + 2]!;
        rgba[offset + 2] = rgba[offset]!;
        rgba[offset] = red;
      }
    }
    // Transport the packed crop in a single result without passing a large argument list to JS.
    const chunks: string[] = [];
    for (let offset = 0; offset < rgba.length; offset += 8192) {
      chunks.push(String.fromCharCode(...rgba.subarray(offset, offset + 8192)));
    }
    return btoa(chunks.join(''));
  } finally {
    if (buffer.mapState === 'mapped') buffer.unmap();
    buffer.destroy();
  }
}
