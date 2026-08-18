import { SPECIALIZED_RENDERING_SHADER_ARTIFACT } from '/engine/dist/internal/specialized-rendering-shader-artifact.js';
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
  resultNode.textContent = JSON.stringify({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
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
  if (SPECIALIZED_RENDERING_SHADER_ARTIFACT.version !== 2
    || SPECIALIZED_RENDERING_SHADER_ARTIFACT.compilerVersion !== 'shader-language-stage12') {
    throw new Error('Invalid specialized-rendering artifact identity');
  }

  const counts = { shaderModules: 0, bindGroupLayouts: 0, pipelineLayouts: 0 };
  const trackedDevice = new Proxy(device, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'createShaderModule') return descriptor => {
        counts.shaderModules++;
        return target.createShaderModule(descriptor);
      };
      if (property === 'createBindGroupLayout') return descriptor => {
        counts.bindGroupLayouts++;
        return target.createBindGroupLayout(descriptor);
      };
      if (property === 'createPipelineLayout') return descriptor => {
        counts.pipelineLayouts++;
        return target.createPipelineLayout(descriptor);
      };
      return value.bind(target);
    },
  });

  const runtimes = new Map();
  const compilationErrors = [];
  const moduleHashes = new Set();
  let renderPassCount = 0;
  let computePassCount = 0;
  for (const [passId, pass] of Object.entries(SPECIALIZED_RENDERING_SHADER_ARTIFACT.passes)) {
    const moduleHash = pass.code.match(/haiyue:specialized-rendering-module ([a-f0-9]{64})/)?.[1];
    if (!moduleHash) throw new Error(`${passId} is missing specialized-rendering module provenance`);
    moduleHashes.add(moduleHash);
    const rendererGroups = pass.bindGroups.filter(group => group.owner === 'renderer');
    const rendererOwnedLayouts = Object.fromEntries(rendererGroups.map(group => {
      const entries = group.bindings.map(bindingEntry);
      if (
        pass.passRequirements.includes('world-space-clipping')
        && group.physicalGroup === 1
        && !entries.some(entry => entry.binding === 1)
      ) {
        entries.push({
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        });
      }
      return [
        group.physicalGroup,
        trackedDevice.createBindGroupLayout({
          label: `stage12.${passId}.group${group.physicalGroup}`,
          entries,
        }),
      ];
    }));
    const runtime = getPrecompiledShaderPassRuntime(
      trackedDevice,
      SPECIALIZED_RENDERING_SHADER_ARTIFACT,
      passId,
      { rendererOwnedLayouts },
    );
    const info = await runtime.module.getCompilationInfo();
    for (const message of info.messages) {
      if (message.type === 'error') compilationErrors.push(`${passId}:${message.lineNum}:${message.linePos} ${message.message}`);
    }
    if (runtime.pass.entryPoints.compute) {
      await trackedDevice.createComputePipelineAsync({
        label: `stage12-${passId}`,
        layout: runtime.pipelineLayout,
        compute: { module: runtime.module, entryPoint: runtime.pass.entryPoints.compute },
      });
      computePassCount++;
    } else {
      await trackedDevice.createRenderPipelineAsync({
        label: `stage12-${passId}`,
        layout: runtime.pipelineLayout,
        vertex: {
          module: runtime.module,
          entryPoint: runtime.pass.entryPoints.vertex,
          buffers: runtime.pass.vertexBuffers.map(vertexBufferLayout),
        },
        fragment: {
          module: runtime.module,
          entryPoint: runtime.pass.entryPoints.fragment,
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list' },
      });
      renderPassCount++;
    }
    runtimes.set(passId, runtime);
  }
  if (compilationErrors.length > 0) throw new Error(`Specialized-rendering WGSL failed:\n${compilationErrors.join('\n')}`);
  if (moduleHashes.size !== 1) throw new Error(`Pass family contains ${moduleHashes.size} specialized module hashes`);

  const mipmapPixel = await renderMipmapPixel(device, runtimes.get('mipmap'));
  assertPixel(mipmapPixel, [51, 102, 204, 255], 1, 'mipmap pixel');
  const convolutionPixel = await dispatchConvolutionPixel(device, runtimes.get('texture-convolution'));
  assertPixel(convolutionPixel, [25, 50, 75, 255], 1, 'identity convolution pixel');

  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage12-specialized-rendering',
    status: 'passed',
    artifactVersion: 2,
    compilerVersion: 'shader-language-stage12',
    abiVersion: 1,
    passCount: Object.keys(SPECIALIZED_RENDERING_SHADER_ARTIFACT.passes).length,
    renderPassCount,
    computePassCount,
    specializedModuleHash: [...moduleHashes][0],
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    mipmapPixel,
    convolutionPixel,
    cache: counts,
  };
}

