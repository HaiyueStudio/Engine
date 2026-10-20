// The shared room installer imports this same URL. Different URLs for identical
// bundle bytes would create distinct Entity/component constructor identities.
import * as runtime from '../../artifacts/engine-0.2.1/g03/fixture.js';
import { G09_ACCEPTANCE_CASES } from './framegraph-acceptance-cases.mjs';
import { installG05RoomScene } from './deferred-g05-room-scene.mjs';
import { readFloatTexture, createFloatTextureReadback } from './float-texture-readback.mjs';
import { encodeFrameGraphPixels } from './framegraph-pixel-oracle.mjs';
import { captureG05ResourceSnapshot } from './deferred-g05-memory-policy.mjs';
import { observeForwardAllocations } from './deferred-g05-forward-allocation.mjs';
import { createLightingScalingFixtureConfiguration } from '../benchmark/lighting-scaling-fixture.mjs';

const node = document.querySelector('#result'), query = new URLSearchParams(location.search);
const check = (v, m) => { if (!v) throw Error(m); };
try { node.textContent = JSON.stringify(await run()); node.dataset.status = 'passed'; }
catch (error) { node.textContent = JSON.stringify({ status: 'failed', error: error.stack }); node.dataset.status = 'failed'; }

async function run() {
  const spec = G09_ACCEPTANCE_CASES.find(c => c.id === query.get('caseId'));
  check(spec?.fixture === 'framegraph-acceptance', 'Unregistered native workload');
  const p = spec.parameters;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: query.get('powerPreference') ?? 'high-performance' });
  check(adapter && adapter.info.isFallbackAdapter === false, 'Native adapter required');
  const device = await adapter.requestDevice(), errors = [], targets = [], owned = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.pushErrorScope('validation');
  const allocationAudit = observeForwardAllocations(device);
  let state, result, failure, profile, scene, mirror;
  try {
    const { createRealRendererBenchmarkScenario, createAuditTarget, RenderView } = runtime;
    for (const [width, height] of spec.dimensions) targets.push(createAuditTarget(device, width, height, true));
    if (p.scene === 'forward') {
      const response = await fetch(new URL(`../../${runtime.BILLIARDS_3D_SCENE_PATH}`, import.meta.url));
      check(response.ok, 'Missing frozen Forward scene');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
      check(bytes.byteLength === runtime.BILLIARDS_3D_SCENE_BYTE_LENGTH && digest === runtime.BILLIARDS_3D_SCENE_SHA256, 'Forward scene bytes changed');
      const document = await runtime.parseBilliards3DSceneDocument(bytes);
      state = await createRealRendererBenchmarkScenario({ device, target: targets[0],
        lightingFixture: createLightingScalingFixtureConfiguration({ localLightCount: p.lights, overlap: 'medium', dynamicRatio: .25, viewCount: 1, resolution: '720p' }),
        lightingSceneDocument: document });
      state.render3d.passes.length = 0;
      scene = { update() {} };
    } else {
      state = await createRealRendererBenchmarkScenario({ device, target: targets[0], entityCount: 0, viewCount: targets.length, renderProfile: 'batched' });
      state.targets = targets;
      state.views = state.views.map((view, i) => new RenderView({ key: view.key, camera: view.camera, target: targets[i] }).snapshot());
      if (['rtt', 'mirror'].includes(p.scene)) {
        ({ scene, mirror } = installOutputScene(state, p, owned));
      } else {
        scene = installG05RoomScene(state, { count: p.count, overlap: p.overlap, moving: p.moving });
        state.render3d.passes.length = 0;
        if (p.scene === 'temporal') installTemporalScene(state);
        if (p.layout === 'mixed-viewport') {
          const objects = [...state.world.entities.values()].filter(e => e.getComponent(runtime.Mesh3D));
          state.views = state.views.map((view, i) => new RenderView({ key: view.key, camera: view.camera, target: targets[i],
            excludedEntityIds: i % 2 ? new Set(objects.slice(0, 3).map(e => e.id)) : null,
            viewport: i % 2 ? { x: 16, y: 16, width: targets[i].width - 32, height: targets[i].height - 32, minDepth: 0, maxDepth: 1 } : null,
          }).snapshot());
        }
      }
      state.render3d.checkEntityManager(state.world);
      profile = await runtime.createDeferredReferenceProfile(state.render3d, state.engine, {
        ...(p.algorithm === 'tiled' ? { tiled: {} } : {}), failurePolicy: 'forward',
      });
    }
    // Correctness history settling is explicit and identical for A0/B4. It is
    // not a selected performance warmup and has no timing qualification.
    const frames = p.scene === 'temporal' ? 32 : 8;
    for (let frame = 0; frame < frames; frame++) { scene.update(frame); await runtime.runRealRendererBenchmarkFrame(state); }
    runtime.resetRealRendererBenchmarkMetrics(state);
    const before = captureG05ResourceSnapshot(state.tracker);
    const images = await captureViews(state, scene, frames, p.scene === 'forward');
    const diagnostics = profile ? { ...profile.backend.diagnostics } : null;
    if (profile && p.scene !== 'mirror') check(diagnostics.completeCoverage === true, 'Unexpected whole-view Forward fallback');
    if (p.scene === 'mirror') {
      check(diagnostics.effective === 'forward' && diagnostics.completeCoverage === false, 'Mirror main-view fallback must remain explicit');
      const reflection = mirror.material.getReflection(state.views[0].key);
      check(reflection?.texture.format === 'rgba16float', 'Missing HDR reflection');
      const reflected = await readFloatTexture(device, reflection.texture);
      check(reflected.some((r, i) => i % 4 === 0 && Math.abs(r - 4) < .02 && Math.abs(reflected[i + 1] - 2) < .02), 'Reflection lost radiance');
    }
    globalThis.__framegraphPixels = encodeFrameGraphPixels(images);
    const validation = await device.popErrorScope(); if (validation) errors.push(validation.message);
    check(errors.length === 0, errors.join('\n'));
    result = { schemaVersion: 1, status: 'passed', suite: 'g09-acceptance-scenes', caseId: spec.id,
      parameters: p, dimensions: spec.dimensions, settlingFrames: frames, diagnostics,
      performanceQualified: false, scope: 'Full-resolution correctness only; timings not sampled',
      hdrScope: p.scene === 'forward' ? 'No HDR oracle: display output duplicated for transport' : 'Per-view linear scene output before reuse',
      source: profile?.backend.lastSource ? { ...profile.backend.lastSource.stats } : null,
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter },
      resources: { before, after: captureG05ResourceSnapshot(state.tracker) },
      effects: state.render3d.passes.map(pass => pass.constructor.name),
      deferredAllocations: allocationAudit.snapshot(), validationErrors: errors };
    return result;
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (state) {
        await runtime.destroyRealRendererBenchmarkScenario(state);
        if (result) result.cleanup = { ownerResidual: state.finalMetrics.ownerResidual, liveGpuResources: state.finalMetrics.liveGpuResources };
      }
    } catch (error) { if (!failure) throw error; failure.stack += `\nCleanup: ${error.stack}`; }
    finally { for (const resource of owned) resource.destroy(); for (const target of targets) target.destroy(); device.destroy(); }
  }
}

