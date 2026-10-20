// Intentionally does not import Engine: isolate the final shader and native WebGPU execution.
import { outputProbeShader } from './multiview-output-probe-policy.mjs';
const resultNode = document.querySelector('#result');
const query = new URLSearchParams(location.search);
const variant = query.get('variant') ?? 'original';
const frames = Number(query.get('frames') ?? 512);
let device;
try {
  const response = await fetch('/engine/src/shaders/generated/postprocess-output.generated.wgsl');
  if (!response.ok) throw new Error(`Output shader HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== query.get('shaderSha256')) throw new Error('Output shader provenance mismatch');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: query.get('powerPreference') });
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('Native WebGPU adapter required');
  device = await adapter.requestDevice();
  const validationErrors = [];
  device.addEventListener('uncapturederror', event => validationErrors.push(event.error.message));
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: outputProbeShader(new TextDecoder().decode(bytes), variant) });
  const compilation = await module.getCompilationInfo();
  if (compilation.messages.some(message => message.type === 'error')) throw new Error(JSON.stringify(compilation.messages));
  const vertexBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array([-1, -1, 0, 1, 3, -1, 2, 1, -1, 3, 0, -1]));
  const pipeline = device.createRenderPipeline({
    layout: 'auto', vertex: { module, entryPoint: 'vs_main', ...(variant === 'vertex-buffer' ? {
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }] }],
    } : {}) },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniform, 0, new Float32Array([1, 0, 0, 0]));
  const createTexture = format => device.createTexture({ size: [64, 64], format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const outputs = Array.from({ length: 4 }, () => createTexture('bgra8unorm'));
  const sources = Array.from({ length: 4 }, () => createTexture('rgba16float'));
  const fallback = ['lazy-depth', 'initialized-depth'].includes(variant) ? device.createTexture({
    size: [1, 1, 4], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  }) : null;
  if (variant === 'initialized-depth') {
    const initialize = device.createCommandEncoder();
    for (let layer = 0; layer < 4; layer++) initialize.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
      view: fallback.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
      depthLoadOp: 'clear', depthClearValue: 0, depthStoreOp: 'store',
    } }).end();
    device.queue.submit([initialize.finish()]);
  }
  const fallbackEntries = fallback ? [{ binding: 2, resource: fallback.createView({ dimension: '2d-array' }) }] : [];
  const groups = sources.map(texture => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: { buffer: uniform } }, ...fallbackEntries] }));
  const cases = [];
  let failure = null;
  for (const mode of ['clear-only', 'shared-hdr', 'isolated-hdr']) {
    let completedFrames = 0;
    for (let frame = 0; frame < frames; frame++) {
      document.querySelector('#progress').textContent = `${variant}/${mode}: ${frame + 1}/${frames}`;
      const encoder = device.createCommandEncoder();
      for (const [index, output] of outputs.entries()) {
        const sourceIndex = mode === 'isolated-hdr' ? index : 0;
        const clearValue = [29 / 255, 17 / 255, 11 / 255, 1];
        if (mode !== 'clear-only') {
          const clear = encoder.beginRenderPass({ colorAttachments: [{
            view: sources[sourceIndex].createView(), clearValue, loadOp: 'clear', storeOp: 'store',
          }] });
          clear.end();
        }
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: output.createView(),
          clearValue: mode === 'clear-only' ? clearValue : [1, 0, 1, 1], loadOp: 'clear', storeOp: 'store' }] });
        if (mode !== 'clear-only') {
          if (variant === 'explicit-state') { pass.setViewport(0, 0, 64, 64, 0, 1); pass.setScissorRect(0, 0, 64, 64); }
          if (variant === 'vertex-buffer') pass.setVertexBuffer(0, vertexBuffer);
          pass.setPipeline(pipeline); pass.setBindGroup(0, groups[sourceIndex]); pass.draw(3);
        }
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      const pixels = await Promise.all(outputs.map(read));
      if (pixels.some(pixel => pixel.some((value, channel) => value !== [11, 17, 29, 255][channel]))) {
        const reread = [];
        for (const output of outputs) reread.push(await read(output));
        const fullOutputs = [];
        for (const output of outputs) fullOutputs.push(await inspect(output));
        failure = { mode, frame, pixels, reread, fullOutputs, clearSentinel: [255, 0, 255, 255] };
        break;
      }
      completedFrames++;
    }
    cases.push({ mode, completedFrames });
    if (failure) break;
  }
  const validation = await device.popErrorScope();
  if (validation) validationErrors.push(validation.message);
  const result = { schemaVersion: 1, status: failure || validationErrors.length ? 'failed' : 'passed',
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter },
    shaderSha256: hash, variant, requestedFrames: frames, cases, failure, validationErrors };
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = result.status;
} catch (error) {
  resultNode.textContent = JSON.stringify({ status: 'failed', error: error.stack ?? String(error) });
  resultNode.dataset.status = 'failed';
} finally { device?.destroy(); }

async function read(texture) {
  const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, origin: [32, 32] }, { buffer, bytesPerRow: 256 }, { width: 1, height: 1 });
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const pixel = Array.from(new Uint8Array(buffer.getMappedRange()).slice(0, 4));
    buffer.unmap(); return pixel;
  } finally { buffer.destroy(); }
}

async function inspect(texture) {
  const buffer = device.createBuffer({ size: 64 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange());
    let sentinel = 0, expected = 0, transparent = 0;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      if (bytes.slice(offset, offset + 4).every((value, c) => value === [255, 0, 255, 255][c])) sentinel++;
      if (bytes.slice(offset, offset + 4).every((value, c) => value === [11, 17, 29, 255][c])) expected++;
      if (bytes[offset + 3] === 0) transparent++;
    }
    buffer.unmap(); return { pixels: 4096, sentinel, expected, transparent };
  } finally { buffer.destroy(); }
}