async function renderMipmapPixel(device, runtime) {
  if (!runtime) throw new Error('Mipmap runtime is missing');
  const source = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: source }, new Uint8Array([51, 102, 204, 255]), { bytesPerRow: 4 }, [1, 1]);
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  const bindGroup = device.createBindGroup({
    layout: runtime.bindGroupLayout,
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: sampler },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: { module: runtime.module, entryPoint: runtime.pass.entryPoints.vertex },
    fragment: { module: runtime.module, entryPoint: runtime.pass.entryPoints.fragment, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const target = device.createTexture({
    size: [8, 8],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 8 }, [8, 8]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const pixel = [...bytes.slice(4 * 256 + 4 * 4, 4 * 256 + 4 * 4 + 4)];
  readback.unmap();
  source.destroy();
  target.destroy();
  readback.destroy();
  return pixel;
}

async function dispatchConvolutionPixel(device, runtime) {
  if (!runtime) throw new Error('Texture-convolution runtime is missing');
  const source = device.createTexture({
    size: [2, 2],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: source },
    new Uint8Array([25, 50, 75, 255, 25, 50, 75, 255, 25, 50, 75, 255, 25, 50, 75, 255]),
    { bytesPerRow: 8, rowsPerImage: 2 },
    [2, 2],
  );
  const destination = device.createTexture({
    size: [2, 2],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  const parameters = new Float32Array(16);
  parameters[4] = 1;
  const dimensions = new Uint32Array(parameters.buffer);
  dimensions[12] = 2;
  dimensions[13] = 2;
  const paramsBuffer = buffer(device, parameters, GPUBufferUsage.UNIFORM);
  const bindGroup = device.createBindGroup({
    layout: runtime.bindGroupLayout,
    entries: [
      { binding: 0, resource: source.createView() },
      { binding: 1, resource: destination.createView() },
      { binding: 2, resource: { buffer: paramsBuffer, size: 64 } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: runtime.pipelineLayout,
    compute: { module: runtime.module, entryPoint: runtime.pass.entryPoints.compute },
  });
  const readback = device.createBuffer({ size: 256 * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1, 1);
  pass.end();
  encoder.copyTextureToBuffer({ texture: destination }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 2 }, [2, 2]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)];
  readback.unmap();
  source.destroy();
  destination.destroy();
  paramsBuffer.destroy();
  readback.destroy();
  return pixel;
}

function vertexBufferLayout(value) {
  return {
    arrayStride: value.arrayStride,
    stepMode: value.stepMode,
    attributes: value.attributes.map(attribute => ({
      shaderLocation: attribute.shaderLocation,
      offset: attribute.offset,
      format: attribute.format,
    })),
  };
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
  if (layout.kind === 'buffer') entry.buffer = { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize };
  else if (layout.kind === 'texture') entry.texture = { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled };
  else if (layout.kind === 'sampler') entry.sampler = { type: layout.samplerType };
  else if (layout.kind === 'storage-texture') entry.storageTexture = { access: layout.access, format: layout.format, viewDimension: layout.viewDimension };
  else entry.externalTexture = {};
  return entry;
}

function buffer(device, data, usage) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const result = device.createBuffer({ size: Math.max(16, bytes.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(result, 0, bytes);
  return result;
}

function assertPixel(actual, expected, tolerance, label) {
  if (actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) {
    throw new Error(`${label} expected ${expected.join(',')}, received ${actual.join(',')}`);
  }
}
