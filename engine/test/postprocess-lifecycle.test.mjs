import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PostProcessPass,
  PostProcessRenderer,
  PostProcessRenderFeature,
  PostProcessSceneTextureStore,
  TaaPass,
  MotionBlurPass,
} from '../dist/experimental.js';
import { GtaoPass, SaoPass, SsaoPass } from '../dist/postprocess.js';

test('PostProcessRenderer destroys removed passes and prepares re-added passes', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const renderer = new PostProcessRenderer();
  const a = new LifecyclePass('a', log);
  const b = new LifecyclePass('b', log);
  const outputView = { label: 'output' };

  renderer.prepare(engine);
  renderer.run({}, [a, b], outputView);
  assert.deepEqual(log.filter(item => item[0] === 'prepare').map(item => item[1]), ['a', 'b']);

  renderer.run({}, [b], outputView);
  assert.equal(log.filter(item => item[0] === 'destroy' && item[1] === 'a').length, 1);
  assert.equal(log.filter(item => item[0] === 'destroy' && item[1] === 'b').length, 0);

  renderer.run({}, [], outputView);
  assert.equal(log.filter(item => item[0] === 'destroy' && item[1] === 'b').length, 1);

  renderer.run({}, [a], outputView);
  assert.equal(log.filter(item => item[0] === 'prepare' && item[1] === 'a').length, 2);
});

test('PostProcessRenderer owns view-sized scene MSAA and depth attachments', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const renderer = new PostProcessRenderer();
  renderer.prepare(engine, 320, 180, 'rgba8unorm');

  const descriptor = renderer.getScenePassDescriptor({
    sampleCount: 4,
    reverseZ: true,
    clearColor: { r: 0.1, g: 0.2, b: 0.3, a: 1 },
    loadOp: 'clear',
    depthFormat: 'depth32float',
  });
  const attachmentCount = log.filter(item => item[0] === 'createTexture').length;

  assert.equal(renderer.width, 320);
  assert.equal(renderer.height, 180);
  assert.equal(renderer.format, 'rgba8unorm');
  assert.ok(descriptor.colorAttachments[0].resolveTarget);
  assert.equal(descriptor.depthStencilAttachment.depthClearValue, 0);
  assert.ok(log.some(item => item[0] === 'createTexture' && item[1].label === 'PostProcessRenderer.sceneMsaaTexture' && item[1].sampleCount === 4));
  assert.ok(log.some(item => item[0] === 'createTexture' && item[1].label === 'PostProcessRenderer.sceneDepthTexture' && item[1].size[0] === 320));

  renderer.getScenePassDescriptor({
    sampleCount: 4,
    reverseZ: true,
    clearColor: { r: 1, g: 1, b: 1, a: 1 },
    loadOp: 'clear',
    depthFormat: 'depth32float',
  });
  assert.equal(log.filter(item => item[0] === 'createTexture').length, attachmentCount);
  renderer.destroy();
});

test('PostProcessRenderer captures resolved scene color into a stable sampling texture', () => {
  ensureGpuTextureUsage();
  const log = [];
  const renderer = new PostProcessRenderer();
  renderer.prepare(createPostProcessEngine(log), 64, 32, 'rgba8unorm');
  const encoder = {
    copyTextureToTexture(source, destination, size) {
      log.push(['copyTextureToTexture', source, destination, size]);
    },
  };
  const first = renderer.captureSceneColor(encoder);
  const second = renderer.captureSceneColor(encoder);
  assert.equal(first, second);
  assert.deepEqual(log.filter(item => item[0] === 'copyTextureToTexture').map(item => item[3]), [
    [64, 32, 1],
    [64, 32, 1],
  ]);
  assert.equal(log.filter(item => item[0] === 'createTexture' && item[1].label === 'PostProcessRenderer.pingPongTexture').length, 1);
  renderer.destroy();
});

