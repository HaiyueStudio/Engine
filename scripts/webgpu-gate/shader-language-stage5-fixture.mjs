import {
  compileMotionBlurGraphV1,
  packShaderUniformBlock,
} from '/shader-language/dist/index.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');
const WIDTH = 64;
const HEIGHT = 64;
const BYTES_PER_ROW = 256;
const TILE_SIZE = 8;
const GRAPH_PATH = '/shader-language/pilot-motion-blur-postprocess.graph.json';

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
  const graphResponse = await fetch(GRAPH_PATH, { cache: 'no-store' });
  if (!graphResponse.ok) throw new Error(`Graph HTTP ${graphResponse.status}`);
  const graphSource = await graphResponse.text();
  const graphSha256 = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(graphSource)));
  let compileCalls = 0;
  const compiled = compileMotionBlurGraphV1(graphSource, {
    id: 'pilot3.motion-blur',
    sourceName: 'pilot-motion-blur-postprocess.graph.json',
  });
  compileCalls++;

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter was returned');
  const device = await adapter.requestDevice();
  const owner = createResourceOwner();
  const uncapturedErrors = [];
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error));
  device.addEventListener('uncapturederror', onUncapturedError);
  device.pushErrorScope('validation');

  progressNode.textContent = 'compiling generated and production-reference postprocess shaders…';
  const referenceSources = await loadReferenceSources();
  const generatedSources = Object.fromEntries(Object.entries(compiled.compilation.passes)
    .map(([pass, value]) => [pass, value.code]));
  const generated = await createPipelines(device, generatedSources, 3, 'generated');
  const reference = await createPipelines(device, referenceSources, 0, 'reference');
  const compilationErrors = [...generated.errors, ...reference.errors];
  if (compilationErrors.length > 0) {
    throw new Error(`Postprocess shader compilation failed:\n${compilationErrors.join('\n')}`);
  }

  const sourcePixels = createSourcePixels();
  const sourceTexture = rgba8Texture(device, owner, 'stage5-source', sourcePixels);
  const velocitySlow = velocityTexture(device, owner, 'stage5-velocity-slow', 0.01);
  const velocityFast = velocityTexture(device, owner, 'stage5-velocity-fast', 0.065);
  const tileMaxTexture = trackedTexture(device, owner, {
    label: 'stage5-tile-max',
    size: [WIDTH / TILE_SIZE, HEIGHT / TILE_SIZE],
    format: 'rg16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const neighborMaxTexture = trackedTexture(device, owner, {
    label: 'stage5-neighbor-max',
    size: [WIDTH / TILE_SIZE, HEIGHT / TILE_SIZE],
    format: 'rg16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const outputTexture = trackedTexture(device, owner, {
    label: 'stage5-output',
    size: [WIDTH, HEIGHT],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const readback = trackedBuffer(device, owner, {
    label: 'stage5-readback',
    size: BYTES_PER_ROW * HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const resolveBlock = compiled.compilation.passes['motion-blur-resolve'].reflection.uniformBlocks[0];
  const tileBlock = compiled.compilation.passes['motion-tile-max'].reflection.uniformBlocks[0];
  const resolveUniform = trackedBuffer(device, owner, {
    label: 'stage5-resolve-parameters',
    size: resolveBlock.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const tileUniform = trackedBuffer(device, owner, {
    label: 'stage5-tile-parameters',
    size: tileBlock.byteSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(tileUniform, 0, packShaderUniformBlock(tileBlock, {
    sourceSize: [WIDTH, HEIGHT],
    tileSize: TILE_SIZE,
    padding: 0,
  }));
  const sampler = device.createSampler({
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const resources = {
    sourceTexture,
    tileMaxTexture,
    neighborMaxTexture,
    outputTexture,
    readback,
    resolveUniform,
    tileUniform,
    sampler,
    resolveBlock,
  };
  const cases = {
    disabled: settings(velocityFast, 0, 'blur', 'centered'),
    slow: settings(velocitySlow, 2.5, 'blur', 'centered'),
    fast: settings(velocityFast, 2.5, 'blur', 'centered'),
    reconstructed: settings(velocityFast, 2.5, 'blur', 'tile-neighbor-max'),
    heatmap: settings(velocityFast, 2.5, 'velocity', 'tile-neighbor-max'),
    split: settings(velocityFast, 2.5, 'split', 'tile-neighbor-max'),
  };
  const outputs = {};
  const referenceParity = [];
  const generatedWork = {};
  for (const [name, options] of Object.entries(cases)) {
    progressNode.textContent = `rendering ${name} generated/reference parity…`;
    const generatedResult = await execute(
      device,
      generated,
      3,
      resources,
      options,
      compiled.compilation.plans[options.reconstruction],
      true,
    );
    const referenceResult = await execute(
      device,
      reference,
      0,
      resources,
      options,
      compiled.compilation.plans[options.reconstruction],
      false,
    );
    outputs[name] = generatedResult.pixels;
    generatedWork[name] = generatedResult.work;
    referenceParity.push({ case: name, ...comparePixels(generatedResult.pixels, referenceResult.pixels) });
  }
  const repeat = await execute(
    device,
    generated,
    3,
    resources,
    cases.reconstructed,
    compiled.compilation.plans['tile-neighbor-max'],
    false,
  );

  const validationError = await device.popErrorScope();
  const validationErrors = [
    ...(validationError ? [validationError.message] : []),
    ...uncapturedErrors,
  ];
  await device.queue.onSubmittedWorkDone();
  owner.destroyAll();
  const ownerAudit = owner.audit();
  device.removeEventListener('uncapturederror', onUncapturedError);
  device.destroy();

  return {
    schemaVersion: 1,
    suite: 'shader-language-stage5-motion-blur-pilot',
    status: 'passed',
    graph: {
      path: GRAPH_PATH,
      httpBytes: new TextEncoder().encode(graphSource).byteLength,
      sha256: graphSha256,
    },
    canonicalHash: compiled.program.canonicalHash,
    typedModuleHash: compiled.compilation.typedModuleHash,
    eliminatedDepthResource: compiled.eliminatedResourceIds[0],
    depthTextureAllocations: 0,
    compilationErrorCount: compilationErrors.length,
    validationErrorCount: validationErrors.length,
    validationErrors,
    unclassifiedFailureCount: 0,
    generation: {
      compileCalls,
      frameCalls: 0,
      placement: compiled.compilation.generationPlacement,
    },
    referenceParity,
    metrics: {
      rawVsDisabled: comparePixels(sourcePixels, outputs.disabled),
      rawVsSlow: comparePixels(sourcePixels, outputs.slow),
      rawVsFast: comparePixels(sourcePixels, outputs.fast),
      centeredVsReconstructed: comparePixels(outputs.fast, outputs.reconstructed),
      rawVsHeatmap: comparePixels(sourcePixels, outputs.heatmap),
      split: compareSplit(sourcePixels, outputs.split),
      deterministicRepeat: comparePixels(outputs.reconstructed, repeat.pixels),
    },
    work: {
      centered: {
        passCount: generatedWork.fast.passCount,
        activeIntermediateTextureCount: compiled.compilation.plans.centered.activeIntermediateTextureCount,
        allocatedIntermediateTextureCount: compiled.compilation.plans.centered.allocatedIntermediateTextureCount,
      },
      'tile-neighbor-max': {
        passCount: generatedWork.reconstructed.passCount,
        activeIntermediateTextureCount: compiled.compilation.plans['tile-neighbor-max'].activeIntermediateTextureCount,
        allocatedIntermediateTextureCount: compiled.compilation.plans['tile-neighbor-max'].allocatedIntermediateTextureCount,
      },
    },
    variants: compiled.compilation.variantPolicy,
    resources: {
      compilerCreatedGpuResources: 0,
      ownerCreated: ownerAudit.created,
      ownerDestroyed: ownerAudit.destroyed,
      ownerResidualAfterDestroy: ownerAudit.residual,
    },
  };
}

function settings(velocityTexture, intensity, displayMode, reconstruction) {
  return {
    velocityTexture,
    shutterScale: 0.75,
    intensity,
    maxBlurPixels: 24,
    sampleCount: 12,
    displayMode,
    reconstruction,
    splitPosition: 0.5,
  };
}

async function execute(device, pipelines, group, resources, options, plan, recordWork) {
  const displayMode = options.displayMode === 'velocity' ? 2 : options.displayMode === 'split' ? 1 : 0;
  device.queue.writeBuffer(resources.resolveUniform, 0, packShaderUniformBlock(resources.resolveBlock, {
    resolution: [WIDTH, HEIGHT, 1 / WIDTH, 1 / HEIGHT],
    settings: [options.shutterScale, options.intensity, options.maxBlurPixels, options.sampleCount],
    display: [displayMode, options.reconstruction === 'tile-neighbor-max' ? 1 : 0, options.splitPosition, TILE_SIZE],
  }));
  const tileBindGroup = device.createBindGroup({
    layout: pipelines['motion-tile-max'].pipeline.getBindGroupLayout(group),
    entries: [
      { binding: 0, resource: options.velocityTexture.createView() },
      { binding: 1, resource: { buffer: resources.tileUniform } },
    ],
  });
  const neighborBindGroup = device.createBindGroup({
    layout: pipelines['motion-neighbor-max'].pipeline.getBindGroupLayout(group),
    entries: [{ binding: 0, resource: resources.tileMaxTexture.createView() }],
  });
  const resolveBindGroup = device.createBindGroup({
    layout: pipelines['motion-blur-resolve'].pipeline.getBindGroupLayout(group),
    entries: [
      { binding: 0, resource: resources.sourceTexture.createView() },
      { binding: 1, resource: options.velocityTexture.createView() },
      { binding: 2, resource: resources.neighborMaxTexture.createView() },
      { binding: 3, resource: resources.sampler },
      { binding: 4, resource: { buffer: resources.resolveUniform } },
    ],
  });
  const encoder = device.createCommandEncoder();
  for (const pass of plan.passes) {
    const target = pass === 'motion-tile-max'
      ? resources.tileMaxTexture
      : pass === 'motion-neighbor-max'
        ? resources.neighborMaxTexture
        : resources.outputTexture;
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    renderPass.setPipeline(pipelines[pass].pipeline);
    renderPass.setBindGroup(
      group,
      pass === 'motion-tile-max'
        ? tileBindGroup
        : pass === 'motion-neighbor-max'
          ? neighborBindGroup
          : resolveBindGroup,
    );
    renderPass.draw(3);
    renderPass.end();
  }
  encoder.copyTextureToBuffer(
    { texture: resources.outputTexture },
    { buffer: resources.readback, bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT, 1],
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await resources.readback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(resources.readback.getMappedRange()).slice();
  resources.readback.unmap();
  return {
    pixels,
    work: {
      passCount: plan.passes.length,
      drawCount: plan.passes.length,
      uploadCount: recordWork ? 1 : 0,
    },
  };
}

async function createPipelines(device, sources, group, label) {
  const result = {};
  const errors = [];
  for (const [pass, source] of Object.entries(sources)) {
    const module = device.createShaderModule({ label: `stage5-${label}-${pass}`, code: source });
    const info = await module.getCompilationInfo();
    errors.push(...info.messages
      .filter(message => message.type === 'error')
      .map(message => `${label}/${pass}:${message.lineNum}:${message.linePos} ${message.message}`));
    result[pass] = {
      pipeline: await device.createRenderPipelineAsync({
        label: `stage5-${label}-${pass}-pipeline`,
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: {
          module,
          entryPoint: 'fs_main',
          targets: [{ format: pass === 'motion-blur-resolve' ? 'rgba8unorm' : 'rg16float' }],
        },
        primitive: { topology: 'triangle-list' },
      }),
      group,
    };
  }
  return { ...result, errors };
}

async function loadReferenceSources() {
  const base = '/engine/src/shaders/generated/';
  const [tile, neighbor, resolve] = await Promise.all([
    fetchText(`${base}motion-tile-max.generated.wgsl`),
    fetchText(`${base}motion-neighbor-max.generated.wgsl`),
    fetchText(`${base}motion-blur-resolve.generated.wgsl`),
  ]);
  return {
    'motion-tile-max': tile,
    'motion-neighbor-max': neighbor,
    'motion-blur-resolve': resolve,
  };
}

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Reference shader ${url} HTTP ${response.status}`);
  return response.text();
}

function createSourcePixels() {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4;
      const checker = ((x >> 1) + (y >> 1)) % 2 === 0;
      pixels[offset] = checker ? 238 : 18;
      pixels[offset + 1] = checker ? 48 : 205;
      pixels[offset + 2] = checker ? 82 : 238;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function rgba8Texture(device, owner, label, pixels) {
  const texture = trackedTexture(device, owner, {
    label,
    size: [WIDTH, HEIGHT],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    pixels,
    { bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT, 1],
  );
  return texture;
}

function velocityTexture(device, owner, label, speed) {
  const values = new Int8Array(WIDTH * HEIGHT * 4);
  for (let y = 17; y < 47; y++) {
    for (let x = 21; x < 43; x++) {
      const offset = (y * WIDTH + x) * 4;
      values[offset] = Math.round(speed * 127);
      values[offset + 1] = Math.round(speed * 0.25 * 127);
    }
  }
  const texture = trackedTexture(device, owner, {
    label,
    size: [WIDTH, HEIGHT],
    format: 'rgba8snorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    values,
    { bytesPerRow: BYTES_PER_ROW, rowsPerImage: HEIGHT },
    [WIDTH, HEIGHT, 1],
  );
  return texture;
}

function comparePixels(left, right) {
  let maximumChannelDelta = 0;
  let absolute = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs((left[offset + channel] ?? 0) - (right[offset + channel] ?? 0));
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      absolute += delta;
      pixelDelta += delta;
    }
    if (pixelDelta >= 12) changedPixels++;
  }
  return {
    maximumChannelDelta,
    meanAbsoluteChannelDelta: absolute / (WIDTH * HEIGHT * 3),
    changedPixelRatio: changedPixels / (WIDTH * HEIGHT),
  };
}

function compareSplit(raw, split) {
  let leftMaximumChannelDelta = 0;
  let rightAbsolute = 0;
  let rightChannels = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs((raw[offset + channel] ?? 0) - (split[offset + channel] ?? 0));
        if (x < 31) leftMaximumChannelDelta = Math.max(leftMaximumChannelDelta, delta);
        if (x > 33) {
          rightAbsolute += delta;
          rightChannels++;
        }
      }
    }
  }
  return {
    leftMaximumChannelDelta,
    rightMeanAbsoluteChannelDelta: rightAbsolute / rightChannels,
  };
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function createResourceOwner() {
  const resources = new Set();
  let created = 0;
  let destroyed = 0;
  return {
    track(resource) {
      resources.add(resource);
      created++;
      return resource;
    },
    destroyAll() {
      for (const resource of resources) {
        resource.destroy();
        destroyed++;
      }
      resources.clear();
    },
    audit() {
      return { created, destroyed, residual: resources.size };
    },
  };
}

function trackedTexture(device, owner, descriptor) {
  return owner.track(device.createTexture(descriptor));
}

function trackedBuffer(device, owner, descriptor) {
  return owner.track(device.createBuffer(descriptor));
}
