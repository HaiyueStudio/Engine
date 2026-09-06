import { BasicMaterial, BlinnPhongMaterial, Camera3D, DepthMaterial, Entity, Geometry3D, Mesh3D, NormalMaterial, RenderView, Transform3D } from '../../engine/dist/experimental.js';
import { ClippingPlanes } from '../../engine/dist/components.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import { ToonMaterial } from '../../engine/dist/material.js';
import { ToonRenderSystem } from '../../engine/dist/systems.js';
import { RttEngine } from '../../engine/dist/rtt.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario, runRealRendererBenchmarkFrame, resetRealRendererBenchmarkMetrics, getRealRendererBenchmarkMetrics, createRealRendererGpuTimestampProbe } from '../benchmark/real-renderer-scenario.mjs';
import { useIndividualIndirectSubmission } from '../benchmark/indirect-bundle-reference.mjs';
import { readFloatTexture } from './float-texture-readback.mjs';

const result = document.querySelector('#result');
const check = (condition, message) => { if (!condition) throw Error(message); };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function geometry(indexed = true, deform = false) {
  return new Geometry3D({ positions: new Float32Array([-.12, -.12, 0, .12, -.12, 0, 0, .12, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, .5, 1]),
    ...(indexed ? { indices: new Uint16Array([0, 1, 2]) } : {}),
    ...(deform ? { morphTargets: [{ positions: new Float32Array([.07, 0, 0, .07, 0, 0, .07, 0, 0]) }], morphWeights: [.25],
      skinning: { joints: new Float32Array(12), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), jointMatrices: identity() } } : {}),
  });
}
function compare(actual, expected, name) {
  check(actual.length === expected.length, `${name}: extent changed`);
  let maxError = 0;
  for (let i = 0; i < actual.length; i++) {
    const error = Math.abs(actual[i] - expected[i]); maxError = Math.max(maxError, error);
    check(Number.isFinite(error) && error <= .002, `${name}: component ${i}: ${actual[i]} != ${expected[i]}`);
  }
  return maxError;
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)] + sorted[Math.ceil(middle)]) / 2;
};