test('PostProcessRenderer retains view-sized attachments until command submission is safe', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const renderer = new PostProcessRenderer();
  renderer.prepare(engine, 320, 180, 'rgba8unorm');
  const options = {
    sampleCount: 1,
    reverseZ: false,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: 'clear',
    depthFormat: 'depth24plus',
  };
  renderer.getScenePassDescriptor(options);
  const firstCreateCount = log.filter(item => item[0] === 'createTexture').length;
  renderer.resize(128, 96, 'rgba8unorm');
  renderer.getScenePassDescriptor(options);
  renderer.resize(320, 180, 'rgba8unorm');
  renderer.getScenePassDescriptor(options);

  assert.equal(log.some(item => item[0] === 'destroyTexture'), false);
  assert.equal(log.filter(item => item[0] === 'createTexture').length, firstCreateCount + 2);
  renderer.destroy();
  assert.ok(log.some(item => item[0] === 'destroyTexture'));
});

test('PostProcessRenderer sweeps obsolete view sizes only after submitted GPU work completes', async () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const renderer = new PostProcessRenderer();
  const callbacks = [];
  const options = {
    sampleCount: 1,
    reverseZ: false,
    clearColor: { r: 0, g: 0, b: 0, a: 1 },
    loadOp: 'clear',
    depthFormat: 'depth24plus',
  };
  renderer.prepare(engine, 320, 180, 'rgba8unorm');
  renderer.beginFrame(1, callback => callbacks.push(callback));
  renderer.getScenePassDescriptor(options);
  renderer.resize(128, 96, 'rgba8unorm');
  renderer.getScenePassDescriptor(options);
  renderer.beginFrame(2, callback => callbacks.push(callback));
  renderer.getScenePassDescriptor(options);
  assert.equal(log.some(item => item[0] === 'destroyTexture'), false);

  callbacks[1]({ onSubmittedWorkDone: () => Promise.resolve() });
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(log.filter(item => item[0] === 'destroyTexture').length >= 2);
});

test('PostProcessSceneTextureStore allocates high-precision AO inputs only when requested', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const store = new PostProcessSceneTextureStore();

  store.ensure(engine, { depth: false, normal: false, outlineMask: false }, false);
  assert.equal(log.some(item => item[0] === 'createTexture'), false);
  assert.equal(store.auxDepthTexture, null);

  store.ensure(engine, { depth: true, normal: false, outlineMask: false, auxDepth: false }, false);
  assert.ok(store.depthTexture);
  assert.equal(store.auxDepthTexture, null);
  assert.ok(log.some(item => item[0] === 'createTexture'
    && item[1].label === 'PostProcessSceneTextureStore.depthTexture'
    && item[1].format === 'r32float'));

  store.ensure(engine, { depth: true, normal: true, outlineMask: false, auxDepth: false }, false);
  assert.ok(store.normalTexture);
  assert.ok(log.some(item => item[0] === 'createTexture'
    && item[1].label === 'PostProcessSceneTextureStore.normalTexture'
    && item[1].format === 'rgba16float'));

  store.ensure(engine, { depth: true, normal: false, outlineMask: false, auxDepth: true }, false);
  assert.ok(store.auxDepthTexture);
  assert.equal(log.filter(item => item[0] === 'createTexture' && item[1].label === 'PostProcessSceneTextureStore.auxDepthTexture').length, 1);
});

test('PostProcessSceneTextureStore allocates signed motion vectors only when requested', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const store = new PostProcessSceneTextureStore();

  store.ensure(engine, { depth: false, normal: false, motion: false, outlineMask: false }, false);
  assert.equal(store.motionTexture, null);
  store.ensure(engine, { depth: true, normal: false, motion: true, outlineMask: false, auxDepth: true }, false);
  assert.ok(store.motionTexture);
  assert.ok(log.some(item => item[0] === 'createTexture'
    && item[1].label === 'PostProcessSceneTextureStore.motionTexture'
    && item[1].format === 'rg16float'));
});

