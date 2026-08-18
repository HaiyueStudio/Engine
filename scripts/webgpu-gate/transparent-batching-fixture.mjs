import {
  BasicMaterial,
  Camera3D,
  Entity,
  Geometry3D,
  Mesh3D,
  Render3DSystem,
  RenderView,
  Transform3D,
  VolumeMaterial,
  World,
  createRenderFrameContext,
  disposeSceneFrameGpuArena,
} from '/engine/dist/experimental.js';

const progressNode = document.querySelector('#progress');
const resultNode = document.querySelector('#result');

try {
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const adapterInfo = plainAdapterInfo(adapter.info ?? {});
  const result = await withStrictDevice(adapter, async device => {
    const audit = instrumentDrawAudit(device);
    const cases = [];
    for (const configuration of [
      { id: 'additive-1000', kind: 'additive', count: 1_000 },
      { id: 'alpha-64', kind: 'alpha', count: 64 },
      { id: 'volume-16', kind: 'volume', count: 16 },
    ]) {
      progressNode.textContent = `${configuration.id}: simple`;
      const reference = await runProfile(device, audit, configuration, 'simple');
      progressNode.textContent = `${configuration.id}: batched`;
      const optimized = await runProfile(device, audit, configuration, 'batched');
      cases.push(compareProfiles(configuration, reference, optimized));
    }
    assertGateSemantics(cases);
    return {
      schemaVersion: 1,
      suite: 'render3d.transparent-safe-batching',
      generatedAt: new Date().toISOString(),
      browser: navigator.userAgent,
      adapter: adapterInfo,
      cases,
      gate: {
        status: 'passed',
        strictValidation: true,
        exactPixelComparison: true,
        volumeSingleObjectSubmission: true,
      },
    };
  });
  progressNode.textContent = 'complete';
  resultNode.textContent = JSON.stringify(result);
  resultNode.dataset.status = 'passed';
} catch (error) {
  progressNode.textContent = 'failed';
  resultNode.textContent = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  resultNode.dataset.status = 'failed';
}

async function runProfile(device, audit, configuration, renderProfile) {
  const width = 256;
  const height = 160;
  const target = createTarget(device, width, height, configuration.id);
  const engine = createEngine(device, target);
  const world = new World(`transparent-batching:${configuration.id}:${renderProfile}`);
  const camera = new Entity('camera')
    .addComponent(new Transform3D().setTranslation(0, 0, 12))
    .addComponent(new Camera3D({ near: 0.1, far: 100 }));
  world.addEntity(camera);

  let volumeTexture = null;
  const geometry = configuration.kind === 'volume'
    ? createCubeGeometry()
    : createTriangleGeometry();
  let material;
  if (configuration.kind === 'additive') {
    material = new BasicMaterial({
      color: [0.9, 0.3, 0.12, 0.4],
      blending: 'additive',
      depthWrite: false,
    });
  } else if (configuration.kind === 'alpha') {
    material = new BasicMaterial({
      color: [0.15, 0.65, 0.95, 0.35],
      blending: 'normal',
      depthWrite: false,
    });
  } else {
    volumeTexture = createVolumeTexture(device);
    material = new VolumeMaterial({
      texture: volumeTexture,
      color: [0.2, 0.8, 1, 0.7],
      densityScale: 1.2,
      opacityScale: 0.45,
      steps: 12,
      blending: 'normal',
    });
  }

  for (let index = 0; index < configuration.count; index++) {
    const [x, y, z] = objectPosition(configuration.kind, index);
    world.addEntity(new Entity(`${configuration.kind}:${index}`)
      .addComponent(new Transform3D().setTranslation(x, y, z))
      .addComponent(new Mesh3D(geometry, material)));
  }

  const render3d = new Render3DSystem(engine, camera, {
    renderProfile,
    transparentSort: true,
    spatialCullingThreshold: 2_048,
  });
  world.addSystem(render3d);
  const view = new RenderView({
    key: `${configuration.id}:${renderProfile}`,
    camera,
    target,
  }).snapshot();

  try {
    await renderFrame(world, render3d, engine, view, 1);
    audit.draws = 0;
    audit.passes = 0;
    await renderFrame(world, render3d, engine, view, 2);
    const pixels = await readPixels(device, target.colorTexture, width, height, configuration.id);
    return {
      profile: renderProfile,
      draws: audit.draws,
      passes: audit.passes,
      pixelHash: pixels.hash,
      nonBlackPixels: pixels.nonBlackPixels,
      pixels: pixels.data,
    };
  } finally {
    world.destroy();
    disposeSceneFrameGpuArena(device);
    volumeTexture?.destroy();
    target.destroy();
    await device.queue.onSubmittedWorkDone();
  }
}

