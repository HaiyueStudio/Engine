const progress = document.querySelector('#progress');
const result = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available.');

  const first = await adapter.requestDevice();
  const firstRun = await runDevice(first, ['primary-view', 'second-view', 'resized-view']);
  first.destroy();
  const recoveryAdapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!recoveryAdapter) throw new Error('No WebGPU adapter is available for device recovery.');
  const recovered = await recoveryAdapter.requestDevice();
  const recoveryRun = await runDevice(recovered, ['device-recovery']);
  recovered.destroy();

  const report = {
    status: 'passed',
    suite: 'deformable-culling-texture-readback',
    frontFace: 'ccw',
    sourceFrontFace: 'ccw',
    strictValidation: true,
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

async function runDevice(device, passes) {
  const uncaptured = [];
  device.addEventListener('uncapturederror', event => uncaptured.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code: String.raw`
struct Params { scale : vec2<f32>, reverse : f32, padding : f32 }
@group(0) @binding(0) var<uniform> params : Params;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> @builtin(position) vec4<f32> {
  let source = array<vec2<f32>, 3>(vec2<f32>(-0.8, -0.8), vec2<f32>(0.8, -0.8), vec2<f32>(0.0, 0.8));
  var index = vertexIndex;
  if (params.reverse > 0.5 && vertexIndex > 0u) { index = 3u - vertexIndex; }
  return vec4<f32>(source[index] * params.scale, 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.8, 0.25, 0.5, 0.75); }
@fragment fn fs_mask() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
` });
  const bindGroupLayout = device.createBindGroupLayout({ entries: [{
    binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' },
  }] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipelines = new Map();
  const pipelineFor = (kind, blend, culling) => {
    const key = `${kind}:${blend}:${culling ? 'back:ccw' : 'none:ccw'}`;
    let pipeline = pipelines.get(key);
    if (pipeline) return pipeline;
    pipeline = device.createRenderPipeline({
      label: `G14 ${key}`,
      layout,
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: kind === 'mask' ? 'fs_mask' : 'fs_main', targets: [{ format: 'rgba8unorm', blend: blendState(blend) }] },
      primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: culling ? 'back' : 'none' },
    });
    pipelines.set(key, pipeline);
    return pipeline;
  };
  const cases = [
    drawCase('main-normal-source-ccw-on', 'main', 'normal', true, false, [1, 1], true),
    drawCase('main-normal-source-cw-on', 'main', 'normal', true, true, [1, 1], false),
    drawCase('main-normal-source-cw-off', 'main', 'normal', false, true, [1, 1], true),
    drawCase('main-additive-source-ccw-on', 'main', 'additive', true, false, [1, 1], true),
    drawCase('main-multiplicative-source-ccw-on', 'main', 'multiplicative', true, false, [1, 1], true),
    drawCase('mask-source-ccw-on', 'mask', 'normal', true, false, [1, 1], true),
    drawCase('mask-source-cw-on', 'mask', 'normal', true, true, [1, 1], false),
    drawCase('mask-source-cw-off', 'mask', 'normal', false, true, [1, 1], true),
    drawCase('negative-x-on', 'main', 'normal', true, false, [-1, 1], false),
    drawCase('negative-x-off', 'main', 'normal', false, false, [-1, 1], true),
    drawCase('negative-y-on', 'main', 'normal', true, false, [1, -1], false),
    drawCase('negative-xy-on', 'main', 'normal', true, false, [-1, -1], true),
  ];
  const evidence = [];
  const cacheCounts = [];
  for (let passIndex = 0; passIndex < passes.length; passIndex++) {
    const cell = passIndex === 2 ? 16 : 8;
    const run = await renderCases(device, bindGroupLayout, pipelineFor, cases, cell);
    evidence.push({ id: passes[passIndex], cellSize: cell, cases: run });
    cacheCounts.push(pipelines.size);
  }
  if (cacheCounts.some(count => count !== cacheCounts[0])) throw new Error(`Pipeline cache grew across view/resize replay: ${cacheCounts}.`);
  const validationError = await device.popErrorScope();
  if (validationError || uncaptured.length > 0) throw new Error(`WebGPU validation failed: ${validationError?.message ?? uncaptured.join('; ')}`);
  return { passCount: passes.length, caseCount: cases.length, pipelineCount: pipelines.size, cacheCounts, evidence };
}

async function renderCases(device, bindGroupLayout, pipelineFor, cases, cellSize) {
  const width = cases.length * cellSize;
  const height = cellSize;
  const texture = device.createTexture({
    label: `G14 culling output ${width}x${height}`,
    size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const resources = cases.map(testCase => {
    const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, new Float32Array([...testCase.scale, testCase.reverse ? 1 : 0, 0]));
    return { buffer, bindGroup: device.createBindGroup({ layout: bindGroupLayout, entries: [{ binding: 0, resource: { buffer } }] }) };
  });
  const encoder = device.createCommandEncoder({ label: 'G14 culling readback encoder' });
  const pass = encoder.beginRenderPass({ colorAttachments: [{
    view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
  }] });
  cases.forEach((testCase, index) => {
    pass.setViewport(index * cellSize, 0, cellSize, cellSize, 0, 1);
    pass.setScissorRect(index * cellSize, 0, cellSize, cellSize);
    pass.setPipeline(pipelineFor(testCase.kind, testCase.blend, testCase.culling));
    pass.setBindGroup(0, resources[index].bindGroup);
    pass.draw(3);
  });
  pass.end();
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const evidence = cases.map((testCase, index) => {
    const x = index * cellSize + Math.floor(cellSize / 2);
    const y = Math.floor(cellSize / 2);
    const actual = [...bytes.slice(y * bytesPerRow + x * 4, y * bytesPerRow + x * 4 + 4)];
    const background = [26, 26, 26, 255];
    const drawn = actual.slice(0, 3).some((value, channel) => Math.abs(value - background[channel]) > 8);
    if (drawn !== testCase.expectedDrawn) throw new Error(`${testCase.id} visibility mismatch: ${actual}, expected drawn=${testCase.expectedDrawn}.`);
    return { id: testCase.id, expectedDrawn: testCase.expectedDrawn, drawn, actual };
  });
  readback.unmap();
  readback.destroy();
  texture.destroy();
  for (const resource of resources) resource.buffer.destroy();
  return evidence;
}

function drawCase(id, kind, blend, culling, reverse, scale, expectedDrawn) { return { id, kind, blend, culling, reverse, scale, expectedDrawn }; }
function blendState(mode) {
  if (mode === 'additive') return { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  if (mode === 'multiplicative') return { color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
  return { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
}
