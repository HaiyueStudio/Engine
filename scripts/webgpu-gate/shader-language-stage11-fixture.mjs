import { MATERIAL_LIGHTING_SHADER_ARTIFACT } from '/engine/dist/internal/material-lighting-shader-artifact.js';
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
  if (MATERIAL_LIGHTING_SHADER_ARTIFACT.version !== 2 || MATERIAL_LIGHTING_SHADER_ARTIFACT.compilerVersion !== 'shader-language-stage11') {
    throw new Error('Invalid material-lighting artifact identity');
  }

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

  const runtimes = new Map();
  const compilationErrors = [];
  const lightingModuleHashes = new Set();
  const deformationModuleHashes = new Set();
  for (const [passId, pass] of Object.entries(MATERIAL_LIGHTING_SHADER_ARTIFACT.passes)) {
    const lightingHash = pass.code.match(/haiyue:material-lighting-module ([a-f0-9]{64})/)?.[1];
    const deformationHash = pass.code.match(/haiyue:deformation-module ([a-f0-9]{64})/)?.[1];
    if (!lightingHash || !deformationHash) throw new Error(`${passId} is missing module provenance`);
    lightingModuleHashes.add(lightingHash);
    deformationModuleHashes.add(deformationHash);
    const layouts = pass.bindGroups.map(group => {
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
      return trackedDevice.createBindGroupLayout({
        label: `stage11.${passId}.group${group.physicalGroup}`,
        entries,
      });
    });
    const runtime = getPrecompiledShaderPassRuntime(trackedDevice, MATERIAL_LIGHTING_SHADER_ARTIFACT, passId, {
      rendererOwnedLayouts: Object.fromEntries(pass.bindGroups.map((group, index) => [group.physicalGroup, layouts[index]])),
    });
    const info = await runtime.module.getCompilationInfo();
    for (const message of info.messages) {
      if (message.type === 'error') compilationErrors.push(`${passId}:${message.lineNum}:${message.linePos} ${message.message}`);
    }
    await trackedDevice.createRenderPipelineAsync({
      label: `stage11-${passId}`,
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
    runtimes.set(passId, { runtime, layouts });
  }
  if (compilationErrors.length > 0) throw new Error(`Material-lighting WGSL failed:\n${compilationErrors.join('\n')}`);
  if (lightingModuleHashes.size !== 1) throw new Error(`Pass family contains ${lightingModuleHashes.size} lighting module hashes`);
  if (deformationModuleHashes.size !== 1) throw new Error(`Pass family contains ${deformationModuleHashes.size} deformation module hashes`);

  const litPixel = await renderBlinnPixel(device, runtimes.get('blinn-phong'));
  const fogPixel = await renderBlinnPixel(device, runtimes.get('blinn-phong'), { fogEnabled: true });
  const lowAmbientPixel = await renderBlinnPixel(device, runtimes.get('blinn-phong'), {
    ambient: [0.03, 0.03, 0.03, 1],
    lightIntensity: 0.72,
  });
  assertPixel(litPixel, [186, 0, 0, 255], 1, 'Blinn tone-mapped ambient lighting');
  assertPixel(lowAmbientPixel, [44, 44, 44, 255], 1, 'Blinn low-intensity ambient display encoding');
  assertPixel(fogPixel, [0, 0, 255, 255], 1, 'post-lighting fog');

  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage11-material-lighting',
    status: 'passed',
    artifactVersion: 2,
    compilerVersion: 'shader-language-stage11',
    abiVersion: 1,
    passCount: Object.keys(MATERIAL_LIGHTING_SHADER_ARTIFACT.passes).length,
    lightingModuleHash: [...lightingModuleHashes][0],
    deformationModuleHash: [...deformationModuleHashes][0],
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    litPixel,
    lowAmbientPixel,
    fogPixel,
    cache: counts,
  };
}

