import { Camera3D, Entity, Geometry3D, Mesh3D, RenderView, Transform3D, BlinnPhongMaterial,
  InstancedMesh3D, getSceneRenderEnvironment, getSceneFrameUniformSnapshot } from '../../engine/dist/experimental.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import { PointLight, DirectionalLight } from '../../engine/dist/lighting.js';
import { ToonMaterial, InstancedPbrMaterial } from '../../engine/dist/material.js';
import { ToonRenderSystem, InstancedMesh3DRenderSystem } from '../../engine/dist/systems.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario,
  runRealRendererBenchmarkFrame, resetRealRendererBenchmarkMetrics, getRealRendererBenchmarkMetrics,
  createRealRendererGpuTimestampProbe } from '../benchmark/real-renderer-scenario.mjs';
import { readFloatTexture } from './float-texture-readback.mjs';

const result = document.querySelector('#result');
const check = (value, message) => { if (!value) throw Error(message); };
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function compare(actual, expected, name) {
  let maxError = 0;
  for (let index = 0; index < actual.length; index++) {
    const error = Math.abs(actual[index] - expected[index]);
    maxError = Math.max(maxError, error);
    check(Number.isFinite(error) && error <= 1 / 255 + 1e-5, `${name}: pixel component ${index} differs by ${error}`);
  }
  return maxError;
}

