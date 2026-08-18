import {
  compileShaderIrProgramToGlslEs300,
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
  const typed = createFixtureProgram();
  const wgsl = composeShaderModules({ label: 'stage14-dual-backend-wgsl', entry: typed.module });
  const glsl = compileShaderIrProgramToGlslEs300(typed.ir);
  const sourcePixel = [128, 64, 32, 255];
  const tint = [0.8, 0.6, 1, 1];
  const expectedPixel = [
    Math.round(srgbToLinear(sourcePixel[0] / 255) * tint[0] * 255),
    Math.round(srgbToLinear(sourcePixel[1] / 255) * tint[1] * 255),
    Math.round(srgbToLinear(sourcePixel[2] / 255) * tint[2] * 255),
    255,
  ];

  progressNode.textContent = 'executing WebGPU/WGSL…';
  const webgpu = await runWebGpu(wgsl, sourcePixel, tint);
  progressNode.textContent = 'executing WebGL2/GLSL ES 3.00…';
  const webgl2 = runWebGl2(glsl, sourcePixel, tint);
  const crossBackendDelta = webgpu.centerPixel.map((value, index) => Math.abs(value - webgl2.centerPixel[index]));
  const webgpuExpectedDelta = webgpu.centerPixel.map((value, index) => Math.abs(value - expectedPixel[index]));
  const webgl2ExpectedDelta = webgl2.centerPixel.map((value, index) => Math.abs(value - expectedPixel[index]));
  if (crossBackendDelta.some(value => value > 1)) throw new Error(`Cross-backend pixel delta ${crossBackendDelta.join(',')} exceeds 1.`);
  if (webgpuExpectedDelta.some(value => value > 1) || webgl2ExpectedDelta.some(value => value > 1)) {
    throw new Error(`Unexpected pixels: WebGPU=${webgpu.centerPixel}, WebGL2=${webgl2.centerPixel}, expected=${expectedPixel}.`);
  }
  if (webgpu.validationErrorCount !== 0 || webgpu.compilationErrorCount !== 0 || webgl2.compileErrorCount !== 0 || webgl2.linkErrorCount !== 0) {
    throw new Error('Dual-backend validation contains compilation, link, or validation errors.');
  }

  return {
    schemaVersion: 1,
    suite: 'shader-language-stage14-dual-backend',
    status: 'passed',
    productRendererContract: 'webgpu-only-unchanged',
    canonicalHash: typed.ir.canonicalHash,
    wgslCompositionHash: wgsl.irHash,
    glslBackendHash: glsl.backendHash,
    glslEntryCount: glsl.entries.length,
    glslUniformBlockCount: glsl.uniformBlocks.length,
    glslCombinedSamplerCount: glsl.sampledTextures.length,
    expectedPixel,
    webgpu,
    webgl2,
    crossBackendDelta,
    webgpuExpectedDelta,
    webgl2ExpectedDelta,
    unclassifiedFailureCount: 0,
  };
}

