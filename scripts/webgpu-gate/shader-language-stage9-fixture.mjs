import { BUILTIN_RENDER_SHADER_ARTIFACT as ENGINE_2D_UI } from '/engine/dist/internal/2d-ui-shader-artifact.js';
import { BUILTIN_RENDER_SHADER_ARTIFACT as EXTENSIONS_2D_UI } from '/extensions/dist/internal/2d-ui-shader-artifact.js';
import { BUILTIN_RENDER_SHADER_ARTIFACT as SIMPLE_3D } from '/engine/dist/internal/simple3d-shader-artifact.js';
import { getPrecompiledShaderPassRuntime } from '/engine/dist/internal/precompiled-shader-runtime.js';

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
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  const counts = { shaderModules: 0, rendererLayouts: 0, pipelineLayouts: 0 };
  const trackedDevice = new Proxy(device, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'createShaderModule') return descriptor => {
        counts.shaderModules++;
        return target.createShaderModule(descriptor);
      };
      if (property === 'createBindGroupLayout') return descriptor => {
        counts.rendererLayouts++;
        return target.createBindGroupLayout(descriptor);
      };
      if (property === 'createPipelineLayout') return descriptor => {
        counts.pipelineLayouts++;
        return target.createPipelineLayout(descriptor);
      };
      return value.bind(target);
    },
  });

  const families = [
    ['engine-2d-ui', ENGINE_2D_UI],
    ['components-2d-ui', EXTENSIONS_2D_UI],
    ['simple-3d', SIMPLE_3D],
  ];
  const compilationErrors = [];
  const runtimes = new Map();
  let passCount = 0;
  let reflectedBindingCount = 0;
  for (const [familyId, artifact] of families) {
    if (artifact.version !== 2 || artifact.compilerVersion !== 'shader-language-stage9') {
      throw new Error(`${familyId} has invalid artifact identity`);
    }
    for (const [passId, pass] of Object.entries(artifact.passes)) {
      passCount++;
      const layouts = pass.bindGroups.map(group => {
        const entries = group.bindings.map(bindingEntry);
        if (
          familyId === 'simple-3d'
          && pass.passRequirements.includes('world-space-clipping')
          && group.physicalGroup === 1
          && !entries.some(entry => entry.binding === 1)
        ) {
          entries.push({
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'read-only-storage' },
          });
        }
        reflectedBindingCount += entries.length;
        return trackedDevice.createBindGroupLayout({
          label: `stage9.${familyId}.${passId}.group${group.physicalGroup}`,
          entries,
        });
      });
      const runtime = getPrecompiledShaderPassRuntime(trackedDevice, artifact, passId, {
        rendererOwnedLayouts: Object.fromEntries(layouts.map((layout, index) => [index, layout])),
      });
      const info = await runtime.module.getCompilationInfo();
      const passCompilationErrors = [];
      for (const message of info.messages) {
        if (message.type === 'error') {
          const diagnostic = `${familyId}/${passId}:${message.lineNum}:${message.linePos} ${message.message}`;
          compilationErrors.push(diagnostic);
          passCompilationErrors.push(diagnostic);
        }
      }
      if (passCompilationErrors.length > 0) {
        throw new Error(`Generated shader compilation failed:\n${passCompilationErrors.join('\n')}`);
      }
      await trackedDevice.createRenderPipelineAsync({
        label: `shader-language-stage9-${familyId}-${passId}`,
        layout: runtime.pipelineLayout,
        vertex: {
          module: runtime.module,
          entryPoint: runtime.pass.entryPoints.vertex,
          buffers: runtime.pass.vertexBuffers.map(buffer => ({
            arrayStride: buffer.arrayStride,
            stepMode: buffer.stepMode,
            attributes: buffer.attributes.map(attribute => ({
              shaderLocation: attribute.shaderLocation,
              offset: attribute.offset,
              format: attribute.format,
            })),
          })),
        },
        fragment: {
          module: runtime.module,
          entryPoint: runtime.pass.entryPoints.fragment,
          targets: runtime.pass.renderTargets.map(() => ({ format: 'rgba8unorm' })),
        },
        primitive: { topology: 'triangle-list' },
      });
      runtimes.set(`${familyId}/${passId}`, { runtime, layouts });
    }
  }
  if (compilationErrors.length > 0) throw new Error(`Generated production WGSL failed:\n${compilationErrors.join('\n')}`);

  const pixel = await renderTilemapPixel(trackedDevice, runtimes.get('components-2d-ui/tilemap2d'));
  const expectedPixel = [32, 191, 64, 255];
  const pixelDelta = pixel.map((value, index) => Math.abs(value - expectedPixel[index]));
  if (pixelDelta.some(value => value > 1)) {
    throw new Error(`Unexpected generated tilemap pixel ${pixel.join(',')}; expected ${expectedPixel.join(',')}.`);
  }
  const { main: animationPixel, effect: animationEffectPixel } = await renderAnimation2dPixel(trackedDevice, runtimes.get('components-2d-ui/animation-2d'));
  const expectedAnimationPixel = [96, 0, 159, 96];
  const animationPixelDelta = animationPixel.map((value, index) => Math.abs(value - expectedAnimationPixel[index]));
  if (animationPixelDelta.some(value => value > 2)) {
    throw new Error(`Unexpected generated Animation2D pixel ${animationPixel.join(',')}; expected ${expectedAnimationPixel.join(',')}.`);
  }
  const expectedAnimationEffectPixel = [255, 255, 0, 255];
  const animationEffectPixelDelta = animationEffectPixel.map((value, index) => Math.abs(value - expectedAnimationEffectPixel[index]));
  if (animationEffectPixelDelta.some(value => value > 2)) {
    throw new Error(`Unexpected generated Animation2D effect pixel ${animationEffectPixel.join(',')}; expected ${expectedAnimationEffectPixel.join(',')}.`);
  }

  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage9-builtin-render',
    status: 'passed',
    artifactVersion: 2,
    compilerVersion: 'shader-language-stage9',
    familyCount: families.length,
    passCount,
    reflectedBindingCount,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    centerPixel: pixel,
    expectedPixel,
    pixelDelta,
    animationPixel,
    expectedAnimationPixel,
    animationPixelDelta,
    animationEffectPixel,
    expectedAnimationEffectPixel,
    animationEffectPixelDelta,
    cache: counts,
  };
}

