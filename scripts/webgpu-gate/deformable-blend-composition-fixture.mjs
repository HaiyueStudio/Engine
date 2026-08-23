const progress = document.querySelector('#progress');
const result = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const device = await adapter.requestDevice();
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  const samples = {
    sourceA: [204, 64, 128, 128],
    sourceB: [51, 179, 102, 153],
    background: [64, 102, 153, 204],
  };
  const textures = Object.fromEntries(Object.entries(samples).map(([id, rgba]) => [id, createTexture(device, id, rgba)]));
  const runtimeBitmap = await createImageBitmap(
    await fetch('../../examples/live2d-hya-compare/samples/blend-parity-a.png').then(response => {
      if (!response.ok) throw new Error(`Could not load runtime texture fixture: ${response.status}.`);
      return response.blob();
    }),
    { colorSpaceConversion: 'none', premultiplyAlpha: 'none' },
  );
  const runtimeTexture = device.createTexture({
    label: 'G11 runtime external-image upload',
    size: [runtimeBitmap.width, runtimeBitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: runtimeBitmap }, { texture: runtimeTexture }, [runtimeBitmap.width, runtimeBitmap.height]);
  const cases = [
    blendCase('normal-transparent', [], layer('sourceA', 'normal', 0.5, 1)),
    blendCase('additive-transparent', [], layer('sourceA', 'additive', 0.5, 1)),
    blendCase('multiplicative-transparent', [], layer('sourceA', 'multiplicative', 0.5, 1)),
    blendCase('normal-background', [background()], layer('sourceA', 'normal', 0.5, 1)),
    blendCase('additive-background', [background()], layer('sourceA', 'additive', 0.5, 1)),
    blendCase('multiplicative-background', [background()], layer('sourceA', 'multiplicative', 0.5, 1)),
    blendCase('normal-mask-outside', [background()], layer('sourceB', 'normal', 0.65, 0)),
    blendCase('additive-mask-outside', [background()], layer('sourceB', 'additive', 0.65, 0)),
    blendCase('multiplicative-mask-outside', [background()], layer('sourceB', 'multiplicative', 0.65, 0)),
    blendCase('normal-partial-mask', [background()], layer('sourceA', 'normal', 0.7, 0.4)),
    blendCase('additive-partial-mask', [background()], layer('sourceB', 'additive', 0.7, 0.4)),
    blendCase('multiplicative-partial-mask', [background()], layer('sourceA', 'multiplicative', 0.7, 0.4)),
    blendCase('normal-source-before-background', [layer('sourceA', 'normal', 0.5, 1)], background()),
    blendCase('additive-source-before-background', [layer('sourceA', 'additive', 0.5, 1)], background()),
    blendCase('multiplicative-source-before-background', [layer('sourceA', 'multiplicative', 0.5, 1)], background()),
  ];

  const output = device.createTexture({
    label: 'G11 blend mode output',
    size: [cases.length, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const module = device.createShaderModule({ code: String.raw`
struct Params { opacity : f32, coverage : f32, padding0 : f32, padding1 : f32 }
@group(0) @binding(0) var sourceTexture : texture_2d<f32>;
@group(0) @binding(1) var sourceSampler : sampler;
@group(0) @binding(2) var<uniform> params : Params;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let straight = textureSampleLevel(sourceTexture, sourceSampler, vec2<f32>(0.5), 0.0);
  let alpha = straight.a * params.opacity * params.coverage;
  return vec4<f32>(straight.rgb * alpha, alpha);
}
` });
  const bindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ] });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipelines = Object.fromEntries(['normal', 'additive', 'multiplicative'].map(mode => [mode, device.createRenderPipeline({
    label: `G11 ${mode} premultiplied pipeline`,
    layout: pipelineLayout,
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm', blend: blendState(mode) }] },
    primitive: { topology: 'triangle-list' },
  })]));
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' });
  const layerResources = new Map();
  const resourcesFor = value => {
    const key = `${value.texture}:${value.opacity}:${value.coverage}`;
    let cached = layerResources.get(key);
    if (cached) return cached;
    const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Float32Array([value.opacity, value.coverage, 0, 0]));
    const bindGroup = device.createBindGroup({ layout: bindGroupLayout, entries: [
      { binding: 0, resource: textures[value.texture].createView() },
      { binding: 1, resource: sampler },
      { binding: 2, resource: { buffer: uniform } },
    ] });
    cached = { uniform, bindGroup };
    layerResources.set(key, cached);
    return cached;
  };

  const encoder = device.createCommandEncoder({ label: 'G11 blend readback encoder' });
  const pass = encoder.beginRenderPass({ label: 'G11 blend composition pass', colorAttachments: [{
    view: output.createView(),
    loadOp: 'clear',
    storeOp: 'store',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
  }] });
  cases.forEach((testCase, index) => {
    pass.setScissorRect(index, 0, 1, 1);
    for (const value of testCase.layers) {
      const resources = resourcesFor(value);
      pass.setPipeline(pipelines[value.mode]);
      pass.setBindGroup(0, resources.bindGroup);
      pass.draw(3);
    }
  });
  pass.end();
  const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const runtimeReadback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow: 256 }, [cases.length, 1]);
  encoder.copyTextureToBuffer({ texture: runtimeTexture }, { buffer: runtimeReadback, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange()).slice(0, cases.length * 4);
  const evidence = cases.map((testCase, index) => {
    const expected = expectedBytes(testCase.layers, samples);
    const actual = [...bytes.slice(index * 4, index * 4 + 4)];
    const maximumError = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel])));
    if (maximumError > 2) throw new Error(`${testCase.id} mismatch: ${actual} vs ${expected}.`);
    return { id: testCase.id, expected, actual, maximumError };
  });
  await runtimeReadback.mapAsync(GPUMapMode.READ);
  const runtimeUploadBytes = [...new Uint8Array(runtimeReadback.getMappedRange()).slice(0, 4)];
  const runtimeUploadExpected = [96, 40, 180, 48];
  if (runtimeUploadBytes.some((value, index) => Math.abs(value - runtimeUploadExpected[index]) > 1)) {
    throw new Error(`Runtime external-image bytes are not straight-alpha display bytes: ${runtimeUploadBytes} vs ${runtimeUploadExpected}.`);
  }
  readback.unmap();
  readback.destroy();
  runtimeReadback.unmap();
  runtimeReadback.destroy();
  output.destroy();
  runtimeTexture.destroy();
  runtimeBitmap.close();
  for (const value of Object.values(textures)) value.destroy();
  for (const value of layerResources.values()) value.uniform.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncaptured.length > 0) throw new Error(`WebGPU validation failed: ${validationError?.message ?? uncaptured.join('; ')}`);
  const report = {
    status: 'passed',
    suite: 'deformable-blend-composition-texture-readback',
    caseCount: evidence.length,
    modes: ['normal', 'additive', 'multiplicative'],
    textureCount: Object.keys(samples).length,
    runtimeExternalImageUpload: { expected: runtimeUploadExpected, actual: runtimeUploadBytes },
    strictValidation: true,
    cases: evidence,
  };
  result.dataset.status = 'passed';
  result.textContent = JSON.stringify(report);
  progress.textContent = 'complete';
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  progress.textContent = 'failed';
}

