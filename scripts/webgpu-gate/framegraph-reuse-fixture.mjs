import { createRealRendererBenchmarkScenario, runRealRendererBenchmarkFrame, destroyRealRendererBenchmarkScenario, createAuditTarget,
  resetRealRendererBenchmarkMetrics, Entity, Camera3D, Transform3D, Mesh3D, PbrMaterial, AmbientLight, PointLight, RenderView,
  createBox3D, createDeferredReferenceProfile, GtaoPass, SaoPass, SsaoPass, GaussianBlurPass, getSequentialAttachmentAllocator,
} from '../../artifacts/engine-0.2.1/g09/fixture.js';
import { readFloatTexture } from './float-texture-readback.mjs';
const node = document.querySelector('#result');
const check = (value, message) => { if (!value) throw Error(message); };
const preference = new URLSearchParams(location.search).get('powerPreference') ?? 'high-performance';
let failedCapture = null;
const cases = [];
async function capture(algorithm, reuse, count, mixed) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: preference });
  check(adapter && !adapter.info.isFallbackAdapter, 'native GPU required');
  const device = await adapter.requestDevice(), errors = [], targets = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message)); device.pushErrorScope('validation');
  let state, profile, result, failure;
  try {
    for (let i = 0; i < count; i++) targets.push(createAuditTarget(device, mixed && i % 2 ? 48 : 64, mixed && i % 2 ? 40 : 64));
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
    state.render3d.passes.splice(0, state.render3d.passes.length,
      new GtaoPass({ quality: 'low' }), new SaoPass({ quality: 'low' }), new SsaoPass({ quality: 'low' }), new GaussianBlurPass(), new GaussianBlurPass());
    state.render3d.checkEntityManager(state.world);
    if (algorithm !== 'forward') profile = await createDeferredReferenceProfile(state.render3d, state.engine,
      algorithm === 'tiled' ? { tiled: { forceCulling: true } } : {});
    const setReuse = () => {
      const post = state.render3d._postScenePasses._postRenderer?._transientTextures;
      if (post) post.reuse = reuse;
      if (profile) {
        profile.backend._ambientOcclusion._transientTextures.reuse = reuse;
        const mrt = getSequentialAttachmentAllocator(profile.backend._pool); if (mrt) mrt.reuse = reuse;
      }
    };
    setReuse();
    for (let i = 0; i < 4; i++) { await runRealRendererBenchmarkFrame(state); setReuse(); }
    resetRealRendererBenchmarkMetrics(state);
    const beforePasses = state.audit.renderPasses;
    const physical = new WeakMap(); let nextId = 0; const views = [];
    if (profile) {
      const original = profile.backend.record.bind(profile.backend);
      profile.backend.record = input => {
        const recorded = original(input);
        check(recorded && profile.backend.diagnostics.completeCoverage, 'unexpected Deferred fallback');
        views.push({ key: input.view.key, textures: profile.backend.lastAttachments.textures.map(texture => {
          if (!physical.has(texture)) physical.set(texture, ++nextId); return physical.get(texture);
        }) }); return recorded;
      };
    }
    const pools = () => ({ post: state.render3d._postScenePasses._postRenderer._transientTextures,
      ...(profile ? { deferred: getSequentialAttachmentAllocator(profile.backend._pool), ao: profile.backend._ambientOcclusion._transientTextures } : {}) });
    const allocations = Object.fromEntries(Object.entries(pools()).map(([key, pool]) => [key, pool.stats.allocations]));
    await runRealRendererBenchmarkFrame(state);
    const stats = Object.fromEntries(Object.entries(pools()).map(([key, pool]) => [key, { ...pool.stats }]));
    for (const [key, value] of Object.entries(stats)) check(value.allocations === allocations[key], `${key}: steady-state texture allocation`);
    const pixels = [];
    for (const target of targets) pixels.push(Array.from(await readFloatTexture(device, target.colorTexture)));
    // Preserve the original failing frame before assertions/cleanup; never replace it with a retry.
    failedCapture = { algorithm, reuse, count, mixed, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
      stats, views, dimensions: targets.map(target => [target.width, target.height]), pixels,
      actualPasses: state.audit.renderPasses - beforePasses };
    check(pixels.every(image => image.every(Number.isFinite)), 'nonfinite image');
    const dimensions = targets.map(target => [target.width, target.height]);
    const alphaCoverage = pixels.map(image => image.reduce((count, value, index) => count + +(index % 4 === 3 && value >= 1 - 1 / 255), 0));
    check(alphaCoverage.every((covered, i) => covered === targets[i].width * targets[i].height),
      `incomplete output coverage ${algorithm}: ${JSON.stringify({ dimensions, alphaCoverage })}`);
    check(pixels.every(image => image.some((value, i) => i % 4 !== 3 && value > .1)), `empty scene ${algorithm}/${reuse}/${count}/${mixed}; RGB maxima=${pixels.map(image => Math.max(...image.filter((_, i) => i % 4 !== 3)))}`);
    // Latest exported G-buffer remains available after postprocessing (clearcoat/diagnostic consumer).
    let debug = null;
    if (profile) debug = Array.from(await readFloatTexture(device, profile.backend.lastAttachments.textures[0]));
    result = { algorithm, reuse, count, mixed, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
      stats, views, dimensions, alphaCoverage, rgbMaxima: pixels.map(image => Math.max(...image.filter((_, i) => i % 4 !== 3))), actualPasses: state.audit.renderPasses - beforePasses, pixels, debug };
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (state) {
        try { await destroyRealRendererBenchmarkScenario(state); }
        catch (error) { if (!failure) throw error; failure.stack += `\nCleanup: ${error.stack}`; }
        if (result) {
          result.cleanup = { ownerResidual: state.finalMetrics.ownerResidual, liveGpuResources: state.finalMetrics.liveGpuResources };
          check(result.cleanup.ownerResidual === 0 && result.cleanup.liveGpuResources === 0, 'residual GPU allocations');
        }
      }
      for (const target of targets) target.destroy();
      const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
      check(errors.length === 0, errors.join('\n'));
    } finally { device.destroy(); }
  }
}
try {
  for (const [algorithm, count, mixed] of [['forward', 1, false], ['reference', 4, false], ['tiled', 4, false], ['tiled', 4, true]]) {
    const baseline = await capture(algorithm, false, count, mixed), candidate = await capture(algorithm, true, count, mixed);
    let maxDelta = 0;
    for (let view = 0; view < count; view++) for (let i = 0; i < baseline.pixels[view].length; i++)
      maxDelta = Math.max(maxDelta, Math.abs(baseline.pixels[view][i] - candidate.pixels[view][i]));
    check(maxDelta <= 1 / 255, `${algorithm}: pixel mismatch ${maxDelta}`);
    if (baseline.debug) check(baseline.debug.every((value, i) => Math.abs(value - candidate.debug[i]) <= .001), 'G-buffer diagnostic was overwritten');
    check(baseline.actualPasses === candidate.actualPasses, 'resource reuse changed render work');
    for (const key of Object.keys(candidate.stats)) check(candidate.stats[key].physicalBytes < baseline.stats[key].physicalBytes, `${algorithm}/${key}: no physical resource saving`);
    if (count === 4 && !mixed && algorithm !== 'forward') check(new Set(candidate.views.flatMap(view => view.textures)).size === 4, 'four sequential views should share four G-buffer textures');
    const compact = ({ pixels, debug, ...value }) => value;
    cases.push({ baseline: compact(baseline), candidate: compact(candidate), maxDelta });
  }
  node.textContent = JSON.stringify({ schemaVersion: 1, status: 'passed', scope: 'lifetime-reuse structural/pixel diagnostic, not formal timing', cases });
  node.dataset.status = 'passed';
} catch (error) { node.textContent = JSON.stringify({ schemaVersion: 1, status: 'failed', error: error.stack ?? String(error), cases, failedCapture }); node.dataset.status = 'failed'; }
