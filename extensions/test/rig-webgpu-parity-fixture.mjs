const progress = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!adapter) throw new Error('No WebGPU adapter');
  const build = new URL(location.href).searchParams.get('build'); if (!build) throw new Error('Missing compiled runtime mount');
  const { ParameterizedRigGpuSkinner } = await import(`${build}/deformable-animation/parameterized/index.js`);
  const firstDevice = await adapter.requestDevice();
  const first = await runSkinAndPixel(firstDevice, ParameterizedRigGpuSkinner, null, 0);
  const secondAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); if (!secondAdapter) throw new Error('No recovery WebGPU adapter');
  const secondDevice = await secondAdapter.requestDevice();
  const second = await runSkinAndPixel(secondDevice, ParameterizedRigGpuSkinner, first.skinner, 3);
  firstDevice.destroy();
  second.skinner.dispose();
  const residual = second.skinner.stats;
  secondDevice.destroy();
  if (residual.meshCount !== 0 || residual.bufferCount !== 0 || residual.allocatedBytes !== 0) throw new Error(`GPU owner residual: ${JSON.stringify(residual)}`);
  resultNode.textContent = JSON.stringify({ status: 'passed', suite: 'animation.parameterized-rig-webgpu', strictValidation: true, vertexCases: first.vertexCases + second.vertexCases, pixelCases: 2, firstRedPixels: first.redPixels, recoveredRedPixels: second.redPixels, recoveredGeneration: second.skinner.stats.generation, residual });
  resultNode.dataset.status = 'passed'; progress.textContent = 'complete';
} catch (error) { resultNode.textContent = error instanceof Error ? error.stack ?? error.message : String(error); resultNode.dataset.status = 'failed'; progress.textContent = 'failed'; }

async function runSkinAndPixel(device, Skinner, existing, generation) {
  device.pushErrorScope('validation');
  const skinner = existing ?? new Skinner(device, { maxGpuBytes: 1024 * 1024 });
  if (existing) existing.recoverDevice(device, generation);
  const mesh = { id: 'triangle', positions: new Float32Array([-.5, -.5, .5, -.5, 0, .5]), uvs: new Float32Array(6), indices: new Uint32Array([0, 1, 2]), influenceOffsets: new Uint32Array([0, 1, 2, 3]), jointIndices: new Uint32Array([0, 0, 0]), weights: new Float32Array([1, 1, 1]) };
  if (!existing) skinner.uploadMesh('triangle', mesh, 1);
  const bone = { id: 'root', parent: -1, length: 1, inverseBind: [1, 0, 0, 1, 0, 0], local: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, skew: 0 }, world: new Float32Array([1, 0, 0, 1, .25, 0]) };
  const encoder = device.createCommandEncoder(); const output = skinner.skin('triangle', [bone], encoder);
  const vertexReadback = device.createBuffer({ size: 24, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); encoder.copyBufferToBuffer(output, 0, vertexReadback, 0, 24);
  const texture = device.createTexture({ size: [32, 32], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const render = device.createRenderPipeline({ layout: 'auto', vertex: { module: device.createShaderModule({ code: '@vertex fn main(@location(0) p:vec2f)->@builtin(position) vec4f{return vec4f(p,0,1);}' }), entryPoint: 'main', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }] }, fragment: { module: device.createShaderModule({ code: '@fragment fn main()->@location(0) vec4f{return vec4f(1,0,0,1);}' }), entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] }); pass.setPipeline(render); pass.setVertexBuffer(0, output); pass.draw(3); pass.end();
  const pixelReadback = device.createBuffer({ size: 256 * 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); encoder.copyTextureToBuffer({ texture }, { buffer: pixelReadback, bytesPerRow: 256 }, [32, 32]); device.queue.submit([encoder.finish()]);
  await Promise.all([vertexReadback.mapAsync(GPUMapMode.READ), pixelReadback.mapAsync(GPUMapMode.READ)]);
  const vertices = [...new Float32Array(vertexReadback.getMappedRange()).slice()]; const expected = [-.25, -.5, .75, -.5, .25, .5]; let vertexCases = 0; for (let index = 0; index < expected.length; index++) { if (Math.abs(vertices[index] - expected[index]) > 1e-6) throw new Error(`vertex ${index}: ${vertices[index]} != ${expected[index]}`); vertexCases++; }
  const pixels = new Uint8Array(pixelReadback.getMappedRange()); let redPixels = 0; for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const offset = y * 256 + x * 4; if (pixels[offset] > 250 && pixels[offset + 1] < 5 && pixels[offset + 2] < 5 && pixels[offset + 3] > 250) redPixels++; } if (redPixels < 100) throw new Error(`Expected visible skinned triangle, got ${redPixels} red pixels`);
  vertexReadback.unmap(); pixelReadback.unmap(); vertexReadback.destroy(); pixelReadback.destroy(); texture.destroy();
  const validation = await device.popErrorScope(); if (validation) throw validation;
  return { skinner, vertexCases, redPixels };
}
