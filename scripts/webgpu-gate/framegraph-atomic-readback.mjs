import { createFloatTextureReadback } from './float-texture-readback.mjs';
import { CONTROL_WIDTH, CONTROL_HEIGHT, controlWords, controlRgba, decodeBgraRows } from './framegraph-readback-controls-policy.mjs';

/** Save bound native entry points BEFORE installing any benchmark/coverage wrapper. */
export function nativeReadbackDevice(device) {
  const methods = ['createBuffer', 'createTexture', 'createShaderModule', 'createBindGroupLayout',
    'createPipelineLayout', 'createComputePipeline', 'createBindGroup', 'createCommandEncoder', 'createRenderBundleEncoder'];
  return Object.fromEntries([...methods.map(name => [name, device[name].bind(device)]),
    ['queue', { submit: device.queue.submit.bind(device.queue), writeTexture: device.queue.writeTexture.bind(device.queue) }]]);
}

// Created before warmup/metric reset. Uploads never contaminate a measured frame.
export function createReadbackControls(device) {
  const words = controlWords();
  const buffer = device.createBuffer({ label: 'probe.known-buffer', size: words.length * 4,
    mappedAtCreation: true, usage: GPUBufferUsage.COPY_SRC });
  new Uint32Array(buffer.getMappedRange()).set(words); buffer.unmap();
  const texture = device.createTexture({ label: 'probe.known-bgra', size: [CONTROL_WIDTH, CONTROL_HEIGHT, 1],
    format: 'bgra8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
  const rgba = controlRgba(), bgra = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) bgra.set([rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]], i);
  device.queue.writeTexture({ texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 }, aspect: 'all' }, bgra,
    { offset: 0, bytesPerRow: CONTROL_WIDTH * 4, rowsPerImage: CONTROL_HEIGHT },
    { width: CONTROL_WIDTH, height: CONTROL_HEIGHT, depthOrArrayLayers: 1 });
  return { buffer, texture, destroy() { buffer.destroy(); texture.destroy(); } };
}

function mappedCopy(device, size, decode) {
  const buffer = device.createBuffer({ label: 'probe.staging', size, mappedAtCreation: true,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  new Uint8Array(buffer.getMappedRange()).fill(0xa5); buffer.unmap();
  return { buffer, async read() {
    await buffer.mapAsync(GPUMapMode.READ, 0, size);
    try { return decode(buffer.getMappedRange(0, size).slice(0)); }
    finally { buffer.unmap(); }
  }, destroy() { buffer.destroy(); } };
}
function textureCopy(device, texture) {
  if (texture.format !== 'bgra8unorm') throw Error('Expected BGRA8 copy target');
  const { width, height } = texture, bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const staging = mappedCopy(device, bytesPerRow * height,
    bytes => decodeBgraRows(new Uint8Array(bytes), width, height, bytesPerRow));
  return { ...staging, encode(encoder) {
    encoder.copyTextureToBuffer({ texture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 }, aspect: 'all' },
      { buffer: staging.buffer, offset: 0, bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 });
  } };
}

/** No rendering/resource recycling occurs between encoding and completion of ALL maps. */
export async function captureAtomicReadback(device, target, source, controls, { copySource, frameId, access }) {
  const owned = [];
  const own = value => { owned.push(value); return value; };
  try {
    const computed = own(createFloatTextureReadback(device, target));
    const sourcePixels = own(createFloatTextureReadback(device, source));
    const copied = copySource ? own(textureCopy(device, target)) : null;
    const textureCompute = own(createFloatTextureReadback(device, controls.texture));
    const textureCopied = own(textureCopy(device, controls.texture));
    const buffer = own(mappedCopy(device, controls.buffer.size, bytes => Array.from(new Uint32Array(bytes))));
    const witness = own(mappedCopy(device, 32, bytes => Array.from(new Uint32Array(bytes))));
    const storage = own(device.createBuffer({ label: 'probe.execution-witness', size: 32, mappedAtCreation: true,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
    new Uint32Array(storage.getMappedRange()).fill(0xffffffff); storage.unmap();
    const module = device.createShaderModule({ label: 'probe.execution-witness', code: `
      @group(0) @binding(0) var targetImage: texture_2d<f32>;
      @group(0) @binding(1) var sourceImage: texture_2d<f32>;
      @group(0) @binding(2) var<storage, read_write> words: array<vec4<u32>, 2>;
      @compute @workgroup_size(1) fn main() {
        words[0] = vec4<u32>(4660u, ${frameId}u, textureDimensions(targetImage));
        words[1] = vec4<u32>(22136u, ${frameId}u, textureDimensions(sourceImage));
      }` });
    const compilation = await module.getCompilationInfo();
    if (compilation.messages.some(m => m.type === 'error')) throw Error(JSON.stringify(compilation.messages));
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: target.createView() }, { binding: 1, resource: source.createView() },
      { binding: 2, resource: { buffer: storage } },
    ] });
    const encoder = device.createCommandEncoder({ label: `probe.atomic.frame-${frameId}` });
    computed.encode(encoder); copied?.encode(encoder); sourcePixels.encode(encoder);
    textureCompute.encode(encoder); textureCopied.encode(encoder);
    encoder.copyBufferToBuffer(controls.buffer, 0, buffer.buffer, 0, controls.buffer.size);
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(storage, 0, witness.buffer, 0, 32);
    device.queue.submit([encoder.finish()]);
    // allSettled is essential: a failed map must not destroy another pending map's buffer.
    const jobs = { computed, sourcePixels, ...(copied ? { copied } : {}), textureCompute, textureCopied, buffer, witness };
    const settled = await Promise.allSettled(Object.values(jobs).map(job => job.read()));
    const values = {}, mapErrors = [];
    Object.keys(jobs).forEach((key, i) => {
      const entry = settled[i];
      if (entry.status === 'fulfilled') values[key] = Array.from(entry.value);
      else { values[key] = null; mapErrors.push({ key, error: String(entry.reason?.stack ?? entry.reason) }); }
    });
    return { computed: values.computed, copied: values.copied ?? null, sourcePixels: values.sourcePixels,
      atomicReadback: { schemaVersion: 1, submissions: 1, frameId, access,
        resourcesRetainedUntilAllMapsSettled: true, mapErrors,
        target: { width: target.width, height: target.height, format: target.format, usage: target.usage },
        source: { width: source.width, height: source.height, format: source.format, usage: source.usage },
        pattern: { width: CONTROL_WIDTH, height: CONTROL_HEIGHT, bytesPerRow: 256 },
        controls: { buffer: values.buffer, textureCompute: values.textureCompute,
          textureCopy: values.textureCopied, witness: values.witness } } };
  } finally { for (const resource of owned.reverse()) resource.destroy(); }
}
