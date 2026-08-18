import {
  composeShaderModules,
  defineTypedShaderModule,
} from '/shader-language/dist/index.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  const result = await runFixture();
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = JSON.stringify({
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
  });
  resultNode.dataset.status = 'failed';
}

async function runFixture() {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => {
    uncapturedErrors.push(event.error?.message ?? String(event.error));
  });
  device.pushErrorScope('validation');

  const positionClip = { dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'clip' };
  const colorLinear = { dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' };
  const typed = defineTypedShaderModule({
    id: 'fixture.stage2-webgpu',
    entries: [
      {
        id: 'vertexMain',
        stage: 'vertex',
        name: 'vertexMain',
        inputs: [{ id: 'position', type: positionClip, location: 0 }],
        output: { type: positionClip, builtin: 'position' },
        build: (_builder, inputs) => inputs.position,
      },
      {
        id: 'fragmentMain',
        stage: 'fragment',
        name: 'fragmentMain',
        output: { type: colorLinear, location: 0 },
        build: builder => builder.literal(colorLinear, [0.2, 0.8, 0.4, 1], {
          sourceId: 'stage2.webgpu.fragment-color',
          sourceName: 'shader-language-stage2-fixture.mjs',
          line: 52,
        }),
      },
    ],
  });
  const composition = composeShaderModules({ label: 'shader-language-stage2-webgpu', entry: typed.module });
  progressNode.textContent = 'compiling generated WGSL…';
  const shader = device.createShaderModule({ label: composition.label, code: composition.code });
  const compilationInfo = await shader.getCompilationInfo();
  const compilationErrors = compilationInfo.messages
    .filter(message => message.type === 'error')
    .map(message => `${message.lineNum}:${message.linePos} ${message.message}`);
  if (compilationErrors.length > 0) throw new Error(`Generated WGSL failed:\n${compilationErrors.join('\n')}`);

  const pipeline = await device.createRenderPipelineAsync({
    label: 'shader-language-stage2-pipeline',
    layout: 'auto',
    vertex: {
      module: shader,
      entryPoint: 'vertexMain',
      buffers: [{
        arrayStride: 16,
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
      }],
    },
    fragment: {
      module: shader,
      entryPoint: 'fragmentMain',
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });

  const vertices = new Float32Array([
    -1, -1, 0, 1,
    3, -1, 0, 1,
    -1, 3, 0, 1,
  ]);
  const vertexBuffer = device.createBuffer({
    label: 'shader-language-stage2-vertices',
    size: vertices.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);
  const width = 16;
  const height = 16;
  const texture = device.createTexture({
    label: 'shader-language-stage2-target',
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = 256;
  const readback = device.createBuffer({
    label: 'shader-language-stage2-readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    [width, height],
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const centerOffset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
  const centerPixel = [...bytes.slice(centerOffset, centerOffset + 4)];
  readback.unmap();

  vertexBuffer.destroy();
  texture.destroy();
  readback.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  const expected = [51, 204, 102, 255];
  const pixelDelta = centerPixel.map((value, index) => Math.abs(value - expected[index]));
  if (pixelDelta.some(value => value > 1)) {
    throw new Error(`Unexpected center pixel ${centerPixel.join(',')}; expected ${expected.join(',')}.`);
  }
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage2-webgpu',
    status: 'passed',
    canonicalHash: typed.ir.canonicalHash,
    compositionHash: composition.irHash,
    moduleIds: composition.moduleIds,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    centerPixel,
    expectedPixel: expected,
    pixelDelta,
  };
}
