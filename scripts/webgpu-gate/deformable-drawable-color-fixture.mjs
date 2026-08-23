const progress = document.querySelector('#progress');
const result = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const shaderCode = await fetch('/extensions/src/shaders/generated/2d-ui-animation-2d.generated.wgsl').then(response => {
    if (!response.ok) throw new Error(`Generated animation shader fetch failed: ${response.status}.`);
    return response.text();
  });
  for (const token of ['multiplyColor : vec4<f32>', 'screenColor : vec4<f32>', 'object.params.y < 0.5']) {
    if (!shaderCode.includes(token)) throw new Error(`Generated animation shader is missing ${token}.`);
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  const first = await adapter.requestDevice();
  const firstRun = await runDevice(first, shaderCode, ['primary-view', 'action-switch', 'resized-view']);
  first.destroy();
  const recoveryAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!recoveryAdapter) throw new Error('No WebGPU adapter is available for recovery.');
  const recovered = await recoveryAdapter.requestDevice();
  const recoveryRun = await runDevice(recovered, shaderCode, ['device-recovery']);
  recovered.destroy();
  const report = {
    status: 'passed',
    suite: 'deformable-drawable-color-generated-shader-readback',
    colorSpaceBoundary: 'display-encoded-rgba8unorm',
    shaderOracle: 'generated-animation-2d',
    firstRun,
    recoveryRun,
  };
  result.dataset.status = 'passed';
  result.textContent = JSON.stringify(report);
  progress.textContent = 'complete';
} catch (error) {
  result.dataset.status = 'failed';
  result.textContent = error instanceof Error ? error.stack ?? error.message : String(error);
  progress.textContent = 'failed';
}

async function runDevice(device, shaderCode, passIds) {
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: shaderCode });
  const layouts = createLayouts(device);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
  const pipelines = new Map();
  const pipelineFor = testCase => {
    const key = `${testCase.blend}:${testCase.culling ? 'back:ccw' : 'none:ccw'}`;
    let pipeline = pipelines.get(key);
    if (pipeline) return pipeline;
    pipeline = device.createRenderPipeline({
      label: `G15 ${key}`,
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ],
      }] },
      fragment: { module, entryPoint: 'fs_main_premultiplied_texture', targets: [{ format: 'rgba8unorm', blend: blendState(testCase.blend) }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: testCase.culling ? 'back' : 'none' },
    });
    pipelines.set(key, pipeline);
    return pipeline;
  };
  const camera = createUniform(device, layouts[0], identityMatrix());
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const transparent = createTexture(device, [0, 0, 0, 0]);
  const mask25 = createTexture(device, [0, 0, 0, 64]);
  const mask50 = createTexture(device, [0, 0, 0, 128]);
  const cases = colorCases();
  const resources = cases.map(testCase => createCaseResources(device, layouts, sampler, transparent, mask25, mask50, testCase));
  const vertexBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, new Float32Array([
    -1, -1, 0.5, 0.5,
    3, -1, 0.5, 0.5,
    -1, 3, 0.5, 0.5,
  ]));
  const evidence = [];
  const cacheCounts = [];
  const resourceCounts = [];
  for (let passIndex = 0; passIndex < passIds.length; passIndex++) {
    const cellSize = passIndex === 2 ? 16 : 8;
    const variant = passIndex % 2;
    for (let index = 0; index < cases.length; index++) {
      device.queue.writeBuffer(resources[index].objectBuffer, 0, objectData(cases[index], variant));
    }
    evidence.push(await renderCases(device, camera.bindGroup, vertexBuffer, pipelineFor, cases, resources, cellSize, variant, passIds[passIndex]));
    cacheCounts.push(pipelines.size);
    resourceCounts.push(resources.length * 4 + 6);
  }
  if (new Set(cacheCounts).size !== 1) throw new Error(`Color values grew the pipeline cache: ${cacheCounts}.`);
  if (new Set(resourceCounts).size !== 1) throw new Error(`Action switching changed retained GPU resource count: ${resourceCounts}.`);
  const validationError = await device.popErrorScope();
  if (validationError || uncaptured.length > 0) throw new Error(`WebGPU validation failed: ${validationError?.message ?? uncaptured.join('; ')}`);
  vertexBuffer.destroy();
  camera.buffer.destroy();
  for (const resource of resources) { resource.objectBuffer.destroy(); resource.baseTexture.destroy(); }
  transparent.destroy(); mask25.destroy(); mask50.destroy();
  return { passCount: passIds.length, caseCount: cases.length, pipelineCount: pipelines.size, cacheCounts, resourceCounts, evidence };
}