async function renderFrame(world, render3d, engine, view, frameId) {
  world.frameData.begin(world, engine, frameId, 16);
  const context = createRenderFrameContext(engine, {
    frameData: world.frameData,
    view,
    viewFamily: { views: [view] },
    label: `transparent-batching:${view.key}:${frameId}`,
  });
  render3d.record(world, context);
  context.submit();
  await engine.device.queue.onSubmittedWorkDone();
}

function compareProfiles(configuration, reference, optimized) {
  const pixels = comparePixelArrays(reference.pixels, optimized.pixels);
  const result = {
    id: configuration.id,
    kind: configuration.kind,
    entityCount: configuration.count,
    before: {
      profile: reference.profile,
      draws: reference.draws,
      passes: reference.passes,
      pixelHash: reference.pixelHash,
      nonBlackPixels: reference.nonBlackPixels,
    },
    after: {
      profile: optimized.profile,
      draws: optimized.draws,
      passes: optimized.passes,
      pixelHash: optimized.pixelHash,
      nonBlackPixels: optimized.nonBlackPixels,
    },
    drawReduction: reference.draws - optimized.draws,
    pixelComparison: pixels,
  };
  delete reference.pixels;
  delete optimized.pixels;
  return result;
}

function assertGateSemantics(cases) {
  const additive = requiredCase(cases, 'additive-1000');
  if (additive.before.draws !== additive.entityCount) {
    throw new Error(`additive reference draws=${additive.before.draws}, expected ${additive.entityCount}`);
  }
  if (additive.after.draws >= additive.before.draws || additive.after.draws > 2) {
    throw new Error(`additive batching did not reduce actual draws: ${additive.before.draws} -> ${additive.after.draws}`);
  }
  if (additive.drawReduction < 998) {
    throw new Error(`additive draw reduction is too small: ${additive.drawReduction}`);
  }
  for (const item of cases) {
    if (item.before.passes !== 1 || item.after.passes !== 1) {
      throw new Error(`${item.id}: pass count changed or exceeded one (${item.before.passes} -> ${item.after.passes})`);
    }
    if (item.before.nonBlackPixels < 1 || item.after.nonBlackPixels < 1) {
      throw new Error(`${item.id}: fixture did not render visible pixels`);
    }
    if (item.pixelComparison.mismatchedPixels !== 0 || item.pixelComparison.maxChannelDelta !== 0) {
      throw new Error(`${item.id}: pixels changed (${item.pixelComparison.mismatchedPixels} pixels, max delta ${item.pixelComparison.maxChannelDelta})`);
    }
  }
  for (const id of ['alpha-64', 'volume-16']) {
    const item = requiredCase(cases, id);
    if (item.before.draws !== item.entityCount || item.after.draws !== item.entityCount) {
      throw new Error(`${id}: sorted single-object draws changed (${item.before.draws} -> ${item.after.draws}, expected ${item.entityCount})`);
    }
    if (item.drawReduction !== 0) throw new Error(`${id}: unsafe draw reduction=${item.drawReduction}`);
  }
}