test('PostProcessSceneTextureStore matches the visible outline attachment to scene MSAA', () => {
  ensureGpuTextureUsage();
  const log = [];
  const engine = createPostProcessEngine(log);
  const store = new PostProcessSceneTextureStore();

  store.ensure(
    engine,
    { depth: false, normal: false, outlineMask: true, auxDepth: true },
    false,
    { width: 320, height: 180, format: 'rgba8unorm', sampleCount: 4 },
  );

  assert.ok(store.outlineVisibleMaskView);
  assert.ok(store.outlineVisibleMaskMsaaView);
  assert.ok(log.some(item => item[0] === 'createTexture'
    && item[1].label === 'PostProcessSceneTextureStore.outlineVisibleMaskMsaaTexture'
    && item[1].sampleCount === 4));

  store.ensure(
    engine,
    { depth: false, normal: false, outlineMask: true, auxDepth: true },
    false,
    { width: 320, height: 180, format: 'rgba8unorm', sampleCount: 1 },
  );
  assert.equal(store.outlineVisibleMaskMsaaTexture, null);
  assert.equal(store.outlineVisibleMaskMsaaView, null);
});

test('PostProcessRenderFeature defaults to render system priority without fractional sort offset', () => {
  const renderSystem = { priority: 12, passes: [], requiresIsolatedPass: false };
  const pass = new LifecyclePass('feature-pass', []);
  const feature = new PostProcessRenderFeature(renderSystem, [pass]);

  assert.equal(feature.priority, 12);
  assert.equal(feature.renderPipelineOptions.sort, 12);
  assert.equal(renderSystem.requiresIsolatedPass, true);
  assert.deepEqual(renderSystem.passes, [pass]);
});

test('OutlinePass keeps additive compositing by default and supports dark multiply outlines', async () => {
  const { OutlinePass } = await import('../dist/experimental.js');

  assert.equal(new OutlinePass().blendMode, 'add');
  assert.equal(new OutlinePass({ blendMode: 'multiply' }).blendMode, 'multiply');
  assert.equal(new OutlinePass({ blendMode: 'replace' }).blendMode, 'replace');
});

test('TaaPass owns projection jitter and exposes explicit history reset diagnostics', () => {
  const taa = new TaaPass();
  const first = new Float32Array(2);
  const repeated = new Float32Array(2);

  assert.equal(taa.needsDepthTexture, true);
  assert.equal(taa.getProjectionJitter({ viewKey: 'main', frameId: 0, width: 800, height: 450 }, first), true);
  assert.equal(taa.getProjectionJitter({ viewKey: 'main', frameId: 8, width: 800, height: 450 }, repeated), true);
  assert.deepEqual(Array.from(repeated), Array.from(first), 'the eight-sample Halton sequence must repeat deterministically');
  assert.ok(Math.abs(first[0]) <= 0.5 && Math.abs(first[1]) <= 0.5);
  assert.deepEqual(taa.stats, { historyCount: 0, validHistoryCount: 0 });
  taa.resetHistory();
  assert.throws(() => new TaaPass({ feedback: Number.NaN }), /feedback must be finite/);
});

test('MotionBlurPass separates shutter exposure, artistic intensity, display, and reconstruction controls', () => {
  const blur = new MotionBlurPass({
    shutterAngle: 210,
    intensity: 2.5,
    sampleCount: 16,
    maxBlurPixels: 24,
    displayMode: 'split',
    reconstruction: 'tile-neighbor-max',
    splitPosition: 0.42,
    depthThreshold: 0.02,
  });
  assert.equal(blur.needsDepthTexture, undefined);
  assert.equal(blur.needsMotionTexture, true);
  assert.equal(blur.shutterAngle, 210);
  assert.equal(blur.intensity, 2.5);
  assert.equal(blur.sampleCount, 16);
  assert.equal(blur.displayMode, 'split');
  assert.equal(blur.reconstruction, 'tile-neighbor-max');
  assert.equal(blur.splitPosition, 0.42);
  assert.deepEqual(blur.stats, { appliedFrameCount: 0, lastFrameId: -1 });
  const revision = blur.getMotionHistoryRevision();
  blur.resetHistory();
  assert.equal(blur.getMotionHistoryRevision(), revision + 1);
  assert.throws(() => new MotionBlurPass({ sampleCount: 0 }), /sampleCount/);
  assert.throws(() => new MotionBlurPass({ intensity: Number.NaN }), /intensity/);
  assert.throws(() => new MotionBlurPass({ displayMode: 'invalid' }), /displayMode/);
  assert.throws(() => new MotionBlurPass({ maxBlurPixels: Number.NaN }), /maxBlurPixels/);
});

