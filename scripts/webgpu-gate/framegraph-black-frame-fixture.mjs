import { createRealRendererBenchmarkScenario, runRealRendererBenchmarkFrame, destroyRealRendererBenchmarkScenario, createAuditTarget,
  resetRealRendererBenchmarkMetrics, Entity, Camera3D, Transform3D, Mesh3D, PbrMaterial, AmbientLight, PointLight, RenderView,
  createBox3D, createDeferredReferenceProfile, GtaoPass, SaoPass, SsaoPass, GaussianBlurPass, 
} from '../../artifacts/engine-0.2.1/g09/oracle-runtime/fixture.js';
import { readFloatTexture } from './float-texture-readback.mjs';
import { arithmeticPostprocessProbe } from './framegraph-black-frame-policy.mjs';
import { nativeReadbackDevice, createReadbackControls, captureAtomicReadback } from './framegraph-atomic-readback.mjs';
const node = document.querySelector('#result');
const check = (value, message) => { if (!value) throw Error(message); };
const preference = new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance';
const coverage = new URLSearchParams(location.search).get('coverage') ?? 'production';
const readback = new URLSearchParams(location.search).get('readback') ?? 'sequential';
const access = new URLSearchParams(location.search).get('access') ?? 'audited';
const chain = new URLSearchParams(location.search).get('chain') ?? 'full';
const aoScratch = new URLSearchParams(location.search).get('aoScratch') ?? 'r8unorm';
let failedCapture;
// Install before the benchmark audit wraps native objects. Never mutate audit proxies.
// This diagnostic variant explicitly restores each attachment's extent after a
// pipeline bind; production behavior and frozen A0 bundles remain unchanged.
function observeCoverage(device) {
  const views = new WeakMap(), records = [], shaderSubstitutions = [];
  const createShaderModule = device.createShaderModule.bind(device);
  device.createShaderModule = descriptor => {
    const code = coverage === 'arithmetic-chain' ? arithmeticPostprocessProbe(descriptor.code) : descriptor.code;
    if (code !== descriptor.code) shaderSubstitutions.push({ label: descriptor.label,
      originalBytes: new TextEncoder().encode(descriptor.code).length, substitutedBytes: new TextEncoder().encode(code).length });
    return createShaderModule(code === descriptor.code ? descriptor : { ...descriptor, code });
  };
  const createTexture = device.createTexture.bind(device);
  device.createTexture = descriptor => {
    const texture = createTexture(descriptor), createView = texture.createView.bind(texture);
    texture.createView = (descriptor = {}) => {
      const view = createView(descriptor), mip = descriptor.baseMipLevel ?? 0;
      views.set(view, [Math.max(1, texture.width >> mip), Math.max(1, texture.height >> mip)]); return view;
    }; return texture;
  };
  const createEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = descriptor => {
    const encoder = createEncoder(descriptor), begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = descriptor => {
      const pass = begin(descriptor), attachment = [...descriptor.colorAttachments].find(Boolean)?.view ?? descriptor.depthStencilAttachment?.view;
      const extent = views.get(attachment); check(extent, `Missing probe extent: ${descriptor.label}`);
      const pipeline = pass.setPipeline.bind(pass), setViewport = pass.setViewport.bind(pass), setScissor = pass.setScissorRect.bind(pass);
      let viewport = [0, 0, ...extent, 0, 1], scissor = [0, 0, ...extent];
      pass.setViewport = (...args) => { viewport = args; return setViewport(...args); };
      pass.setScissorRect = (...args) => { scissor = args; return setScissor(...args); };
      pass.setPipeline = value => {
        pipeline(value);
        if (coverage === 'after-pipeline') { setViewport(...viewport); setScissor(...scissor); }
        records.push({ pass: descriptor.label, pipeline: value.label, extent, viewport, scissor });
      }; return pass;
    }; return encoder;
  }; return { coverageRecords: records, shaderSubstitutions };
}
async function capture(copySource) {
  check(['production', 'after-pipeline', 'arithmetic-chain'].includes(coverage), 'Unknown coverage experiment');
  check(['sequential', 'atomic'].includes(readback) && ['audited', 'native', 'native-encoding'].includes(access), 'Unknown readback experiment');
  check(readback === 'atomic' || access === 'audited', 'Native bypass requires atomic diagnostics');
  check(!new URLSearchParams(location.search).has('completion'), 'Queue-wait candidate was not adopted');
  check(['full', 'none', 'blur', 'gtao', 'sao', 'ssao'].includes(chain), 'Unknown chain isolation experiment');
  check(['r8unorm', 'r16float'].includes(aoScratch), 'Unknown AO scratch experiment');
  const algorithm = 'forward', count = 1, mixed = false;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: preference });
  check(adapter && !adapter.info.isFallbackAdapter, 'native GPU required');
  const device = await adapter.requestDevice(), errors = [], targets = [];
  let phase = 'setup', deviceLoss = null;
  void device.lost.then(info => { if (phase !== 'intentional-destroy') deviceLoss = { reason: info.reason, message: info.message, phase }; });
  const native = nativeReadbackDevice(device);
  const { coverageRecords, shaderSubstitutions } = observeCoverage(device);
  device.addEventListener('uncapturederror', e => errors.push(e.error.message)); device.pushErrorScope('validation');
  let state, profile, result, failure, controls;
  try {
    for (let i = 0; i < count; i++) targets.push(createAuditTarget(device, mixed && i % 2 ? 48 : 64, mixed && i % 2 ? 40 : 64, copySource));
    state = await createRealRendererBenchmarkScenario({ device, target: targets[0], entityCount: 0, renderProfile: 'batched' });
    for (const entity of [...state.world.entities.values()]) state.world.removeEntity(entity);
    state.views = targets.map((target, i) => {
      const camera = new Entity(`camera:${i}`).addComponent(new Transform3D().setTranslation(i * .13, 0, 4))
        .addComponent(new Camera3D({ type: 'orthographic', left: -2, right: 2, bottom: -2, top: 2, near: .1, far: 20 }));
      state.world.add(camera); return new RenderView({ key: `view:${i}`, camera, target }).snapshot();
    });
    for (let i = 0; i < 3; i++) state.world.add(new Entity(`box:${i}`).addComponent(new Transform3D().setTranslation((i - 1) * .7, 0, i * .2))
      .addComponent(new Mesh3D(createBox3D({ width: 1, height: 1, depth: .6 }), new PbrMaterial({ baseColor: [.2 + i * .2, .6, .3, 1], roughness: .6, clearcoatFactor: .2 }))));
    state.world.add(new Entity('ambient').addComponent(new AmbientLight({ intensity: 1 })));
    for (let i = 0; i < 16; i++) state.world.add(new Entity(`light:${i}`).addComponent(new Transform3D().setTranslation((i % 4) - 1.5, 1, 2))
      .addComponent(new PointLight({ range: 8, intensity: .1 })));
    const aoOptions = { quality: 'low', scratchFormat: aoScratch };
    const passes = chain === 'full' ? [new GtaoPass(aoOptions), new SaoPass(aoOptions), new SsaoPass(aoOptions), new GaussianBlurPass(), new GaussianBlurPass()]
      : chain === 'blur' ? [new GaussianBlurPass(), new GaussianBlurPass()] : chain === 'gtao' ? [new GtaoPass(aoOptions)]
      : chain === 'sao' ? [new SaoPass(aoOptions)] : chain === 'ssao' ? [new SsaoPass(aoOptions)] : [];
    state.render3d.passes.splice(0, state.render3d.passes.length, ...passes);
    state.render3d.checkEntityManager(state.world);
    if (algorithm !== 'forward') profile = await createDeferredReferenceProfile(state.render3d, state.engine,
      algorithm === 'tiled' ? { tiled: { forceCulling: true } } : {});
    const encodedOutput = [];
    let outputSource;
    const output = state.render3d._postScenePasses.output, apply = output.apply.bind(output);
    output.apply = (encoder, src, dst, device) => {
      outputSource = src;
      const calls = [];
      const observed = new Proxy(encoder, { get(target, key) {
        if (key === 'beginRenderPass') return descriptor => {
          // Alpha zero keeps the full-coverage assertion strict; magenta RGB
          // distinguishes untouched clear from a shader writing transparent black.
          if (descriptor.label === 'SceneOutput.renderPass') descriptor = { ...descriptor,
            colorAttachments: [...descriptor.colorAttachments].map(attachment => attachment && {
              ...attachment, clearValue: { r: 1, g: 0, b: 1, a: 0 },
            }) };
          const pass = target.beginRenderPass(descriptor);
          return new Proxy(pass, { get(targetPass, method) {
            const value = Reflect.get(targetPass, method, targetPass);
            if (descriptor.label === 'SceneOutput.renderPass' && ['setViewport', 'setScissorRect', 'setPipeline', 'draw'].includes(method))
              return (...args) => { calls.push({ method, args: method === 'setPipeline' ? [args[0].label] : args }); return value.apply(targetPass, args); };
            return typeof value === 'function' ? value.bind(targetPass) : value;
          } });
        };
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      encodedOutput.push({ source: [src.width, src.height, src.format], target: [output._view?.target.width, output._view?.target.height], calls });
      return apply(observed, src, dst, device);
    };
    if (readback === 'atomic') controls = createReadbackControls(access === 'audited' ? device : native);
    if (access === 'native-encoding') {
      // Isolate command/pass/bundle audit proxies while retaining resource tracking.
      // This is a diagnostic population, never benchmark/qualification evidence.
      device.createCommandEncoder = native.createCommandEncoder;
      device.createRenderBundleEncoder = native.createRenderBundleEncoder;
    }
    for (let i = 0; i < 4; i++) { phase = `warmup-${i + 1}`; await runRealRendererBenchmarkFrame(state); }
    resetRealRendererBenchmarkMetrics(state);
    const beforePasses = state.audit.renderPasses;
    phase = 'capture-frame'; await runRealRendererBenchmarkFrame(state);
    const actualPasses = access === 'native-encoding' ? null : state.audit.renderPasses - beforePasses;
    phase = 'readback';
    const pixels = readback === 'atomic' ? await captureAtomicReadback(access === 'audited' ? device : native,
      targets[0].colorTexture, outputSource, controls, { copySource, frameId: state.frameId, access }) : {
      computed: Array.from(await readFloatTexture(device, targets[0].colorTexture)),
      copied: copySource ? await copyPixels(device, targets[0].colorTexture) : null,
      sourcePixels: Array.from(await readFloatTexture(device, outputSource)),
      readbackWitness: await readWitness(device, targets[0].colorTexture, outputSource),
    };
    result = { copySource, warmup: 4, frames: 1, width: 64, height: 64,
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter },
      ...pixels, chain, aoScratch, readback, access, coverage, coverageRecords, shaderSubstitutions, clearSentinel: [1, 0, 1, 0], encodedOutput, actualPasses,
      instrumentation: { nativeReadback: access !== 'audited', nativeCommandEncoding: access === 'native-encoding',
        resourceTracking: true, benchmarkMetricsAvailable: access !== 'native-encoding' } };
    failedCapture = result;
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    phase = 'cleanup';
    controls?.destroy();
    if (state) {
      if (access === 'native-encoding') {
        // Audit draw counters intentionally omit the native commands. Reset only
        // the metric window before shared destruction, NOT resource ownership.
        if (result) result.excludedMetrics = { reason: 'Native encoding bypasses pass/bundle audit counters; no performance or pass-reduction claims',
          measuredFrames: state.measuredFrames, diagnostics: { ...state.diagnosticTotals } };
        resetRealRendererBenchmarkMetrics(state);
      }
      try { await destroyRealRendererBenchmarkScenario(state); }
      catch (error) { if (!failure) throw error; failure.stack += `\nCleanup: ${error.stack}`; }
      if (result) result.cleanup = { ownerResidual: state.finalMetrics.ownerResidual, liveGpuResources: state.finalMetrics.liveGpuResources };
    }
    for (const target of targets) target.destroy();
    const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
    if (result) { result.validationErrors = errors; result.deviceLoss = deviceLoss; }
    phase = 'intentional-destroy';
    device.destroy();
  }
}
// Independent execution/dimension witness. It cannot replace a failed image or
// establish that an earlier compute readback ran correctly; a failed witness
// makes this capture unreliable even if the image happens to look plausible.
async function readWitness(device, target, source) {
  const storage = device.createBuffer({ size: 32, mappedAtCreation: true, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    new Uint32Array(storage.getMappedRange()).fill(0xffffffff); storage.unmap();
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var targetImage: texture_2d<f32>;
      @group(0) @binding(1) var sourceImage: texture_2d<f32>;
      @group(0) @binding(2) var<storage, read_write> witness: array<vec4<u32>, 2>;
      @compute @workgroup_size(1) fn main() {
        witness[0] = vec4<u32>(4660u, textureDimensions(targetImage), 22136u);
        witness[1] = vec4<u32>(4660u, textureDimensions(sourceImage), 22136u);
      }` });
    const compilation = await module.getCompilationInfo();
    check(!compilation.messages.some(message => message.type === 'error'), JSON.stringify(compilation.messages));
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: target.createView() }, { binding: 1, resource: source.createView() }, { binding: 2, resource: { buffer: storage } },
    ] });
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 32); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = Array.from(new Uint32Array(readback.getMappedRange())); readback.unmap(); return values;
  } finally { storage.destroy(); readback.destroy(); }
}
async function copyPixels(device, texture) {
  const bytesPerRow = Math.ceil(texture.width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [texture.width, texture.height]);
    device.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()), result = [];
    for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
      const offset = y * bytesPerRow + x * 4;
      result.push(bytes[offset + 2] / 255, bytes[offset + 1] / 255, bytes[offset] / 255, bytes[offset + 3] / 255);
    }
    buffer.unmap(); return result;
  } finally { buffer.destroy(); }
}
try {
  const result = await capture(new URLSearchParams(location.search).get('copySource') === '1');
  node.textContent = JSON.stringify({ schemaVersion: 1, status: 'passed', scope: 'black-frame-attribution-only', ...result }); node.dataset.status = 'passed';
} catch (error) { node.textContent = JSON.stringify({ schemaVersion: 1, status: 'failed', error: error.stack, failedCapture }); node.dataset.status = 'failed'; }