function createFixtureProgram() {
  const positionClip = { dataType: 'vec4<f32>', semantic: 'position', coordinateSpace: 'clip' };
  const uvScreen = { dataType: 'vec2<f32>', semantic: 'uv', coordinateSpace: 'screen' };
  const colorLinear = { dataType: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' };
  return defineTypedShaderModule({
    id: 'fixture.stage14-dual-backend',
    resources: [
      {
        id: 'material.params', space: 'material', kind: 'uniform-buffer', visibility: ['fragment'],
        fields: [{ id: 'tint', type: 'vec4<f32>', semantic: 'color', colorSpace: 'linear' }],
      },
      {
        id: 'material.sourceTexture', space: 'material', kind: 'texture', visibility: ['fragment'],
        valueType: 'texture_2d<f32>', colorSpace: 'srgb',
      },
      {
        id: 'material.sourceSampler', space: 'material', kind: 'sampler', visibility: ['fragment'], valueType: 'sampler',
      },
    ],
    entries: [
      {
        id: 'vertexMain', stage: 'vertex', name: 'vertexMain',
        inputs: [{ id: 'position', type: positionClip, location: 0 }],
        output: { type: positionClip, builtin: 'position' },
        build: (_builder, inputs) => inputs.position,
      },
      {
        id: 'fragmentMain', stage: 'fragment', name: 'fragmentMain',
        output: { type: colorLinear, location: 0 },
        build: builder => {
          const uv = builder.literal(uvScreen, [0.5, 0.5]);
          const sampled = builder.textureSample('material.sourceTexture', 'material.sourceSampler', uv, {
            source: { sourceId: 'stage14.sample', sourceName: 'shader-language-stage14-fixture.mjs', line: 104 },
          });
          return builder.multiply(
            builder.srgbToLinear(sampled),
            builder.uniformField('material.params', 'tint'),
          );
        },
      },
    ],
  });
}

async function runWebGpu(composition, sourcePixel, tint) {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  const shader = device.createShaderModule({ label: 'stage14-generated-wgsl', code: composition.code });
  const compilationInfo = await shader.getCompilationInfo();
  const compilationErrors = compilationInfo.messages.filter(message => message.type === 'error').map(message => message.message);
  if (compilationErrors.length) throw new Error(`WGSL compilation failed: ${compilationErrors.join('; ')}`);
  const pipeline = await device.createRenderPipelineAsync({
    label: 'stage14-webgpu-pipeline', layout: 'auto',
    vertex: {
      module: shader, entryPoint: 'vertexMain',
      buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
    },
    fragment: { module: shader, entryPoint: 'fragmentMain', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });

  const vertices = new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]);
  const vertexBuffer = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertexBuffer, 0, vertices);
  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(uniformBuffer, 0, new Float32Array(tint));
  const sourceTexture = device.createTexture({
    size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: sourceTexture }, new Uint8Array(sourcePixel), { bytesPerRow: 4 }, [1, 1]);
  const sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const bindingById = new Map(composition.reflection.resources.map(resource => [resource.id, resource]));
  const materialGroup = bindingById.get('material.params').group;
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(materialGroup),
    entries: [
      { binding: bindingById.get('material.params').binding, resource: { buffer: uniformBuffer } },
      { binding: bindingById.get('material.sourceTexture').binding, resource: sourceTexture.createView() },
      { binding: bindingById.get('material.sourceSampler').binding, resource: sampler },
    ],
  });

  const width = 16;
  const height = 16;
  const target = device.createTexture({
    size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = 256;
  const readback = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(materialGroup, bindGroup);
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readback.getMappedRange());
  const offset = Math.floor(height / 2) * bytesPerRow + Math.floor(width / 2) * 4;
  const centerPixel = [...mapped.slice(offset, offset + 4)];
  readback.unmap();

  const validationError = await device.popErrorScope();
  vertexBuffer.destroy();
  uniformBuffer.destroy();
  sourceTexture.destroy();
  target.destroy();
  readback.destroy();
  device.destroy();
  if (validationError || uncapturedErrors.length) throw new Error(`WebGPU validation failed: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  return { available: true, compilationErrorCount: compilationErrors.length, validationErrorCount: 0, centerPixel };
}

function runWebGl2(compilation, sourcePixel, tint) {
  const canvas = new OffscreenCanvas(16, 16);
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 is unavailable');
  gl.disable(gl.DITHER);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  const vertexSource = compilation.entries.find(entry => entry.stage === 'vertex').code;
  const fragmentSource = compilation.entries.find(entry => entry.stage === 'fragment').code;
  const vertexShader = compileGlShader(gl, gl.VERTEX_SHADER, vertexSource, 'vertex');
  const fragmentShader = compileGlShader(gl, gl.FRAGMENT_SHADER, fragmentSource, 'fragment');
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`GLSL link failed: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);

  const vertices = new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);

  const block = compilation.uniformBlocks[0];
  const uniformBuffer = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
  gl.bufferData(gl.UNIFORM_BUFFER, block.layout.byteSize, gl.DYNAMIC_DRAW);
  gl.bufferSubData(gl.UNIFORM_BUFFER, block.layout.fields[0].offset, new Float32Array(tint));
  gl.bindBufferBase(gl.UNIFORM_BUFFER, block.binding, uniformBuffer);
  const blockIndex = gl.getUniformBlockIndex(program, block.blockName);
  if (blockIndex === gl.INVALID_INDEX) throw new Error(`Missing GLSL uniform block ${block.blockName}.`);
  gl.uniformBlockBinding(program, blockIndex, block.binding);

  const sampled = compilation.sampledTextures[0];
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + sampled.textureUnit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(sourcePixel));
  gl.uniform1i(gl.getUniformLocation(program, sampled.uniformName), sampled.textureUnit);

  gl.viewport(0, 0, 16, 16);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const centerPixel = new Uint8Array(4);
  gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, centerPixel);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`WebGL2 error 0x${error.toString(16)}.`);
  gl.deleteTexture(texture);
  gl.deleteBuffer(uniformBuffer);
  gl.deleteBuffer(vertexBuffer);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return { available: true, compileErrorCount: 0, linkErrorCount: 0, centerPixel: [...centerPixel] };
}

function compileGlShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${label} GLSL compilation failed: ${gl.getShaderInfoLog(shader)}\n${source}`);
  return shader;
}

function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
