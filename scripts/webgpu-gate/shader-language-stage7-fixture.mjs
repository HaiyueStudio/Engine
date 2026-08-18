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
  device.addEventListener('uncapturederror', event => {
    uncapturedErrors.push(event.error?.message ?? String(event.error));
  });
  device.pushErrorScope('validation');

  const counts = { shaderModules: 0, artifactLayouts: 0, pipelineLayouts: 0 };
  const trackedDevice = new Proxy(device, {
    get(target, property) {
      const value = target[property];
      if (typeof value !== 'function') return value;
      if (property === 'createShaderModule') return descriptor => {
        counts.shaderModules++;
        return target.createShaderModule(descriptor);
      };
      if (property === 'createBindGroupLayout') return descriptor => {
        counts.artifactLayouts++;
        return target.createBindGroupLayout(descriptor);
      };
      if (property === 'createPipelineLayout') return descriptor => {
        counts.pipelineLayouts++;
        return target.createPipelineLayout(descriptor);
      };
      return value.bind(target);
    },
  });

  const frameLayoutA = device.createBindGroupLayout({
    label: 'stage7.frame-a',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } }],
  });
  const frameLayoutB = device.createBindGroupLayout({
    label: 'stage7.frame-b',
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } }],
  });
  const artifact = fixtureArtifact();
  const first = getPrecompiledShaderPassRuntime(trackedDevice, artifact, 'multi-group', {
    rendererOwnedLayouts: { 0: frameLayoutA },
  });
  const repeated = getPrecompiledShaderPassRuntime(trackedDevice, artifact, 'multi-group', {
    rendererOwnedLayouts: { 0: frameLayoutA },
  });
  const alternateOwner = getPrecompiledShaderPassRuntime(trackedDevice, artifact, 'multi-group', {
    rendererOwnedLayouts: { 0: frameLayoutB },
  });
  if (first !== repeated || first === alternateOwner) throw new Error('Runtime cache did not isolate external layout identity.');
  if (first.module !== alternateOwner.module || first.bindGroupLayouts[1] !== alternateOwner.bindGroupLayouts[1]) {
    throw new Error('Immutable module/artifact layout was duplicated for a renderer layout change.');
  }

  const compilationInfo = await first.module.getCompilationInfo();
  const compilationErrors = compilationInfo.messages
    .filter(message => message.type === 'error')
    .map(message => `${message.lineNum}:${message.linePos} ${message.message}`);
  if (compilationErrors.length > 0) throw new Error(`Artifact WGSL failed:\n${compilationErrors.join('\n')}`);

  const pipeline = await device.createRenderPipelineAsync({
    label: 'shader-language-stage7-pipeline',
    layout: first.pipelineLayout,
    vertex: { module: first.module, entryPoint: 'vs_main' },
    fragment: { module: first.module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
  const frameBuffer = uniformBuffer(device, 'stage7.frame', [0.5, 1, 1, 1]);
  const materialBuffer = uniformBuffer(device, 'stage7.material', [0.4, 0.6, 0.8, 1]);
  const frameBindGroup = device.createBindGroup({
    layout: frameLayoutA,
    entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
  });
  const materialBindGroup = device.createBindGroup({
    layout: first.bindGroupLayouts[1],
    entries: [{ binding: 0, resource: { buffer: materialBuffer } }],
  });

  const width = 4;
  const height = 4;
  const texture = device.createTexture({
    label: 'shader-language-stage7-target',
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bytesPerRow = 256;
  const readback = device.createBuffer({
    label: 'shader-language-stage7-readback',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(), loadOp: 'clear', storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, frameBindGroup);
  pass.setBindGroup(1, materialBindGroup);
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

  const expectedPixel = [51, 153, 204, 255];
  const pixelDelta = centerPixel.map((value, index) => Math.abs(value - expectedPixel[index]));
  if (pixelDelta.some(value => value > 1)) {
    throw new Error(`Unexpected center pixel ${centerPixel.join(',')}; expected ${expectedPixel.join(',')}.`);
  }
  if (counts.shaderModules !== 1 || counts.artifactLayouts !== 1 || counts.pipelineLayouts !== 2) {
    throw new Error(`Unexpected runtime cache work ${JSON.stringify(counts)}.`);
  }

  frameBuffer.destroy();
  materialBuffer.destroy();
  texture.destroy();
  readback.destroy();
  const validationError = await device.popErrorScope();
  device.destroy();
  if (validationError || uncapturedErrors.length > 0) {
    throw new Error(`WebGPU validation errors: ${validationError?.message ?? uncapturedErrors.join('; ')}`);
  }
  return {
    schemaVersion: 1,
    suite: 'shader-language-stage7-artifact-v2',
    status: 'passed',
    artifactVersion: artifact.version,
    rendererOwnedGroupCount: 1,
    artifactOwnedGroupCount: 1,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: 0,
    unclassifiedFailureCount: 0,
    centerPixel,
    expectedPixel,
    pixelDelta,
    cache: counts,
  };
}

function uniformBuffer(device, label, values) {
  const data = new Float32Array(values);
  const buffer = device.createBuffer({
    label,
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function fixtureArtifact() {
  const code = `struct FrameData { tint : vec4<f32> }
struct MaterialData { color : vec4<f32> }
@group(0) @binding(0) var<uniform> frame : FrameData;
@group(1) @binding(0) var<uniform> material : MaterialData;
@vertex fn vs_main(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return material.color * frame.tint; }`;
  return {
    format: 'haiyue-precompiled-shader-artifact',
    version: 2,
    compilerVersion: 'shader-language-stage7',
    source: { kind: 'typed-ir', path: 'scripts/webgpu-gate/shader-language-stage7-fixture.mjs', sha256: 'a'.repeat(64) },
    canonicalHash: 'b'.repeat(64),
    typedModuleHash: 'c'.repeat(64),
    artifactHash: 'd'.repeat(64),
    passes: {
      'multi-group': {
        id: 'multi-group',
        code,
        canonicalHash: 'e'.repeat(64),
        entryPoints: { vertex: 'vs_main', fragment: 'fs_main' },
        bindGroups: [
          {
            logicalSpace: 'frame', logicalGroup: 0, physicalGroup: 0, owner: 'renderer',
            bindings: [{
              id: 'frame.tint', binding: 0, visibility: ['vertex', 'fragment'],
              layout: { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 16 },
            }],
          },
          {
            logicalSpace: 'material', logicalGroup: 2, physicalGroup: 1, owner: 'artifact',
            bindings: [{
              id: 'material.color', binding: 0, visibility: ['fragment'],
              layout: { kind: 'buffer', bufferType: 'uniform', hasDynamicOffset: false, minBindingSize: 16 },
            }],
          },
        ],
        uniformBlocks: [],
        vertexBuffers: [],
        varyings: [],
        renderTargets: [{ location: 0, formatClass: 'color' }],
        capabilities: [],
        passRequirements: [],
        sourceMap: [],
      },
    },
  };
}