try {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter?.features.has('indirect-first-instance'), 'indirect-first-instance is required for this GPU-driven verifier');
  const requiredFeatures = ['indirect-first-instance'];
  if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures });
  const errors = [], cases = [], owned = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const target = createAuditTarget(device, 96, 96), secondTarget = createAuditTarget(device, 80, 64);
  let mainTarget = target;
  let state, probe, performanceResult;
  try {
    state = await createRealRendererBenchmarkScenario({ device, target, entityCount: 0, renderProfile: 'gpu-driven' });
    state.render3d.passes.length = 0;
    for (const name of ['fog', 'shadow-sun', ...Array.from({ length: 7 }, (_, i) => `real-point-light:${i}`)]) state.world.removeEntity(state.world.getEntity(name));
    const camera = new Entity('bundle-camera').addComponent(new Transform3D().setTranslation(0, 0, 3))
      .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: .1, far: 10 }));
    const secondCamera = new Entity('bundle-camera-2').addComponent(new Transform3D().setTranslation(.3, 0, 3))
      .addComponent(new Camera3D({ type: 'orthographic', left: -.7, right: .7, bottom: -1, top: 1, near: 1, far: 20 }));
    state.world.addEntity(camera); state.world.addEntity(secondCamera);
    const view = (key, camera, target, options = {}) => new RenderView({ key, camera, target, ...options }).snapshot();
    state.views = [view('bundle-main', camera, target), view('bundle-second', secondCamera, secondTarget)];
    const toon = new ToonRenderSystem(state.engine, null, { render3DSystem: state.render3d }); state.world.addSystem(toon);
    const suite = state.render3d._renderers;
    const renderers = [suite.requireBasic(), suite.requirePbr(), state.blinn._requireRenderer(), suite.requireDepth(), suite.requireNormal(), toon._requireRenderer()];
    const materials = [new BasicMaterial({ color: [1, .3, .1, 1] }), new PbrMaterial({ baseColor: [0, 0, 0, 1], metallic: 1, emissiveFactor: [.2, .8, .3] }),
      new BlinnPhongMaterial({ ambient: [.1, .3, .8, 1] }), new DepthMaterial({ near: .1, far: 10 }), new NormalMaterial({ space: 'view' }),
      new ToonMaterial({ baseColor: [.9, .8, .1, 1], layers: [{ minLight: 0, color: [1, 1, 1, 1] }] })];
    const indexed = geometry(), plain = geometry(false), deformed = geometry(true, true);
    const entities = [];
    const add = (index, geo = indexed) => {
      const entity = new Entity(`bundle-mesh:${index}`).addComponent(new Transform3D().setTranslation((index % 6) * .31 - .78, (Math.floor(index / 6) % 6) * .3 - .78, 0))
        .addComponent(new Mesh3D(geo, materials[index % 6]));
      state.world.addEntity(entity); entities.push(entity); return entity;
    };
    for (let index = 0; index < 36; index++) add(index);
    state.render3d.checkEntityManager(state.world);
    const frame = async () => {
      resetRealRendererBenchmarkMetrics(state);
      device.pushErrorScope('validation');
      await runRealRendererBenchmarkFrame(state);
      const error = await device.popErrorScope();
      check(!error, error?.message); check(errors.length === 0, errors.join('\n'));
    };
    const compareMode = async name => {
      useIndividualIndirectSubmission(renderers, false);
      for (let i = 0; i < 4; i++) await frame();
      const pixels = await readFloatTexture(device, mainTarget.colorTexture), second = await readFloatTexture(device, secondTarget.colorTexture);
      check(pixels.some((value, i) => i % 4 !== 3 && value > .05), `${name}: empty frame`);
      useIndividualIndirectSubmission(renderers, true); await frame();
      const maxError = compare(pixels, await readFloatTexture(device, mainTarget.colorTexture), name);
      compare(second, await readFloatTexture(device, secondTarget.colorTexture), `${name}/second-view`);
      useIndividualIndirectSubmission(renderers, false);
      cases.push({ name, maxError });
    };
    await compareMode('six-renderers-two-views');
    // Non-contiguous visible objects retain their own indirect firstInstance slots.
    for (let i = 0; i < 36; i += 3) entities[i].getComponent(Transform3D).setTranslation(100, 0, 0);
    await compareMode('gpu-cull-holes');
    for (let i = 0; i < 36; i += 3) entities[i].getComponent(Transform3D).setTranslation((i % 6) * .31 - .78, Math.floor(i / 6) * .3 - .78, 0);
    for (let i = 0; i < 12; i++) entities[i].getComponent(Mesh3D).geometry = plain;
    await compareMode('indexed-and-nonindexed-ranges');
    for (let i = 12; i < 24; i++) entities[i].getComponent(Mesh3D).geometry = deformed;
    await compareMode('morph-and-skin-bindings');
    deformed.setMorphWeights([.8]); const pose = identity(); pose[13] = .08; deformed.updateSkinningMatrices(pose);
    await compareMode('live-morph-pose-data');
    entities[12].addComponent(new ClippingPlanes([{ normal: [1, 0, 0], constant: .78 }]));
    entities[13].addComponent(new ClippingPlanes([{ normal: [1, 0, 0], constant: .47 }]));
    await compareMode('per-object-clipping-in-shared-range');
    const texture = device.createTexture({ size: [2, 2], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }); owned.push(texture);
    device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0]), { bytesPerRow: 8 }, [2, 2]);
    materials[0].texture = texture; materials[1].alphaMode = 'mask'; materials[1].baseColorTexture = texture;
    materials[1].alphaCutoff = .5; materials[1].doubleSided = true;
    await compareMode('texture-rebinding-and-alpha-mask');
    const transparent = new Entity('bundle-transparent').addComponent(new Transform3D().setTranslation(-.4, 0, .1))
      .addComponent(new Mesh3D(geometry(), new BasicMaterial({ color: [0, .4, 1, .5], blending: 'normal', depthWrite: false })));
    state.world.addEntity(transparent); state.render3d.checkEntityManager(state.world);
    await compareMode('transparent-draw-after-bundles');
    for (let i = 0; i < 6; i++) state.world.removeEntity(entities[i]);
    for (let i = 36; i < 108; i++) add(i);
    state.render3d.checkEntityManager(state.world);
    await compareMode('removed-objects-and-grown-command-tables');
    const msaaTarget = new RttEngine(state.engine, 96, 96, undefined, 'bundle-msaa'); owned.push(msaaTarget);
    mainTarget = msaaTarget;
    state.views = [view('bundle-main', camera, msaaTarget, { sampleCount: 4, depthConvention: 'reverse' }), view('bundle-second', secondCamera, secondTarget)];
    await compareMode('msaa-reverse-z-and-mixed-view-layouts');
    state.views = [view('bundle-main', camera, target), view('bundle-second', secondCamera, secondTarget)];
    mainTarget = target;
    for (let i = 108; i < 606; i++) add(i);
    state.render3d.checkEntityManager(state.world);
    probe = createRealRendererGpuTimestampProbe(state);
    const samples = async individual => {
      useIndividualIndirectSubmission(renderers, individual);
      for (let i = 0; i < 6; i++) await frame();
      resetRealRendererBenchmarkMetrics(state);
      const times = [];
      for (let i = 0; i < 16; i++) { await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe: probe }); times.push({ ...state.lastFrameTiming }); }
      return { cpuRecordMs: median(times.map(t => t.cpuRecordMs)), cpuSubmitMs: median(times.map(t => t.cpuSubmitMs)),
        queueWaitMs: median(times.map(t => t.queueWaitMs)),
        gpuRenderPassMs: probe.supported ? median(times.map(t => t.gpuTimestamp.totalMs)) : null,
        gpuTimingUnavailableReason: probe.reason, gpuTimestampSample: times[0].gpuTimestamp,
        metrics: getRealRendererBenchmarkMetrics(state) };
    };
    const cohorts = [];
    for (const individual of [true, false, false, true]) cohorts.push({ mode: individual ? 'individual' : 'bundled', ...await samples(individual) });
    const summarize = mode => {
      const selected = cohorts.filter(cohort => cohort.mode === mode);
      return { cpuRecordMs: median(selected.map(c => c.cpuRecordMs)), cpuSubmitMs: median(selected.map(c => c.cpuSubmitMs)),
        queueWaitMs: median(selected.map(c => c.queueWaitMs)),
        gpuRenderPassMs: probe.supported ? median(selected.map(c => c.gpuRenderPassMs)) : null,
        gpuTimingUnavailableReason: probe.reason, metrics: selected[0].metrics };
    };
    performanceResult = { role: 'diagnostic-same-device', candidates: 600, views: 2, warmupPerCohort: 6,
      samplesPerCohort: 16, order: ['individual', 'bundled', 'bundled', 'individual'], cohorts,
      individual: summarize('individual'), bundled: summarize('bundled') };
    check(performanceResult.bundled.metrics.bundleBuilds === 0, 'steady-state range commands were re-encoded');
    check(performanceResult.bundled.metrics.bundleExecutionsPerFrame >= 12, 'all six families must consume cached commands');
    check(performanceResult.bundled.metrics.drawsPerFrame === performanceResult.individual.metrics.drawsPerFrame, 'GPU draw accounting changed');
    check(performanceResult.bundled.metrics.directEncodedDrawsPerFrame < performanceResult.individual.metrics.directEncodedDrawsPerFrame / 4, 'CPU per-object draw encoding did not fall');
    check(errors.length === 0, errors.join('\n'));
  } finally {
    probe?.destroy();
    if (state) { resetRealRendererBenchmarkMetrics(state); await destroyRealRendererBenchmarkScenario(state); }
    for (const texture of owned) texture.destroy(); target.destroy(); secondTarget.destroy(); device.destroy();
  }
  check(state.finalMetrics.ownerResidual === 0, 'renderer GPU resources remain after disposal');
  result.textContent = JSON.stringify({ schemaVersion: 1, suite: 'gpu-driven.indirect-bundles', status: 'passed', generatedAt: new Date().toISOString(),
    browser: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
    cases, performance: performanceResult, ownerResidual: state.finalMetrics.ownerResidual, validationErrors: errors });
  result.dataset.status = 'passed';
} catch (error) { result.textContent = error.stack ?? String(error); result.dataset.status = 'failed'; }