function layer(texture, mode, opacity, coverage) { return { texture, mode, opacity, coverage }; }
function background() { return layer('background', 'normal', 1, 1); }
function blendCase(id, prefix, foreground) { return { id, layers: [...prefix, foreground] }; }

function createTexture(device, id, rgba) {
  const texture = device.createTexture({
    label: `G11 ${id}`,
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

function blendState(mode) {
  if (mode === 'additive') return {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  if (mode === 'multiplicative') return {
    color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  };
  return {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };
}

function expectedBytes(layers, samples) {
  let destination = [0, 0, 0, 0];
  for (const value of layers) {
    const bytes = samples[value.texture];
    const source = bytes.map(channel => channel / 255);
    const alpha = source[3] * value.opacity * value.coverage;
    const premultiplied = source.slice(0, 3).map(channel => channel * alpha);
    if (value.mode === 'normal') destination = [
      ...premultiplied.map((channel, index) => channel + destination[index] * (1 - alpha)),
      alpha + destination[3] * (1 - alpha),
    ];
    if (value.mode === 'additive') destination = [
      ...premultiplied.map((channel, index) => channel + destination[index]),
      destination[3],
    ];
    if (value.mode === 'multiplicative') destination = [
      ...premultiplied.map((channel, index) => channel * destination[index] + destination[index] * (1 - alpha)),
      destination[3],
    ];
    destination = destination.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255) / 255);
  }
  return destination.map(channel => Math.round(channel * 255));
}