async function renderCases(device, cameraBindGroup, vertexBuffer, pipelineFor, cases, resources, cellSize, variant, id) {
  const width = cases.length * cellSize;
  const height = cellSize;
  const output = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const encoder = device.createCommandEncoder({ label: `G15 ${id}` });
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: background().map((value, index) => index === 3 ? value : value),
  }] });
  for (let index = 0; index < cases.length; index++) {
    pass.setViewport(index * cellSize, 0, cellSize, cellSize, 0, 1);
    pass.setScissorRect(index * cellSize, 0, cellSize, cellSize);
    pass.setPipeline(pipelineFor(cases[index]));
    pass.setBindGroup(0, cameraBindGroup);
    pass.setBindGroup(1, resources[index].objectBindGroup);
    pass.setBindGroup(2, resources[index].textureBindGroup);
    pass.setBindGroup(3, resources[index].compositeBindGroup);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(3);
  }
  pass.end();
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const items = cases.map((testCase, index) => {
    const x = index * cellSize + Math.floor(cellSize / 2);
    const y = Math.floor(cellSize / 2);
    const actual = [...bytes.slice(y * bytesPerRow + x * 4, y * bytesPerRow + x * 4 + 4)];
    const expected = expectedPixel(testCase, variant);
    const maximumError = Math.max(...actual.map((value, channel) => Math.abs(value - expected[channel])));
    if (maximumError > 2) throw new Error(`${id}/${testCase.id} mismatch: actual=${actual}, expected=${expected}, max=${maximumError}.`);
    return { id: testCase.id, blend: testCase.blend, culling: testCase.culling, actual, expected, maximumError };
  });
  readback.unmap(); readback.destroy(); output.destroy();
  return { id, cellSize, variant, maximumError: Math.max(...items.map(item => item.maximumError)), cases: items };
}

function createLayouts(device) {
  return [
    device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] }),
    device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] }),
    device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] }),
    device.createBindGroupLayout({ entries: [
      ...Array.from({ length: 8 }, (_, binding) => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } })),
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ] }),
  ];
}

