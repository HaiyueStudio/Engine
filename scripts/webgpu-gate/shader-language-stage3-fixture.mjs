import {
  compileMaterialGraphV1,
  packShaderUniformBlock,
} from '/shader-language/dist/index.js';
import {
  FULL_HANDWRITTEN_PBR_REFERENCE_WGSL,
  PILOT_VERTEX_WGSL,
} from './shader-language-stage3-reference.mjs';

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
  const graphResponse = await fetch('/shader-language/pilot-pbr-composition.graph.json', { cache: 'no-store' });
  if (!graphResponse.ok) throw new Error(`Graph fetch failed: HTTP ${graphResponse.status}`);
  const graphSource = await graphResponse.text();
  const graphCompileStart = performance.now();
  const compiled = compileMaterialGraphV1(graphSource, {
    id: 'graph.stage3-webgpu-pilot',
    label: 'shader-language-stage3-pbr-pilot',
    sourceName: 'pilot-pbr-composition.graph.json',
  });
  const graphCompileMs = performance.now() - graphCompileStart;
  const generatedWgsl = `${PILOT_VERTEX_WGSL}\n${compiled.composition.code}`;

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const uncapturedErrors = [];
  device.addEventListener('uncapturederror', event => uncapturedErrors.push(event.error?.message ?? String(event.error)));
  device.pushErrorScope('validation');

  progressNode.textContent = 'compiling generated and handwritten PBR shaders…';
  const generatedModule = device.createShaderModule({ label: 'stage3-generated', code: generatedWgsl });
  const referenceModule = device.createShaderModule({ label: 'stage3-handwritten-reference', code: FULL_HANDWRITTEN_PBR_REFERENCE_WGSL });
  const [generatedInfo, referenceInfo] = await Promise.all([
    generatedModule.getCompilationInfo(),
    referenceModule.getCompilationInfo(),
  ]);
  const compilationErrors = [
    ...messagesAsErrors('generated', generatedInfo.messages),
    ...messagesAsErrors('reference', referenceInfo.messages),
  ];
  if (compilationErrors.length > 0) throw new Error(`PBR shader compilation failed:\n${compilationErrors.join('\n')}`);

  const generatedPipelineStart = performance.now();
  const generatedPipeline = await createPipeline(device, generatedModule, 'fragmentMain', 'stage3-generated-pipeline');
  const generatedPipelineMs = performance.now() - generatedPipelineStart;
  const referencePipelineStart = performance.now();
  const referencePipeline = await createPipeline(device, referenceModule, 'referenceFragment', 'stage3-reference-pipeline');
  const referencePipelineMs = performance.now() - referencePipelineStart;
  const resources = createPilotResources(device, compiled);
  const generatedBindings = createBindings(device, generatedPipeline, resources);
  const referenceBindings = createBindings(device, referencePipeline, resources);
  const generatedPixels = await renderAndRead(device, generatedPipeline, generatedBindings, 'generated');
  const referencePixels = await renderAndRead(device, referencePipeline, referenceBindings, 'reference');
  const pixelDifference = comparePixels(generatedPixels, referencePixels);
  const centerOffset = (Math.floor(32 / 2) * 32 + Math.floor(32 / 2)) * 4;
  const generatedCenterPixel = [...generatedPixels.slice(centerOffset, centerOffset + 4)];
  const referenceCenterPixel = [...referencePixels.slice(centerOffset, centerOffset + 4)];

  const [generatedGzipBytes, referenceGzipBytes] = await Promise.all([
    gzipByteLength(generatedWgsl),
    gzipByteLength(FULL_HANDWRITTEN_PBR_REFERENCE_WGSL),
  ]);
  const validationError = await device.popErrorScope();
  const validationErrors = [
    ...(validationError ? [validationError.message] : []),
    ...uncapturedErrors,
  ];
  resources.dispose();
  device.destroy();
  if (validationErrors.length > 0) throw new Error(`WebGPU validation errors: ${validationErrors.join('; ')}`);

  return {
    schemaVersion: 1,
    suite: 'shader-language-stage3-pbr-pilot',
    status: 'passed',
    canonicalHash: compiled.canonicalHash,
    compositionHash: compiled.composition.irHash,
    graphCompileMs,
    generatedPipelineMs,
    referencePipelineMs,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: validationErrors.length,
    unclassifiedFailureCount: 0,
    vertexSemantics: compiled.vertexSemantics,
    varyingCount: compiled.varyings.length,
    materialUniformByteSize: compiled.composition.reflection.uniformBlocks.find(block => block.id === 'material.parameters')?.byteSize ?? null,
    generatedRawBytes: new TextEncoder().encode(generatedWgsl).byteLength,
    referenceRawBytes: new TextEncoder().encode(FULL_HANDWRITTEN_PBR_REFERENCE_WGSL).byteLength,
    generatedGzipBytes,
    referenceGzipBytes,
    gzipRatio: generatedGzipBytes / referenceGzipBytes,
    pixelDifference,
    generatedCenterPixel,
    referenceCenterPixel,
    specializationVariantCount: compiled.variantPolicy.reachableSpecializationVariants,
    maximumSpecializationVariantBudget: compiled.variantPolicy.maximumSpecializationVariants,
    pilotFamilyVariantCount: compiled.variantPolicy.reachablePilotFamilyVariants,
    maximumPilotFamilyVariantBudget: compiled.variantPolicy.maximumPilotFamilyVariants,
    productionFirstFrameRegressionPercent: 0,
    productionFirstFrameReason: 'stage 3 has no production renderer migration; the existing pre-generated renderer path is byte-for-byte untouched',
  };
}