async function renderBlinnPixel(
  device,
  materialized,
  { fogEnabled = false, ambient = [1, 0, 0, 1], lightIntensity = 1 } = {},
) {
  if (!materialized) throw new Error('Blinn runtime is missing');
  const { runtime, layouts } = materialized;
  const sceneData = sceneFrameData(8, 8);
  if (fogEnabled) {
    sceneData.set([0, 0, 1, 1], 56);
    sceneData.set([1, 0, 1, 1], 60);
  }
  const objectData = new Float32Array(32);
  objectData.set(identity(), 0);
  objectData.set(identity(), 16);
  const materialData = new Float32Array(16);
  materialData.set(ambient, 0);
  materialData.set([1, 0, 0, 1], 4);
  materialData.set([0, 0, 0, 1], 8);
  materialData[12] = 32;
  const lightsData = new ArrayBuffer(528);
  new Uint32Array(lightsData)[0] = 1;
  new Uint32Array(lightsData)[4] = 0;
  new Float32Array(lightsData).set([1, 1, 1, lightIntensity], 8);

  const sceneBuffer = buffer(device, sceneData, GPUBufferUsage.UNIFORM);
  const objectBuffer = buffer(device, objectData, GPUBufferUsage.STORAGE);
  const clippingBuffer = buffer(device, new Float32Array(36), GPUBufferUsage.STORAGE);
  const materialBuffer = buffer(device, materialData, GPUBufferUsage.UNIFORM);
  const lightsBuffer = buffer(device, lightsData, GPUBufferUsage.UNIFORM);
  const groups = [
    device.createBindGroup({ layout: layouts[0], entries: [{ binding: 0, resource: { buffer: sceneBuffer, size: 272 } }] }),
    device.createBindGroup({ layout: layouts[1], entries: [
      { binding: 0, resource: { buffer: objectBuffer } },
      { binding: 1, resource: { buffer: clippingBuffer } },
    ] }),
    device.createBindGroup({ layout: layouts[2], entries: [{ binding: 0, resource: { buffer: materialBuffer, size: 64 } }] }),
    device.createBindGroup({ layout: layouts[3], entries: [{ binding: 0, resource: { buffer: lightsBuffer, size: 528 } }] }),
  ];
  const vertices = [
    vertex(device, [-1, -1, 0, 3, -1, 0, -1, 3, 0]),
    vertex(device, [0, 0, 1, 0, 0, 1, 0, 0, 1]),
    vertex(device, [0, 0, 0, 0, 0, 0]),
  ];
  const rendered = await renderAndRead(device, runtime, groups, vertices);
  destroy([sceneBuffer, objectBuffer, clippingBuffer, materialBuffer, lightsBuffer, ...vertices, rendered.target, rendered.readback]);
  return rendered.pixel;
}

async function renderAndRead(device, runtime, groups, vertices) {
  const target = device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: { module: runtime.module, entryPoint: runtime.pass.entryPoints.vertex, buffers: runtime.pass.vertexBuffers.map(vertexBufferLayout) },
    fragment: { module: runtime.module, entryPoint: runtime.pass.entryPoints.fragment, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
  });
  pass.setPipeline(pipeline);
  groups.forEach((group, index) => pass.setBindGroup(index, group, index === 0 ? [0] : []));
  vertices.forEach((value, index) => pass.setVertexBuffer(index, value));
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256, rowsPerImage: 8 }, [8, 8]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(readback.getMappedRange());
  const offset = 4 * 256 + 4 * 4;
  const pixel = [...bytes.slice(offset, offset + 4)];
  readback.unmap();
  return { pixel, target, readback };
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
    visibility: binding.visibility.reduce((mask, stage) => mask | ({ vertex: GPUShaderStage.VERTEX, fragment: GPUShaderStage.FRAGMENT, compute: GPUShaderStage.COMPUTE })[stage], 0),
  };
  const layout = binding.layout;
  if (layout.kind === 'buffer') entry.buffer = { type: layout.bufferType, hasDynamicOffset: layout.hasDynamicOffset, minBindingSize: layout.minBindingSize };
  else if (layout.kind === 'texture') entry.texture = { sampleType: layout.sampleType, viewDimension: layout.viewDimension, multisampled: layout.multisampled };
  else if (layout.kind === 'sampler') entry.sampler = { type: layout.samplerType };
  else if (layout.kind === 'storage-texture') entry.storageTexture = { access: layout.access, format: layout.format, viewDimension: layout.viewDimension };
  else entry.externalTexture = {};
  return entry;
}

function sceneFrameData(width, height) {
  const value = new Float32Array(68);
  value.set(identity(), 0);
  value.set(identity(), 16);
  value.set(identity(), 32);
  value.set([0, 0, 2, 1], 48);
  value.set([width, height, 1 / width, 1 / height], 52);
  return value;
}

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function buffer(device, data, usage) {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const result = device.createBuffer({ size: Math.max(16, bytes.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(result, 0, bytes);
  return result;
}

function vertex(device, data) {
  return buffer(device, new Float32Array(data), GPUBufferUsage.VERTEX);
}

function assertPixel(actual, expected, tolerance, label) {
  if (actual.some((value, index) => Math.abs(value - expected[index]) > tolerance)) {
    throw new Error(`${label} expected ${expected.join(',')}, received ${actual.join(',')}`);
  }
}

function destroy(values) {
  for (const value of new Set(values)) value.destroy();
}
