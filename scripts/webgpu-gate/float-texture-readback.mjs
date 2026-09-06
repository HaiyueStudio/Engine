/** Read diagnostic pixels without adding COPY_SRC usage to production render targets. */
export async function readFloatTexture(device, texture, depth = false) {
  const readback = createFloatTextureReadback(device, texture, depth);
  try {
    const encoder = device.createCommandEncoder();
    readback.encode(encoder);
    device.queue.submit([encoder.finish()]);
    return await readback.read();
  } finally { readback.destroy(); }
}

/** Encode at the consumer boundary, before a later view reuses the same texture. */
export function createFloatTextureReadback(device, texture, depth = false) {
  const { width, height } = texture;
  const output = device.createBuffer({ size: width * height * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: output.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var image: ${depth ? 'texture_depth_2d' : 'texture_2d<f32>'};
      @group(0) @binding(1) var<storage, read_write> pixels: array<vec4<f32>>;
      @compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let size = textureDimensions(image);
        if (id.x >= size.x || id.y >= size.y) { return; }
        pixels[id.y * size.x + id.x] = vec4<f32>(textureLoad(image, vec2<i32>(id.xy), 0));
      }` });
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: depth ? 'depth' : 'unfilterable-float' } },
    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
  ] });
  const pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: 'main' } });
  const group = device.createBindGroup({ layout, entries: [
    { binding: 0, resource: texture.createView({ dimension: '2d', baseArrayLayer: 0, arrayLayerCount: 1 }) },
    { binding: 1, resource: { buffer: output } },
  ] });
  return {
    encode(encoder) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, output.size);
    },
    async read() {
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange().slice(0));
      readback.unmap();
      return pixels;
    },
    destroy() { readback.destroy(); output.destroy(); },
  };
}