async function createPipeline(device, module, fragmentEntryPoint, label) {
  return device.createRenderPipelineAsync({
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'pilotVertex' },
    fragment: { module, entryPoint: fragmentEntryPoint, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });
}

function createPilotResources(device, compiled) {
  const frameBlock = compiled.composition.reflection.uniformBlocks.find(block => block.id === 'frame.scene');
  const materialBlock = compiled.composition.reflection.uniformBlocks.find(block => block.id === 'material.parameters');
  if (!frameBlock || !materialBlock) throw new Error('PBR pilot reflection is missing uniform blocks');
  const frameData = packShaderUniformBlock(frameBlock, {
    cameraPosition: [0, 0, 4],
    lightDirection: [0.4, 0.7, 1],
    lightColor: [1.5, 1.3, 1.1],
    ambientColor: [0.08, 0.1, 0.14],
    fogColor: [0.15, 0.2, 0.3],
    fogStart: 1,
    fogEnd: 8,
  });
  const materialData = packShaderUniformBlock(materialBlock, {
    metallic: 0.35,
    noiseScale: 1.75,
    noiseStrength: 0.025,
    roughness: 0.42,
  });
  const frameBuffer = uniformBuffer(device, 'stage3-frame', frameData);
  const materialBuffer = uniformBuffer(device, 'stage3-material', materialData);
  const albedo = rgbaTexture(device, 'stage3-albedo', new Uint8Array([
    210, 92, 44, 230, 62, 182, 235, 230,
    238, 188, 52, 230, 142, 72, 220, 230,
  ]));
  const normal = rgbaTexture(device, 'stage3-normal', new Uint8Array([
    142, 116, 252, 255, 132, 124, 254, 255,
    118, 138, 252, 255, 128, 128, 255, 255,
  ]));
  const sampler = device.createSampler({
    label: 'stage3-surface-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  return {
    frameBuffer,
    materialBuffer,
    albedoView: albedo.createView(),
    normalView: normal.createView(),
    sampler,
    dispose() {
      frameBuffer.destroy();
      materialBuffer.destroy();
      albedo.destroy();
      normal.destroy();
    },
  };
}

function uniformBuffer(device, label, data) {
  const buffer = device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
}

function rgbaTexture(device, label, data) {
  const texture = device.createTexture({
    label,
    size: [2, 2],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, data, { bytesPerRow: 8, rowsPerImage: 2 }, [2, 2]);
  return texture;
}

function createBindings(device, pipeline, resources) {
  return [
    device.createBindGroup({
      label: 'stage3-frame-bind-group',
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: resources.frameBuffer } }],
    }),
    device.createBindGroup({
      label: 'stage3-material-bind-group',
      layout: pipeline.getBindGroupLayout(2),
      entries: [
        { binding: 0, resource: { buffer: resources.materialBuffer } },
        { binding: 1, resource: resources.albedoView },
        { binding: 2, resource: resources.normalView },
        { binding: 3, resource: resources.sampler },
      ],
    }),
  ];
}

async function renderAndRead(device, pipeline, bindGroups, label) {
  const width = 32;
  const height = 32;
  const bytesPerRow = 256;
  const texture = device.createTexture({
    label: `stage3-${label}-target`,
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    label: `stage3-${label}-readback`,
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroups[0]);
  pass.setBindGroup(2, bindGroups[1]);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height]);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readback.getMappedRange());
  const tightlyPacked = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) tightlyPacked.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
  readback.unmap();
  readback.destroy();
  texture.destroy();
  return tightlyPacked;
}

function comparePixels(actual, expected) {
  let maximumChannelDelta = 0;
  let differingChannelCount = 0;
  let sumAbsoluteDelta = 0;
  for (let index = 0; index < actual.length; index++) {
    const delta = Math.abs(actual[index] - expected[index]);
    maximumChannelDelta = Math.max(maximumChannelDelta, delta);
    if (delta > 0) differingChannelCount++;
    sumAbsoluteDelta += delta;
  }
  return {
    maximumChannelDelta,
    meanAbsoluteChannelDelta: sumAbsoluteDelta / actual.length,
    differingChannelCount,
    channelCount: actual.length,
  };
}

async function gzipByteLength(source) {
  if (typeof CompressionStream !== 'function') throw new Error('CompressionStream(gzip) is unavailable');
  const compressed = new Blob([source]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(compressed).arrayBuffer()).byteLength;
}

function messagesAsErrors(label, messages) {
  return messages.filter(message => message.type === 'error').map(message =>
    `${label}:${message.lineNum}:${message.linePos} ${message.message}`);
}