function createCaseResources(device, layouts, sampler, transparent, mask25, mask50, testCase) {
  const objectBuffer = device.createBuffer({ size: 1296, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const objectBindGroup = device.createBindGroup({ layout: layouts[1], entries: [{ binding: 0, resource: { buffer: objectBuffer } }] });
  const baseTexture = createTexture(device, testCase.texture);
  const textureBindGroup = device.createBindGroup({ layout: layouts[2], entries: [
    { binding: 0, resource: baseTexture.createView() }, { binding: 1, resource: sampler },
  ] });
  const masks = testCase.masks?.map(mask => mask.alpha === 0.25 ? mask25 : mask50) ?? [];
  const compositeBindGroup = device.createBindGroup({ layout: layouts[3], entries: [
    ...Array.from({ length: 8 }, (_, binding) => ({ binding, resource: (masks[binding] ?? transparent).createView() })),
    { binding: 8, resource: sampler },
  ] });
  return { objectBuffer, objectBindGroup, baseTexture, textureBindGroup, compositeBindGroup };
}

function objectData(testCase, variant) {
  const data = new Float32Array(324);
  data.set(identityMatrix(), 0);
  data.set(testCase.baseColor ?? [1, 1, 1, 1], 16);
  data.set(variantColor(testCase.multiply, variant, [1, 1, 1, 1]), 20);
  data.set(variantColor(testCase.screen, variant, [0, 0, 0, 0]), 24);
  data[28] = testCase.masks?.length ?? 0;
  data[29] = testCase.outputMask ? 1 : 0;
  data.set([0, 0, 1, 1], 32);
  for (let index = 0; index < (testCase.masks?.length ?? 0); index++) {
    const mask = testCase.masks[index];
    data[36 + index * 4] = mask.inverted ? 1 : 0;
    data[36 + index * 4 + 1] = mask.operation === 'intersect' ? 2 : 0;
  }
  return data;
}

function colorCases() {
  const texture = [102, 51, 26, 128];
  const multiply = [0.5, 0.75, 0.25, 0.1];
  const screen = [0.2, 0.4, 0.6, 0.9];
  return [
    { id: 'neutral-normal', texture, blend: 'normal', culling: false },
    { id: 'multiply-only', texture, blend: 'normal', culling: false, multiply },
    { id: 'screen-only', texture, blend: 'normal', culling: false, screen },
    { id: 'combined-alpha-ignored', texture, blend: 'normal', culling: false, multiply, screen },
    { id: 'opacity-ordinary-mask-culling', texture, blend: 'normal', culling: true, multiply, screen, baseColor: [1, 1, 1, 0.5], masks: [{ alpha: 0.5 }] },
    { id: 'inverted-mask', texture, blend: 'normal', culling: false, multiply, screen, masks: [{ alpha: 0.25, inverted: true }] },
    { id: 'multi-source-mask', texture, blend: 'normal', culling: false, multiply, screen, masks: [{ alpha: 0.25 }, { alpha: 0.5 }] },
    { id: 'combined-additive', texture, blend: 'additive', culling: false, multiply, screen },
    { id: 'combined-multiplicative', texture, blend: 'multiplicative', culling: false, multiply, screen },
    { id: 'transparent-screen-edge', texture: [0, 0, 0, 0], blend: 'normal', culling: false, screen: [1, 1, 1, 1] },
    { id: 'mask-setup-skips-tint', texture, blend: 'normal', culling: false, multiply: [0, 0, 0, 0], screen: [1, 1, 1, 1], outputMask: true },
  ];
}

function expectedPixel(testCase, variant) {
  const texture = testCase.texture.map(value => value / 255);
  const base = testCase.baseColor ?? [1, 1, 1, 1];
  const multiply = variantColor(testCase.multiply, variant, [1, 1, 1, 1]);
  const screen = variantColor(testCase.screen, variant, [0, 0, 0, 0]);
  let coverage = 1;
  if (testCase.masks?.length) {
    coverage = 0;
    for (const mask of testCase.masks) {
      let next = (mask.alpha === 0.25 ? 64 : 128) / 255;
      if (mask.inverted) next = 1 - next;
      coverage = coverage + next * (1 - coverage);
    }
  }
  const rgb = texture.slice(0, 3);
  if (!testCase.outputMask) for (let index = 0; index < 3; index++) {
    rgb[index] *= multiply[index];
    rgb[index] = rgb[index] + screen[index] * texture[3] - rgb[index] * screen[index];
  }
  const source = [
    rgb[0] * base[0] * base[3] * coverage,
    rgb[1] * base[1] * base[3] * coverage,
    rgb[2] * base[2] * base[3] * coverage,
    texture[3] * base[3] * coverage,
  ];
  const destination = background();
  const composed = blendPixel(source, destination, testCase.blend);
  return composed.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255));
}

function variantColor(value, variant, fallback) {
  if (!value) return fallback;
  if (variant === 0) return value;
  return [value[2], value[0], value[1], value[3] === 0 ? 1 : 0];
}

function blendPixel(source, destination, mode) {
  if (mode === 'additive') return [source[0] + destination[0], source[1] + destination[1], source[2] + destination[2], destination[3]];
  if (mode === 'multiplicative') return [
    source[0] * destination[0] + destination[0] * (1 - source[3]),
    source[1] * destination[1] + destination[1] * (1 - source[3]),
    source[2] * destination[2] + destination[2] * (1 - source[3]),
    destination[3],
  ];
  return [
    source[0] + destination[0] * (1 - source[3]),
    source[1] + destination[1] * (1 - source[3]),
    source[2] + destination[2] * (1 - source[3]),
    source[3] + destination[3] * (1 - source[3]),
  ];
}

function blendState(mode) {
  if (mode === 'additive') return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  if (mode === 'multiplicative') return { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  return { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
}

function createUniform(device, layout, values) {
  const buffer = device.createBuffer({ size: values.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, values);
  return { buffer, bindGroup: device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer } }] }) };
}

function createTexture(device, rgba) {
  const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

function identityMatrix() {
  const value = new Float32Array(16);
  value[0] = value[5] = value[10] = value[15] = 1;
  return value;
}

function background() { return [0.125, 0.25, 0.375, 0.75]; }