try {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter?.features.has('indirect-first-instance'), 'GPU-driven verification requires indirect-first-instance');
  const device = await adapter.requestDevice({ requiredFeatures: ['indirect-first-instance',
    ...(adapter.features.has('timestamp-query') ? ['timestamp-query'] : [])] });
  const errors = [], cases = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const targets = [createAuditTarget(device, 64, 64), createAuditTarget(device, 80, 64)];
  let state, probe, performanceResult;
  const extraTargets = [];
  try {
    state = await createRealRendererBenchmarkScenario({ device, targets, viewCount: 2, entityCount: 0, renderProfile: 'gpu-driven' });
    state.render3d.passes.length = 0;
    for (const name of ['fog', 'shadow-sun', ...Array.from({ length: 7 }, (_, i) => `real-point-light:${i}`)]) state.world.removeEntity(state.world.getEntity(name));
    const cameras = [0, 100].map((x, index) => {
      const entity = new Entity(`light-camera-${index}`).addComponent(new Transform3D().setTranslation(x, 0, 3))
        .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: .1, far: 10 }));
      state.world.add(entity); return entity;
    });
    const views = cameras.map((camera, index) => new RenderView({ key: `light-view-${index}`, camera, target: targets[index] }).snapshot());
    state.views = views;
    const toon = new ToonRenderSystem(state.engine, null, { render3DSystem: state.render3d }); state.world.addSystem(toon);
    const geometry = new Geometry3D({
      positions: new Float32Array([-.8, -.8, 0, .8, -.8, 0, 0, .8, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    });
    const meshes = [0, 100].map(x => {
      const entity = new Entity().addComponent(new Transform3D().setTranslation(x, 0, 0))
        .addComponent(new Mesh3D(geometry, new PbrMaterial({ roughness: .8, metallic: 0 })));
      state.world.add(entity); return entity;
    });
    const pointGroups = [0, 100].map((x, group) => Array.from({ length: 9 }, (_, index) => {
      const light = new PointLight({ range: 2, intensity: index === 8 ? 1.2 : .12,
        color: group ? [.02, .08, 1, 1] : [1, .04, .02, 1] });
      const entity = new Entity().addComponent(new Transform3D().setTranslation(x, 0, .7)).addComponent(light);
      state.world.add(entity); return { entity, light };
    }));
    // A high authored count is cheap only if irrelevant sources never reach the shaders.
    for (let index = 0; index < 110; index++) state.world.add(new Entity()
      .addComponent(new Transform3D().setTranslation(500 + index, 0, 0)).addComponent(new PointLight({ range: 1, intensity: 30 })));
    const suns = [0, 1, 2].map(index => {
      const light = new DirectionalLight({ intensity: .02 * (index + 1), direction: [0, 0, -1], castShadow: true });
      const entity = new Entity().addComponent(light); entity.disabled = true; state.world.add(entity); return entity;
    });
    state.render3d.checkEntityManager(state.world);
    const restorePoints = () => { for (const group of pointGroups) for (const { entity } of group) entity.disabled = false; };
    const readSelection = index => {
      const frame = state.world.frameData.getCamera3D(cameras[index], cameras[index].getComponent(Camera3D), targets[index].width, targets[index].height, false);
      return getSceneRenderEnvironment(state.world.frameData, state.world, getSceneFrameUniformSnapshot(frame, null));
    };
    async function verify(name, shadowCount = 0, winners = [...Array.from({ length: 7 - shadowCount }, (_, i) => i), 8], extraViews = []) {
      restorePoints(); state.views = [...views, ...extraViews];
      await runRealRendererBenchmarkFrame(state);
      const selections = [0, 1].map(index => ({ ...readSelection(index).lightSelection }));
      for (const selection of selections) {
        check(selection.selectedCount === 8 && selection.overflowCount === 1 + shadowCount, `${name}: incorrect relevant-light budget`);
        check(selection.outsideViewCount === 119, `${name}: offscreen sources entered admission`);
      }
      const actual = await Promise.all(targets.map(target => readFloatTexture(device, target.colorTexture)));
      const pixelErrors = [];
      for (let index = 0; index < 2; index++) {
        // Independent oracle: author exactly the expected five/eight sources in a single-view scene.
        for (let group = 0; group < 2; group++) for (let light = 0; light < 9; light++) {
          pointGroups[group][light].entity.disabled = group !== index || !winners.includes(light);
        }
        state.views = [views[index]];
        await runRealRendererBenchmarkFrame(state);
        const expected = await readFloatTexture(device, targets[index].colorTexture);
        pixelErrors.push(compare(actual[index], expected, `${name} view ${index}`));
        const center = (Math.floor(targets[index].height / 2) * targets[index].width + Math.floor(targets[index].width / 2)) * 4;
        check(expected[center + (index ? 2 : 0)] > .15, `${name} view ${index}: the reference surface was not lit (${expected.slice(center, center + 4)})`);
        check(expected[center + (index ? 2 : 0)] > expected[center + (index ? 0 : 2)] * 1.3, `${name}: distinct view light colors were lost`);
      }
      cases.push({ name, pixelErrors, selections });
      restorePoints(); state.views = views;
      resetRealRendererBenchmarkMetrics(state);
    }
    await verify('pbr-two-view-overflow');
    for (const entity of meshes) entity.getComponent(Mesh3D).material = new BlinnPhongMaterial({ ambient: [0, 0, 0, 1], diffuse: [1, 1, 1, 1], specular: [0, 0, 0, 1] });
    await verify('blinn-two-view-overflow');
    for (const entity of meshes) entity.getComponent(Mesh3D).material = new ToonMaterial({ layers: [{ minLight: 0, color: [1, 1, 1, 1] }] });
    await verify('toon-two-view-overflow');
    for (const entity of meshes) entity.getComponent(Mesh3D).material = new PbrMaterial({ roughness: .8, metallic: 0 });
    for (const entity of suns) entity.disabled = false;
    await verify('pbr-three-shadow-layers', 3);
    for (const entity of suns) entity.disabled = true;
    for (const group of pointGroups) { group[7].light.intensity = 3; group[8].light.intensity = .01; }
    await verify('pbr-dynamic-winner-replacement', 0, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (const group of pointGroups) { group[7].light.intensity = .12; group[8].light.intensity = 1.2; }

    const originalRecord = state.render3d.record;
    const instanced = new InstancedMesh3DRenderSystem(state.engine, cameras[0]); state.world.addSystem(instanced);
    for (const entity of meshes) {
      entity.removeComponent(Mesh3D);
      const material = new InstancedPbrMaterial(1, { roughness: .8 });
      const transform = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, meshes.indexOf(entity) * 100, 0, 0, 1]);
      material.setTransform(0, transform);
      entity.addComponent(new InstancedMesh3D(geometry, material));
    }
    instanced.checkEntityManager(state.world); state.render3d.checkEntityManager(state.world);
    state.render3d.record = (world, context) => {
      for (const view of state.views) {
        context.endPass(); context.view = view; context.descriptor = undefined; context.loadOp = 'clear';
        instanced.record(world, context); context.endPass();
      }
    };
    await verify('instanced-pbr-two-view-overflow');
    state.render3d.record = originalRecord;
    for (const entity of meshes) { entity.removeComponent(InstancedMesh3D); entity.addComponent(new Mesh3D(geometry, new PbrMaterial({ roughness: .8, metallic: 0 }))); }
    state.render3d.checkEntityManager(state.world);

    const scratchTarget = createAuditTarget(device, 32, 32); extraTargets.push(scratchTarget);
    const extraCameras = Array.from({ length: 35 }, (_, index) => {
      const entity = new Entity(`growth-camera-${index}`).addComponent(new Transform3D().setTranslation(index % 2 * 100, 0, 3))
        .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: .1, far: 10 }));
      state.world.add(entity); return entity;
    });
    const extraViews = extraCameras.map((camera, index) => new RenderView({ key: `growth-${index}`, camera, target: scratchTarget }).snapshot());
    const pbr = state.render3d._renderers.requirePbr(), oldLights = pbr._lightUniforms.buffer;
    await verify('pbr-growth-preserves-earlier-encoded-views', 0, undefined, extraViews);
    check(pbr._lightUniforms.buffer !== oldLights, 'growth fixture did not expand the light buffer');
    for (const camera of extraCameras) state.world.removeEntity(camera);

    probe = createRealRendererGpuTimestampProbe(state);
    for (let index = 0; index < 6; index++) await runRealRendererBenchmarkFrame(state);
    resetRealRendererBenchmarkMetrics(state);
    const times = [];
    for (let index = 0; index < 12; index++) {
      await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe: probe }); times.push(state.lastFrameTiming);
    }
    performanceResult = { role: 'diagnostic-not-formal', authoredPoints: 128, relevantPointsPerView: 9, views: 2, warmup: 6, samples: 12,
      cpuRecordMs: median(times.map(time => time.cpuRecordMs)), cpuSubmitMs: median(times.map(time => time.cpuSubmitMs)),
      queueWaitMs: median(times.map(time => time.queueWaitMs)),
      gpuRenderPassMs: probe.supported ? median(times.map(time => time.gpuTimestamp.totalMs)) : null,
      gpuTimingUnavailableReason: probe.reason, metrics: getRealRendererBenchmarkMetrics(state) };
    check(performanceResult.metrics.pbrLightUniformUploadsPerFrame === 0, 'static selected light records were re-uploaded');
    check(performanceResult.metrics.pbrEnvironmentUniformUploadsPerFrame === 0, 'alternating view revisions re-uploaded IBL');
    check(errors.length === 0, errors.join('\n'));
  } finally {
    probe?.destroy();
    if (state) { resetRealRendererBenchmarkMetrics(state); await destroyRealRendererBenchmarkScenario(state); }
    for (const target of [...targets, ...extraTargets]) target.destroy();
  }
  check(state.finalMetrics.ownerResidual === 0, 'GPU owner resources remain after cleanup');
  result.textContent = JSON.stringify({ status: 'passed', cases, performance: performanceResult, ownerResidual: state.finalMetrics.ownerResidual,
    browser: navigator.userAgent,
    adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description }, errors });
  result.dataset.status = 'passed';
  device.destroy();
} catch (error) {
  result.textContent = JSON.stringify({ status: 'failed', message: error.message, stack: error.stack }); result.dataset.status = 'failed';
}