function objectPosition(kind, index) {
  if (kind === 'additive') {
    const cell = index % 500;
    const layer = index < 500 ? 0 : 1;
    return [
      (cell % 25 - 12) * 0.24 + layer * 0.025,
      (Math.floor(cell / 25) - 9.5) * 0.24 + layer * 0.015,
      -layer * 0.04,
    ];
  }
  if (kind === 'alpha') {
    return [
      (index % 8 - 3.5) * 0.62,
      (Math.floor(index / 8) - 3.5) * 0.48,
      -((index * 7) % 31) * 0.025,
    ];
  }
  return [
    (index % 4 - 1.5) * 1.05,
    (Math.floor(index / 4) - 1.5) * 0.8,
    -((index * 3) % 7) * 0.04,
  ];
}

function createTriangleGeometry() {
  return new Geometry3D({
    positions: new Float32Array([
      -0.18, -0.16, 0,
      0.18, -0.16, 0,
      0, 0.18, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [{ set: 0, data: new Float32Array([0, 0, 1, 0, 0.5, 1]) }],
    indices: new Uint32Array([0, 1, 2]),
    boundsMode: 'manual',
    localBounds: { center: [0, 0, 0], radius: 0.26 },
  });
}

function createCubeGeometry() {
  return new Geometry3D({
    positions: new Float32Array([
      -0.34, -0.34, -0.34, 0.34, -0.34, -0.34, 0.34, 0.34, -0.34, -0.34, 0.34, -0.34,
      -0.34, -0.34, 0.34, 0.34, -0.34, 0.34, 0.34, 0.34, 0.34, -0.34, 0.34, 0.34,
    ]),
    normals: new Float32Array([
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
      0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6,
      1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
    ]),
    boundsMode: 'manual',
    localBounds: { center: [0, 0, 0], radius: 0.6 },
  });
}

function createVolumeTexture(device) {
  const texture = device.createTexture({
    label: 'transparent-batching.volume',
    size: [4, 4, 4],
    dimension: '3d',
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    new Uint8Array(256 * 4 * 4).fill(176),
    { bytesPerRow: 256, rowsPerImage: 4 },
    { width: 4, height: 4, depthOrArrayLayers: 4 },
  );
  return texture;
}

function createTarget(device, width, height, label) {
  const colorTexture = device.createTexture({
    label: `${label}.color`,
    size: [width, height],
    format: 'bgra8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const depthTexture = device.createTexture({
    label: `${label}.depth`,
    size: [width, height],
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  const outputView = colorTexture.createView();
  const depthTextureView = depthTexture.createView();
  return {
    key: `transparent-batching:${label}`,
    format: 'bgra8unorm',
    width,
    height,
    displayWidth: width,
    displayHeight: height,
    colorTexture,
    depthTexture,
    depthTextureView,
    getOutputView() { return outputView; },
    getRenderPassDescriptor() {
      return {
        label: `transparent-batching:${label}:main`,
        colorAttachments: [{
          view: outputView,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
        depthStencilAttachment: {
          view: depthTextureView,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 1,
        },
      };
    },
    destroy() {
      colorTexture.destroy();
      depthTexture.destroy();
    },
  };
}

function createEngine(device, target) {
  return {
    device,
    format: target.format,
    width: target.width,
    height: target.height,
    displayWidth: target.displayWidth,
    displayHeight: target.displayHeight,
    reverseZ: false,
    msaaSamples: 1,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    depthTextureView: target.depthTextureView,
    msaaTextureView: null,
    assetManager: undefined,
    defaults: {},
    renderProfile: 'simple',
    renderTarget: target,
    getDepthFormat() { return 'depth24plus'; },
    getRenderPassDescriptor() { return target.getRenderPassDescriptor(); },
    getRenderPassDescriptorVersion() { return 1; },
    getOutputView() { return target.getOutputView(); },
    registerDeviceRecoveryParticipant() { return () => {}; },
  };
}

function instrumentDrawAudit(device) {
  const audit = { draws: 0, passes: 0 };
  const originalCreateCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = function(descriptor) {
    const encoder = originalCreateCommandEncoder(descriptor);
    const originalBeginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = function(passDescriptor) {
      audit.passes++;
      const pass = originalBeginRenderPass(passDescriptor);
      for (const method of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
        const original = pass[method].bind(pass);
        pass[method] = function(...args) {
          audit.draws++;
          return original(...args);
        };
      }
      return pass;
    };
    return encoder;
  };
  return audit;
}

async function readPixels(device, texture, width, height, label) {
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const readback = device.createBuffer({
    label: `${label}.readback`,
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder({ label: `${label}.readback` });
  encoder.copyTextureToBuffer(
    { texture },
    { buffer: readback, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readback.getMappedRange());
  const data = new Uint8Array(width * height * 4);
  let hash = 0x811c9dc5;
  let nonBlackPixels = 0;
  for (let y = 0; y < height; y++) {
    const sourceRow = y * bytesPerRow;
    const targetRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x * 4;
      const target = targetRow + x * 4;
      const b = mapped[source] ?? 0;
      const g = mapped[source + 1] ?? 0;
      const r = mapped[source + 2] ?? 0;
      const a = mapped[source + 3] ?? 0;
      data[target] = b;
      data[target + 1] = g;
      data[target + 2] = r;
      data[target + 3] = a;
      if (r + g + b > 12) nonBlackPixels++;
      hash ^= b; hash = Math.imul(hash, 0x01000193);
      hash ^= g; hash = Math.imul(hash, 0x01000193);
      hash ^= r; hash = Math.imul(hash, 0x01000193);
      hash ^= a; hash = Math.imul(hash, 0x01000193);
    }
  }
  readback.unmap();
  readback.destroy();
  return { data, hash: (hash >>> 0).toString(16).padStart(8, '0'), nonBlackPixels };
}

function comparePixelArrays(before, after) {
  if (before.length !== after.length) {
    throw new Error(`pixel buffer length changed: ${before.length} -> ${after.length}`);
  }
  let mismatchedPixels = 0;
  let maxChannelDelta = 0;
  for (let offset = 0; offset < before.length; offset += 4) {
    let mismatch = false;
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs((before[offset + channel] ?? 0) - (after[offset + channel] ?? 0));
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      mismatch ||= delta !== 0;
    }
    if (mismatch) mismatchedPixels++;
  }
  return { comparedPixels: before.length / 4, mismatchedPixels, maxChannelDelta };
}

async function withStrictDevice(adapter, run) {
  const device = await adapter.requestDevice({ label: 'transparent-batching-gate' });
  const uncapturedErrors = [];
  let lost = null;
  const onUncapturedError = event => uncapturedErrors.push(event.error?.message ?? String(event.error ?? event));
  device.addEventListener('uncapturederror', onUncapturedError);
  void device.lost.then(info => {
    if (info.reason !== 'destroyed') lost = info;
  });
  device.pushErrorScope('validation');
  let value;
  let runError = null;
  try {
    value = await run(device);
  } catch (error) {
    runError = error;
  }
  await device.queue.onSubmittedWorkDone().catch(error => { runError ??= error; });
  const scopedError = await device.popErrorScope().catch(error => error);
  device.removeEventListener('uncapturederror', onUncapturedError);
  const failures = [...uncapturedErrors];
  if (scopedError) failures.push(scopedError.message ?? String(scopedError));
  if (lost) failures.push(`device lost: ${lost.message || lost.reason}`);
  device.destroy();
  if (runError || failures.length) {
    const messages = [
      runError instanceof Error ? runError.stack ?? runError.message : String(runError ?? ''),
      ...failures,
    ].filter(Boolean);
    throw new Error(`transparent batching strict WebGPU validation failed:\n${messages.join('\n')}`);
  }
  return value;
}

function requiredCase(cases, id) {
  const result = cases.find(item => item.id === id);
  if (!result) throw new Error(`Missing transparent batching case ${id}`);
  return result;
}

function plainAdapterInfo(info) {
  return {
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
  };
}