async function captureViews(state, scene, frame, displayOnly) {
  const post = state.render3d._postScenePasses, original = post.runPostProcess, pending = [];
  if (!displayOnly) post.runPostProcess = function (encoder, ...args) {
    const value = original.call(this, encoder, ...args);
    const rb = createFloatTextureReadback(state.device, this._postRenderer.sceneTexture);
    rb.encode(encoder); pending.push({ key: args[3].viewKey, rb }); return value;
  };
  try {
    scene.update(frame); await runtime.runRealRendererBenchmarkFrame(state);
    const images = [];
    for (const view of state.views) {
      const ldr = await readFloatTexture(state.device, view.target.colorTexture);
      const capture = pending.find(item => item.key === view.key);
      check(displayOnly || capture, `Missing HDR view ${view.key}`);
      images.push({ key: view.key, ldr, hdr: displayOnly ? ldr : await capture.rb.read() });
    }
    return images;
  } finally { post.runPostProcess = original; for (const item of pending) item.rb.destroy(); }
}

function installTemporalScene(state) {
  const { Entity, Transform3D, Mesh3D, PbrMaterial, createBox3D, OutlineTarget, TaaPass, GaussianBlurPass, OutlinePass } = runtime;
  const transparent = new Entity('g09-transparent').addComponent(new Transform3D().setTranslation(0, 1, 2))
    .addComponent(new Mesh3D(createBox3D({ width: 2, height: 2, depth: .3 }), new PbrMaterial({ baseColor: [.8, .2, .3, .35], alphaMode: 'blend', roughness: .4 })))
    .addComponent(new OutlineTarget());
  state.world.add(transparent);
  state.render3d.passes.push(new TaaPass({ jitterScale: 0, sharpness: 0 }), new GaussianBlurPass(), new OutlinePass());
}

function installOutputScene(state, parameters, owned) {
  const { Entity, Transform3D, Camera3D, RenderView, Mesh3D, Geometry3D, PbrMaterial, BasicMaterial, PlanarMirror, RttEngine } = runtime;
  for (const entity of [...state.world.entities.values()]) state.world.removeEntity(entity);
  state.render3d.passes.length = 0;
  const quad = () => new Geometry3D({ positions: new Float32Array([-.9, -.9, 0, .9, -.9, 0, .9, .9, 0, -.9, .9, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
  const camera = new Entity('g09-output-camera').addComponent(new Transform3D().setTranslation(0, 0, 3))
    .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: .1, far: 10 }));
  state.world.add(camera);
  state.world.add(new Entity('g09-emitter').addComponent(new Transform3D()).addComponent(new Mesh3D(quad(),
    new PbrMaterial({ baseColor: [0, 0, 0, 1], metallic: 1, emissiveFactor: [4, 2, 1], doubleSided: true }))));
  state.views = [new RenderView({ key: 'display', camera, target: state.targets[0] }).snapshot()];
  let mirror;
  if (parameters.scene === 'rtt') {
    const hdr = new RttEngine(state.engine, 640, 360, undefined, 'g09.external-hdr', null, 'rgba16float'); owned.push(hdr);
    state.views.push(new RenderView({ key: 'external-hdr', camera, target: hdr }).snapshot());
  } else {
    mirror = new PlanarMirror({ width: 640, height: 360, maxBounces: 1, localNormal: [0, 0, 1] });
    state.world.add(new Entity('g09-mirror').addComponent(new Transform3D().setTranslation(0, 0, -1))
      .addComponent(new Mesh3D(quad(), new BasicMaterial())).addComponent(mirror));
  }
  return { scene: { update() {} }, mirror };
}