test('ambient occlusion exposes three algorithms through one depth/normal ABI and a shared edge-aware resolve', async () => {
  const passes = [new GtaoPass(), new SaoPass({ quality: 'low' }), new SsaoPass({ quality: 'high', displayMode: 'occlusion' })];
  assert.deepEqual(passes.map(pass => pass.algorithm), ['gtao', 'sao', 'ssao']);
  assert.deepEqual(passes.map(pass => pass.label), ['GTAO', 'SAO', 'SSAO']);
  assert.ok(passes.every(pass => pass.needsDepthTexture && pass.needsNormalTexture));
  assert.deepEqual(passes.map(pass => pass.stats.sampleCount), [16, 8, 32]);
  assert.deepEqual(passes.map(pass => pass.stats.sampleProbeCount), [36, 8, 32]);
  assert.deepEqual(passes.map(pass => pass.radius), [1.25, 1.25, 1.25]);
  assert.deepEqual(passes.map(pass => pass.stats.renderPassCount), [3, 3, 3]);
  assert.deepEqual(passes.map(pass => pass.stats.resolutionScale), [0.5, 0.5, 0.5]);
  assert.deepEqual(passes.map(pass => pass.stats.scratchFormat), ['r8unorm', 'r8unorm', 'r8unorm']);
  assert.equal(passes[2].displayMode, 'occlusion');
  assert.throws(() => new GtaoPass({ radius: Number.NaN }), /radius must be finite/);
  assert.throws(() => new SaoPass({ quality: 'ultra' }), /quality must be/);
  assert.throws(() => new SaoPass({ resolutionScale: 0.75 }), /resolutionScale must be/);
  assert.throws(() => new SaoPass({ scratchFormat: 'rgba16float' }), /scratchFormat must be/);

  const sources = await Promise.all(['gtao', 'sao', 'ssao', 'ao-denoise', 'ao-upscale'].map(name => readFile(
    new URL(`../src/shaders/generated/postprocess-${name}.generated.wgsl`, import.meta.url),
    'utf8',
  )));
  for (const source of sources) {
    assert.match(source, /haiyue:builtin-postprocess/);
    assert.match(source, /linearDepthTexture/);
    assert.match(source, /viewNormalTexture/);
    assert.doesNotMatch(source, /@group\(3\)/);
  }
  for (const source of sources.slice(0, 3)) {
    assert.match(source, /aoRotation\(aoPixel\(input\.uv\)\)/);
    assert.match(source, /inverseProjectionMatrix/);
    assert.match(source, /fn aoViewRadius\(\) -> f32/);
    assert.doesNotMatch(source, /radiusIntensityBiasPower\.x \* params\.resolution\.z/);
    assert.doesNotMatch(source, /let p00|let top = mix|let bottom = mix/);
  }
  assert.match(sources[0], /gtaoUpdateHorizon/);
  assert.match(sources[0], /distanceFactor \* distanceFactor/);
  assert.match(sources[0], /normalSin \* nxb \+ normalCos \* nyb/);
  assert.match(sources[1], /scaledDistance/);
  assert.match(sources[1], /aoProjectUv\(center \+ sampleDirection \* ring \* radiusView\)/);
  assert.match(sources[1], /1\.0 \+ scaledDistance \* scaledDistance/);
  assert.match(sources[2], /depthDelta > minDistance && depthDelta < maxDistance/);
  assert.match(sources[3], /ambientOcclusionTexture/);
  assert.match(sources[3], /for \(var index = 0; index < 16/);
  assert.match(sources[3], /abs\(dot\(centerPosition - samplePosition, centerNormal\)\)/);
  assert.match(sources[3], /lumaWeight \* depthWeight \* normalWeight/);
  assert.match(sources[4], /for \(var y = 0; y < 2/);
  assert.match(sources[4], /depthWeight \* normalWeight/);
  assert.match(sources[4], /visibility \/ totalWeight/);
});

test('ambient occlusion owns half-resolution single-channel raw and denoised AO targets', () => {
  ensureMotionBlurGpuGlobals();
  const log = [];
  const device = createMotionBlurAdapterDevice(log);
  const first = new GtaoPass();
  const second = new SaoPass();
  first.prepare(device, 'rgba8unorm', 96, 64);
  second.prepare(device, 'rgba8unorm', 96, 64);

  assert.equal(log.filter(entry => entry[0] === 'createShaderModule').length, 4);
  assert.equal(log.filter(entry => entry[0] === 'createBindGroupLayout').length, 4);
  assert.equal(log.filter(entry => entry[0] === 'createPipelineLayout').length, 4);
  assert.equal(log.filter(entry => entry[0] === 'createTexture'
    && entry[1].format === 'r8unorm'
    && entry[1].size[0] === 48
    && entry[1].size[1] === 32
    && /Pass\.(raw|denoised)OcclusionTexture$/.test(entry[1].label)).length, 4);
  assert.deepEqual(first.stats, {
    algorithm: 'gtao',
    frameCount: 0,
    sampleCount: 16,
    sampleProbeCount: 36,
    renderPassCount: 3,
    resolutionScale: 0.5,
    scratchFormat: 'r8unorm',
    scratchWidth: 48,
    scratchHeight: 32,
    rawTextureBytes: 1536,
    denoisedTextureBytes: 1536,
    scratchTextureBytes: 3072,
    estimatedBandwidth: {
      occlusionBytes: 241152,
      denoiseBytes: 340992,
      upscaleBytes: 442368,
      totalBytes: 1024512,
    },
  });

  first.destroy();
  second.destroy();
  assert.equal(log.filter(entry => entry[0] === 'destroyTexture').length, 4);
  assert.equal(log.filter(entry => entry[0] === 'destroyBuffer').length, 2);
});

test('generated motion blur artifact uses deterministic tile/neighbor reconstruction and pinned provenance', async () => {
  const [reconstruction, tileMax, neighborMax] = await Promise.all([
    readFile(new URL('../src/shaders/generated/motion-blur-resolve.generated.wgsl', import.meta.url), 'utf8'),
    readFile(new URL('../src/shaders/generated/motion-tile-max.generated.wgsl', import.meta.url), 'utf8'),
    readFile(new URL('../src/shaders/generated/motion-neighbor-max.generated.wgsl', import.meta.url), 'utf8'),
  ]);
  for (const source of [reconstruction, tileMax, neighborMax]) {
    assert.match(source, /haiyue:typed-ir bcf86dd8d974d52061e010f2700df013dbc850f922e7f8853217caad5a6b0f0b/);
    assert.match(source, /@group\(0\)/);
    assert.doesNotMatch(source, /@group\(3\)/);
  }
  assert.match(reconstruction, /velocityScale = params\.settings\.x \* params\.settings\.y/);
  assert.match(reconstruction, /textureLoad\(neighborMaxTexture, tile, 0\)/);
  assert.match(reconstruction, /stationaryReceiver/);
  assert.match(reconstruction, /velocityHeatmap/);
  assert.match(reconstruction, /params\.display\.x > 0\.5/);
  assert.doesNotMatch(reconstruction, /for \(var y = -2|candidatePixel|maximumMotion|depthTexture/);
  assert.match(tileMax, /origin = tile \* params\.tileSize/);
  assert.match(tileMax, /y < 8u/);
  assert.match(neighborMax, /for \(var y = -1; y <= 1/);
  assert.match(neighborMax, /strongestMagnitude/);
});

test('MotionBlurPass reuses generated shader runtimes per device and destroys instance-owned resources', () => {
  ensureMotionBlurGpuGlobals();
  const log = [];
  const device = createMotionBlurAdapterDevice(log);
  const first = new MotionBlurPass();
  const second = new MotionBlurPass({ reconstruction: 'tile-neighbor-max' });
  first.prepare(device, 'rgba8unorm', 64, 32);
  second.prepare(device, 'rgba8unorm', 64, 32);

  assert.equal(log.filter(entry => entry[0] === 'createShaderModule').length, 3);
  assert.equal(log.filter(entry => entry[0] === 'createBindGroupLayout').length, 3);
  assert.equal(log.filter(entry => entry[0] === 'createPipelineLayout').length, 3);
  assert.ok(log.filter(entry => entry[0] === 'createShaderModule')
    .every(entry => entry[1].code.includes('haiyue:typed-ir') && entry[1].code.includes('@group(0)')));
  assert.deepEqual(
    log.filter(entry => entry[0] === 'createBuffer').map(entry => entry[1].size),
    [48, 16, 48, 16],
  );

  first.destroy();
  second.destroy();
  assert.equal(log.filter(entry => entry[0] === 'destroyBuffer').length, 4);
  assert.equal(log.filter(entry => entry[0] === 'destroyTexture').length, 4);
});

test('motion vectors interpolate previous clip position before perspective division', async () => {
  const source = await readFile(
    new URL('../src/shaders/generated/deformation-motion-vector.generated.wgsl', import.meta.url),
    'utf8',
  );
  assert.match(source, /@location\(0\) @interpolate\(perspective, center\) previousClipPosition : vec4<f32>/);
  assert.match(source, /currentUv = input\.clipPosition\.xy \* sceneFrame\.viewport\.zw/);
  assert.doesNotMatch(source, /@interpolate\(linear\).*previousUv/);
});

class LifecyclePass extends PostProcessPass {
  constructor(label, log) {
    super();
    this.label = label;
    this._log = log;
  }

  prepare() {
    this._log.push(['prepare', this.label]);
  }

  apply() {
    this._log.push(['apply', this.label]);
  }

  destroy() {
    this._log.push(['destroy', this.label]);
  }
}

function createPostProcessEngine(log) {
  return {
    device: createPostProcessDevice(log),
    format: 'bgra8unorm',
    width: 64,
    height: 32,
    msaaSamples: 1,
    getDepthFormat(reverseZ) {
      return reverseZ ? 'depth32float' : 'depth24plus';
    },
  };
}

function createPostProcessDevice(log) {
  return {
    createTexture(descriptor) {
      log.push(['createTexture', descriptor]);
      return {
        label: descriptor.label,
        createView() {
          const view = { label: `${descriptor.label ?? 'texture'}:view` };
          log.push(['createView', descriptor.label, view]);
          return view;
        },
        destroy() {
          log.push(['destroyTexture', descriptor.label]);
        },
      };
    },
  };
}

function ensureGpuTextureUsage() {
  globalThis.GPUTextureUsage ??= {};
  globalThis.GPUTextureUsage.RENDER_ATTACHMENT ??= 1 << 0;
  globalThis.GPUTextureUsage.TEXTURE_BINDING ??= 1 << 1;
  globalThis.GPUTextureUsage.COPY_SRC ??= 1 << 2;
  globalThis.GPUTextureUsage.COPY_DST ??= 1 << 3;
}

function ensureMotionBlurGpuGlobals() {
  ensureGpuTextureUsage();
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  globalThis.GPUBufferUsage ??= { UNIFORM: 1, COPY_DST: 2 };
}

function createMotionBlurAdapterDevice(log) {
  return {
    queue: { writeBuffer() {} },
    createShaderModule(descriptor) {
      log.push(['createShaderModule', descriptor]);
      return { descriptor };
    },
    createBindGroupLayout(descriptor) {
      log.push(['createBindGroupLayout', descriptor]);
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      log.push(['createPipelineLayout', descriptor]);
      return { descriptor };
    },
    createSampler(descriptor) {
      log.push(['createSampler', descriptor]);
      return { descriptor };
    },
    createBuffer(descriptor) {
      log.push(['createBuffer', descriptor]);
      return {
        descriptor,
        destroy() { log.push(['destroyBuffer', descriptor.label]); },
      };
    },
    createTexture(descriptor) {
      log.push(['createTexture', descriptor]);
      return {
        descriptor,
        createView() { return { descriptor }; },
        destroy() { log.push(['destroyTexture', descriptor.label]); },
      };
    },
    createBindGroup(descriptor) {
      log.push(['createBindGroup', descriptor]);
      return { descriptor };
    },
  };
}
