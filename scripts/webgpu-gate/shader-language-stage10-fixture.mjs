import { DEFORMATION_SHADER_ARTIFACT } from '/engine/dist/internal/deformation-shader-artifact.js';
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
  if (DEFORMATION_SHADER_ARTIFACT.version !== 2 || DEFORMATION_SHADER_ARTIFACT.compilerVersion !== 'shader-language-stage10') {
    throw new Error('Invalid deformation artifact identity');
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
  const moduleHashes = new Set();
  for (const [passId, pass] of Object.entries(DEFORMATION_SHADER_ARTIFACT.passes)) {
    const moduleHash = pass.code.match(/haiyue:deformation-module ([a-f0-9]{64})/)?.[1];
    if (!moduleHash) throw new Error(`${passId} is missing deformation module provenance`);
    moduleHashes.add(moduleHash);
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
        label: `stage10.${passId}.group${group.physicalGroup}`,
        entries,
      });
    });
    const runtime = getPrecompiledShaderPassRuntime(trackedDevice, DEFORMATION_SHADER_ARTIFACT, passId, {
      rendererOwnedLayouts: Object.fromEntries(layouts.map((layout, index) => [index, layout])),
    });
    const info = await runtime.module.getCompilationInfo();
    for (const message of info.messages) {
      if (message.type === 'error') compilationErrors.push(`${passId}:${message.lineNum}:${message.linePos} ${message.message}`);
    }
    await trackedDevice.createRenderPipelineAsync({
      label: `stage10-${passId}`,
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
        targets: [{ format: passId === 'motion-vector' ? 'rg16float' : 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    runtimes.set(passId, { runtime, layouts });
  }
  if (compilationErrors.length > 0) throw new Error(`Production deformation WGSL failed:\n${compilationErrors.join('\n')}`);
  if (moduleHashes.size !== 1) throw new Error(`Pass family contains ${moduleHashes.size} deformation module hashes`);

  const outlinePixel = await renderOutlinePixel(device, runtimes.get('outline'));
  if (outlinePixel.some((value, index) => Math.abs(value - [255, 255, 255, 255][index]) > 1)) {
    throw new Error(`Unexpected outline deformation pixel ${outlinePixel.join(',')}`);
  }
  const motionPixel = await renderMotionPixel(device, runtimes.get('motion-vector'));
  if (Math.abs(motionPixel[0] - 0.25) > 0.03 || Math.abs(motionPixel[1]) > 0.03) {
    throw new Error(`Unexpected history velocity ${motionPixel.join(',')}`);
  }

  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage10-production-deformation',
    status: 'passed',
    artifactVersion: 2,
    compilerVersion: 'shader-language-stage10',
    abiVersion: 1,
    passCount: Object.keys(DEFORMATION_SHADER_ARTIFACT.passes).length,
    deformationModuleHash: [...moduleHashes][0],
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    outlinePixel,
    motionPixel,
    cache: counts,
  };
}

async function renderOutlinePixel(device, materialized) {
  const { runtime, layouts } = materialized;
  const scene = sceneFrameData(8, 8);
  const object = new Float32Array(24);
  object.set(identity(), 0);
  object.set([1, 0, 0, 0], 16);
  object.set([1, 1, 0, 0], 20);
  const sceneBuffer = buffer(device, scene, GPUBufferUsage.UNIFORM);
  const objectBuffer = buffer(device, object, GPUBufferUsage.STORAGE);
  const clippingBuffer = buffer(device, new Float32Array(36), GPUBufferUsage.STORAGE);
  const matrixBuffer = buffer(device, identity(), GPUBufferUsage.STORAGE);
  const joints = buffer(device, new Float32Array(12), GPUBufferUsage.STORAGE);
  const weights = buffer(device, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), GPUBufferUsage.STORAGE);
  const groups = [
    device.createBindGroup({ layout: layouts[0], entries: [{ binding: 0, resource: { buffer: sceneBuffer, size: 272 } }] }),
    device.createBindGroup({ layout: layouts[1], entries: [
      { binding: 0, resource: { buffer: objectBuffer } },
      { binding: 1, resource: { buffer: clippingBuffer } },
    ] }),
    device.createBindGroup({ layout: layouts[2], entries: [] }),
    device.createBindGroup({ layout: layouts[3], entries: [
      { binding: 0, resource: { buffer: matrixBuffer } },
      { binding: 1, resource: { buffer: joints } },
      { binding: 2, resource: { buffer: weights } },
    ] }),
  ];
  const positions = vertex(device, [-1.5, -0.6, 0, -0.5, -0.6, 0, -1, 0.6, 0]);
  const morph = vertex(device, [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const zero = vertex(device, new Array(9).fill(0));
  const rendered = await renderAndRead(device, runtime, groups, [positions, morph, zero, zero, zero], 'rgba8unorm', 'rgba8');
  destroy([sceneBuffer, objectBuffer, clippingBuffer, matrixBuffer, joints, weights, positions, morph, zero, rendered.target, rendered.readback]);
  return rendered.pixel;
}

async function renderMotionPixel(device, materialized) {
  const { runtime, layouts } = materialized;
  const sceneBuffer = buffer(device, sceneFrameData(8, 8), GPUBufferUsage.UNIFORM);
  const object = new Float32Array(60);
  object.set(identity(), 0);
  const previous = identity();
  previous[12] = -0.5;
  object.set(previous, 16);
  object.set(identity(), 32);
  const objectBuffer = buffer(device, object, GPUBufferUsage.UNIFORM);
  const clippingBuffer = buffer(device, new Float32Array(36), GPUBufferUsage.STORAGE);
  const matrixBuffer = buffer(device, identity(), GPUBufferUsage.STORAGE);
  const attributes = buffer(device, new Float32Array(12), GPUBufferUsage.STORAGE);
  const groups = [
    device.createBindGroup({ layout: layouts[0], entries: [{ binding: 0, resource: { buffer: sceneBuffer, size: 272 } }] }),
    device.createBindGroup({ layout: layouts[1], entries: [
      { binding: 0, resource: { buffer: objectBuffer, size: 240 } },
      { binding: 1, resource: { buffer: clippingBuffer } },
    ] }),
    device.createBindGroup({ layout: layouts[2], entries: [
      { binding: 0, resource: { buffer: matrixBuffer } },
      { binding: 1, resource: { buffer: matrixBuffer } },
      { binding: 2, resource: { buffer: attributes } },
      { binding: 3, resource: { buffer: attributes } },
    ] }),
  ];
  const positions = vertex(device, [-1, -1, 0, 3, -1, 0, -1, 3, 0]);
  const zero = vertex(device, new Array(9).fill(0));
  const rendered = await renderAndRead(device, runtime, groups, [positions, zero, zero, zero, zero], 'rg16float', 'rg16f');
  destroy([sceneBuffer, objectBuffer, clippingBuffer, matrixBuffer, attributes, positions, zero, rendered.target, rendered.readback]);
  return rendered.pixel;
}

async function renderAndRead(device, runtime, groups, vertices, format, readKind) {
  const target = device.createTexture({ size: [8, 8], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createRenderPipeline({
    layout: runtime.pipelineLayout,
    vertex: {
      module: runtime.module,
      entryPoint: 'vs_main',
      buffers: runtime.pass.vertexBuffers.map(buffer => ({
        arrayStride: buffer.arrayStride,
        stepMode: buffer.stepMode,
        attributes: buffer.attributes.map(attribute => ({ shaderLocation: attribute.shaderLocation, offset: attribute.offset, format: attribute.format })),
      })),
    },
    fragment: { module: runtime.module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
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
  const pixel = readKind === 'rgba8'
    ? [...bytes.slice(offset, offset + 4)]
    : [halfToFloat(bytes[offset] | (bytes[offset + 1] << 8)), halfToFloat(bytes[offset + 2] | (bytes[offset + 3] << 8))];
  readback.unmap();
  return { pixel, target, readback };
}

function bindingEntry(binding) {
  const entry = { binding: binding.binding, visibility: binding.visibility.reduce((mask, stage) => mask | ({ vertex: GPUShaderStage.VERTEX, fragment: GPUShaderStage.FRAGMENT, compute: GPUShaderStage.COMPUTE })[stage], 0) };
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
  value.set([width, height, 1 / width, 1 / height], 52);
  return value;
}

function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function buffer(device, data, usage) {
  const value = data instanceof Float32Array ? data : new Float32Array(data);
  const result = device.createBuffer({ size: Math.max(16, value.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(result, 0, value);
  return result;
}

function vertex(device, data) {
  return buffer(device, data, GPUBufferUsage.VERTEX);
}

function destroy(values) {
  for (const value of new Set(values)) value.destroy();
}

function halfToFloat(value) {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}