async function renderAnimation2dPixel(device, materialized) {
  if (!materialized) throw new Error('Missing components animation-2d runtime');
  const { runtime, layouts } = materialized;
  const identity = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const object = device.createBuffer({ size: 1264, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const objectData = new Float32Array(316);
  objectData.set(identity, 0);
  objectData.set([1, 1, 1, 1], 16);
  objectData[20] = 2;
  objectData.set([0, 0, 1, 1], 24);
  objectData.set([2, 0, 0, 0], 28); // luma add
  objectData.set([0, 1, 0, 0], 32); // alpha subtract
  objectData.set([1, 2, 0.5, 0], 68); // linear, two stops, 50% paint opacity
  objectData.set([-1, 0, 1, 0], 72);
  objectData.set([1, 0, 0, 1], 76);
  objectData.set([0, 0, 1, 1], 80);
  objectData.set([0, 1, 0, 0], 108);
  objectData[116] = 1; // tint
  objectData.set([0, 0, 1, 1, 1, 0, 1], 124); // black=blue, white=yellow, amount=1
  device.queue.writeBuffer(camera, 0, identity);
  device.queue.writeBuffer(object, 0, objectData);
  const cameraGroup = device.createBindGroup({ layout: layouts[0], entries: [{ binding: 0, resource: { buffer: camera } }] });
  const objectGroup = device.createBindGroup({ layout: layouts[1], entries: [{ binding: 0, resource: { buffer: object } }] });
  const sampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  const white = solidTexture(device, [255, 255, 255, 255]);
  const subtract = solidTexture(device, [0, 0, 0, 64]);
  const baseGroup = device.createBindGroup({
    layout: layouts[2],
    entries: [{ binding: 0, resource: white.createView() }, { binding: 1, resource: sampler }],
  });
  const compositeGroup = device.createBindGroup({
    layout: layouts[3],
    entries: [
      ...Array.from({ length: 8 }, (_, binding) => ({
        binding,
        resource: (binding === 1 ? subtract : white).createView(),
      })),
      { binding: 8, resource: sampler },
    ],
  });
  const vertices = new Float32Array([
    -1, -1, 0, 0,
     3, -1, 2, 0,
    -1,  3, 0, 2,
  ]);
  const vertex = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertex, 0, vertices);
  const target = device.createTexture({
    size: [4, 4], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const effectTarget = device.createTexture({
    size: [4, 4], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const effectReadback = device.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: {
      module: runtime.module,
      entryPoint: runtime.pass.entryPoints.vertex,
      buffers: [{
        arrayStride: 16,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x2' },
        ],
      }],
    },
    fragment: { module: runtime.module, entryPoint: runtime.pass.entryPoints.fragment, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, cameraGroup);
  pass.setBindGroup(1, objectGroup);
  pass.setBindGroup(2, baseGroup);
  pass.setBindGroup(3, compositeGroup);
  pass.setVertexBuffer(0, vertex);
  pass.draw(3);
  pass.end();
  const effectPipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: { module: runtime.module, entryPoint: 'vs_effect' },
    fragment: { module: runtime.module, entryPoint: 'fs_effect', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const effectPass = encoder.beginRenderPass({
    colorAttachments: [{ view: effectTarget.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  effectPass.setPipeline(effectPipeline);
  effectPass.setBindGroup(0, cameraGroup);
  effectPass.setBindGroup(1, objectGroup);
  effectPass.setBindGroup(2, baseGroup);
  effectPass.setBindGroup(3, compositeGroup);
  effectPass.draw(3, 1, 0, 0);
  effectPass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
  encoder.copyTextureToBuffer({ texture: effectTarget }, { buffer: effectReadback, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const pixel = [...bytes.slice(2 * 256 + 2 * 4, 2 * 256 + 2 * 4 + 4)];
  readback.unmap();
  await effectReadback.mapAsync(GPUMapMode.READ);
  const effectBytes = new Uint8Array(effectReadback.getMappedRange());
  const effectPixel = [...effectBytes.slice(2 * 256 + 2 * 4, 2 * 256 + 2 * 4 + 4)];
  effectReadback.unmap();
  camera.destroy(); object.destroy(); vertex.destroy(); target.destroy(); readback.destroy();
  effectTarget.destroy(); effectReadback.destroy(); white.destroy(); subtract.destroy();
  return { main: pixel, effect: effectPixel };
}

function solidTexture(device, rgba) {
  const texture = device.createTexture({
    size: [1, 1], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

function bindingEntry(binding) {
  const entry = {
    binding: binding.binding,
    visibility: binding.visibility.reduce((mask, stage) => mask | ({
      vertex: GPUShaderStage.VERTEX,
      fragment: GPUShaderStage.FRAGMENT,
      compute: GPUShaderStage.COMPUTE,
    })[stage], 0),
  };
  const layout = binding.layout;
  if (layout.kind === 'buffer') {
    entry.buffer = {
      type: layout.bufferType,
      hasDynamicOffset: layout.hasDynamicOffset,
      minBindingSize: layout.minBindingSize,
    };
  } else if (layout.kind === 'texture') {
    entry.texture = {
      sampleType: layout.sampleType,
      viewDimension: layout.viewDimension,
      multisampled: layout.multisampled,
    };
  } else if (layout.kind === 'sampler') {
    entry.sampler = { type: layout.samplerType };
  } else if (layout.kind === 'storage-texture') {
    entry.storageTexture = {
      access: layout.access,
      format: layout.format,
      viewDimension: layout.viewDimension,
    };
  } else {
    entry.externalTexture = {};
  }
  return entry;
}

async function renderTilemapPixel(device, materialized) {
  if (!materialized) throw new Error('Missing components tilemap2d runtime');
  const { runtime, layouts } = materialized;
  const identity = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const camera = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const object = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(camera, 0, identity);
  device.queue.writeBuffer(object, 0, identity);
  const cameraGroup = device.createBindGroup({
    layout: layouts[0], entries: [{ binding: 0, resource: { buffer: camera } }],
  });
  const objectGroup = device.createBindGroup({
    layout: layouts[1], entries: [{ binding: 0, resource: { buffer: object } }],
  });
  const vertices = new Float32Array([
    -1, -1, 0.125, 0.75, 0.25, 1,
     3, -1, 0.125, 0.75, 0.25, 1,
    -1,  3, 0.125, 0.75, 0.25, 1,
  ]);
  const vertex = device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(vertex, 0, vertices);
  const target = device.createTexture({
    size: [4, 4], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: target.createView(),
      loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  const pipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: {
      module: runtime.module,
      entryPoint: runtime.pass.entryPoints.vertex,
      buffers: [{
        arrayStride: 24,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x2' },
          { shaderLocation: 1, offset: 8, format: 'float32x4' },
        ],
      }],
    },
    fragment: {
      module: runtime.module,
      entryPoint: runtime.pass.entryPoints.fragment,
      targets: [{ format: 'rgba8unorm' }],
    },
    primitive: { topology: 'triangle-list' },
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, cameraGroup);
  pass.setBindGroup(1, objectGroup);
  pass.setVertexBuffer(0, vertex);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: target }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 4 }, [4, 4],
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const pixel = [...bytes.slice(2 * 256 + 2 * 4, 2 * 256 + 2 * 4 + 4)];
  readback.unmap();
  camera.destroy();
  object.destroy();
  vertex.destroy();
  target.destroy();
  readback.destroy();
  return pixel;
}
