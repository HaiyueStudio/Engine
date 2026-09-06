import { readFloatTexture as readTexture, createFloatTextureReadback } from './float-texture-readback.mjs';
import { BasicMaterial, BlinnPhongMaterial, Camera3D, DirectionalLight, Entity, Geometry3D, GrayscalePass, Mesh3D, OutlineTarget, RenderView, Transform3D } from '../../engine/dist/experimental.js';
import { PbrMaterial } from '../../engine/dist/index.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, createRealRendererGpuTimestampProbe, destroyRealRendererBenchmarkScenario, getRealRendererBenchmarkMetrics, resetRealRendererBenchmarkMetrics, runRealRendererBenchmarkFrame, warmRealRendererBenchmarkPipelines } from '../benchmark/real-renderer-scenario.mjs';

const resultNode = document.querySelector('#result');
const check = (condition, message) => { if (!condition) throw Error(message); };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
class Probe extends GrayscalePass {
  needsDepthTexture = true;
  needsNormalTexture = true;
  needsMotionTexture = true;
  needsOutlineMask = true;
  textures;
  depthCopies = null;
  setSceneTextures(textures) { this.textures = textures; }
  apply(encoder, src, dstView, device) {
    super.apply(encoder, src, dstView, device);
    if (this.depthCopies) {
      const copy = createFloatTextureReadback(device, this.textures.depth);
      this.depthCopies.set(this.textures.frame.near, copy);
      copy.encode(encoder);
    }
  }
}

try {
  check(navigator.gpu, 'WebGPU unavailable');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  check(adapter, 'No WebGPU adapter');
  const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [] });
  const errors = [];
  const cases = [];
  device.addEventListener('uncapturederror', event => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const target = createAuditTarget(device, 64, 64);
  const maskTexture = device.createTexture({ size: [2, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: maskTexture }, new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]), { bytesPerRow: 8 }, [2, 1]);
  let state;
  let gpuTimestampProbe;
  try {
    state = await createRealRendererBenchmarkScenario({ device, target, entityCount: 0 });
    gpuTimestampProbe = createRealRendererGpuTimestampProbe(state);
    const camera = new Entity('pixel-camera').addComponent(new Transform3D().setTranslation(0, 0, 3))
      .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 10 }));
    state.world.addEntity(camera);
    state.views = [new RenderView({ key: 'pixels', camera, target }).snapshot()];
    state.world.removeEntity(state.world.getEntity('shadow-sun'));
    state.world.addEntity(new Entity('pixel-sun').addComponent(new Transform3D()).addComponent(new DirectionalLight({ direction: [0, 0, -1], castShadow: true, shadow: { extent: 2, near: 0.1, far: 20, mapSize: 64 } })));
    const probe = new Probe();
    state.render3d.passes.splice(0, state.render3d.passes.length, probe);
    const pose = identity();
    pose[0] = 0; pose[1] = 1; pose[4] = -1; pose[5] = 0; pose[12] = 0.1;
    const geometry = new Geometry3D({
      positions: new Float32Array([-0.65, -0.65, 0, 0.65, -0.65, 0, 0.65, 0.65, 0, -0.65, 0.65, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      // Reverse winding exercises PBR's double-sided override in every pass.
      indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
      textureCoordinates: [
        { set: 0, data: new Float32Array(8).fill(0.25) },
        { set: 1, data: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]) },
      ],
      morphTargets: [{ positions: new Float32Array([0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0]), normals: new Float32Array([0, 0.6, -0.2, 0, 0.6, -0.2, 0, 0.6, -0.2, 0, 0.6, -0.2]) }],
      morphWeights: [1],
      skinning: { joints: new Float32Array(16), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), jointMatrices: pose },
      boundsMode: 'manual', localBounds: { center: [0, 0, 0], radius: 2 },
    });
    const material = new PbrMaterial({
      baseColor: [1, 1, 1, 1], emissiveFactor: [1, 1, 1], baseColorTexture: maskTexture,
      alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true,
      samplers: { baseColor: { minFilter: 'nearest', magFilter: 'nearest', addressModeU: 'clamp-to-edge' } },
      textureMappings: { baseColor: { texCoord: 1, scale: [-1, 1], offset: [1, 0], rotation: 0.2 } },
    });
    const transform = new Transform3D();
    const mesh = new Mesh3D(geometry, material);
    state.world.addEntity(new Entity('pixel-mesh').addComponent(transform).addComponent(mesh).addComponent(new OutlineTarget()));
    state.render3d.checkEntityManager(state.world);
    await warmRealRendererBenchmarkPipelines(state);
    resetRealRendererBenchmarkMetrics(state);
    const capture = async name => {
      resetRealRendererBenchmarkMetrics(state);
      await runRealRendererBenchmarkFrame(state, { gpuTimestampProbe });
      const metrics = getRealRendererBenchmarkMetrics(state);
      const textures = probe.textures;
      const pixels = {};
      for (const key of ['depth', 'normal', 'motion', 'outlineMask', 'outlineVisibleMask']) if (textures[key]) pixels[key] = await readTexture(device, textures[key]);
      pixels.color = await readTexture(device, state.render3d._postScenePasses._postRenderer.sceneTexture);
      check(state.render3d._renderers.shadow._texture, `shadow target missing for ${name}`);
      pixels.shadow = await readTexture(device, state.render3d._renderers.shadow._texture, true);
      const frameError = await device.popErrorScope();
      check(!frameError, frameError?.message);
      device.pushErrorScope('validation');
      const counts = { name, color: count(pixels.color, p => p[0] > 0.02), depth: pixels.depth ? count(pixels.depth, p => p[0] < 0.999) : 0, shadow: count(pixels.shadow, p => p[0] < 0.999),
        auxiliary: { ...state.render3d._postScenePasses.auxiliaryStats }, timing: { ...state.lastFrameTiming }, frame: { ...state.diagnosticTotals },
        metrics,
      };
      cases.push(counts);
      return { pixels, counts };
    };
    let sample = await capture('morph-skin-uv1-mask');
    check(sample.counts.color > 100 && sample.counts.shadow > 10, `masked mesh missing: ${JSON.stringify(sample.counts)}`);
    compareCoverage(sample.pixels, true);
    check(sample.counts.auxiliary.surfacePassCount === 1 && sample.counts.auxiliary.surfaceDrawCount === 1
      && sample.counts.auxiliary.unmergedPassCount === 3 && sample.counts.auxiliary.unmergedDrawCount === 3, 'MRT did not eliminate two geometry redraws');
    for (let i = 0; i < 64 * 64; i++) if (sample.pixels.depth[i * 4] < 0.999) {
      const n = sample.pixels.normal.subarray(i * 4, i * 4 + 3);
      check(Math.abs(n[0] - 0.2) < 0.003 && Math.abs(n[1] - 0.5) < 0.003 && Math.abs(n[2] - 0.9) < 0.003, `morph/skin normal mismatch: ${n}`);
    }
    const maskedShadowCount = sample.counts.shadow;
    transform.setTranslation(0.1, 0, 0);
    sample = await capture('masked-rigid-motion');
    compareCoverage(sample.pixels, true);
    for (let i = 0; i < 64 * 64; i++) {
      const covered = sample.pixels.depth[i * 4] < 0.999;
      check(Math.abs(sample.pixels.motion[i * 4] - (covered ? 0.05 : 0)) < 0.001, `velocity coverage mismatch at pixel ${i}`);
    }
    material.baseColor = [1, 1, 1, 0.2];
    sample = await capture('factor-alpha-rejects-all');
    check(sample.counts.color === 0 && sample.counts.depth === 0 && sample.counts.shadow === 0, 'factor alpha did not reject all passes');
    compareCoverage(sample.pixels, true);
    material.alphaMode = 'opaque';
    sample = await capture('opaque-ignores-texture-alpha');
    compareCoverage(sample.pixels, true);
    check(sample.counts.shadow > maskedShadowCount * 1.4, 'shadow did not preserve the alpha-test hole');
    material.alphaMode = 'blend';
    material.baseColor = [1, 1, 1, 0.8];
    sample = await capture('blend-does-not-write-aux-depth');
    check(sample.counts.color > 100 && sample.counts.depth === 0, 'blend depth-write semantics differ');
    check(count(sample.pixels.motion, p => Math.abs(p[0]) + Math.abs(p[1]) > 0.00001) === 0, 'blend writes velocity');
    check(count(sample.pixels.normal, p => Math.abs(p[0] - 0.5) > 0.001) === 0, 'blend writes auxiliary normal');
    mesh.material = new BasicMaterial({ color: [1, 1, 1, 1], frontFace: 'cw', cullMode: 'back' });
    sample = await capture('basic-winding-override');
    compareCoverage(sample.pixels, true);
    check(sample.counts.color > 100, 'Basic frontFace override rejected mesh');
    geometry.cullMode = 'none';
    mesh.material = new BlinnPhongMaterial({ diffuse: [1, 1, 1, 1] });
    sample = await capture('legacy-static-geometry');
    compareCoverage(sample.pixels, false);
    check(sample.counts.color > 100, 'legacy material missing');

    // Independent one-output draws provide a pixel reference for fused outputs.
    mesh.material = material;
    material.alphaMode = 'mask';
    material.baseColor = [1, 1, 1, 1];
    const scaled = identity(); scaled[0] = 1.1; scaled[5] = 0.7; scaled[10] = 0.8;
    transform.setMatrix(scaled);
    await capture('mrt-nonuniform-transition');
    const fused = await capture('mrt-nonuniform-morph-skin');
    probe.needsMotionTexture = false;
    const pair = await capture('normal-depth-mrt-reference');
    check(pair.counts.auxiliary.surfacePassCount === 1 && pair.counts.auxiliary.surfaceDrawCount === 1, 'normal/depth pair was not merged');
    comparePixels(fused.pixels.normal, pair.pixels.normal, 0.002, 'MRT normal versus normal renderer');
    comparePixels(fused.pixels.depth, pair.pixels.depth, 0.00001, 'MRT depth versus normal renderer');
    probe.needsNormalTexture = false;
    const depthOnly = await capture('standalone-depth-reference');
    comparePixels(fused.pixels.depth, depthOnly.pixels.depth, 0.00001, 'MRT depth versus depth renderer');
    probe.needsDepthTexture = false;
    probe.needsNormalTexture = true;
    const normalOnly = await capture('standalone-normal-reference');
    comparePixels(fused.pixels.normal, normalOnly.pixels.normal, 0.002, 'MRT normal versus standalone normal');
    probe.needsNormalTexture = false;
    probe.needsMotionTexture = true;
    await capture('standalone-motion-first-frame');
    const motionOnly = await capture('standalone-motion-reference');
    comparePixels(fused.pixels.motion, motionOnly.pixels.motion, 0.002, 'MRT motion versus standalone motion');
    probe.needsNormalTexture = true;
    const motionNormal = await capture('motion-normal-without-depth');
    comparePixels(fused.pixels.normal, motionNormal.pixels.normal, 0.002, 'MRT normal with an unused depth attachment');
    comparePixels(fused.pixels.motion, motionNormal.pixels.motion, 0.002, 'MRT motion with an unused depth attachment');

    // A transparent depth writer must not erase the opaque motion surface.
    probe.needsDepthTexture = probe.needsNormalTexture = true;
    const background = new Entity('motion-background').addComponent(new Transform3D().setTranslation(0, 0, -0.5))
      .addComponent(new Mesh3D(geometry, new BasicMaterial({ cullMode: 'none' })));
    state.world.addEntity(background);
    state.render3d.checkEntityManager(state.world);
    mesh.material = new BasicMaterial({ color: [1, 1, 1, 0.5], blending: 'normal', depthWrite: true, cullMode: 'none' });
    const fallback = await capture('transparent-depth-writer-fallback');
    check(!fallback.counts.auxiliary.sharedMotionSurface && fallback.counts.auxiliary.surfacePassCount === 2, 'transparent depth writer was incorrectly merged into motion');
    check(fallback.counts.auxiliary.surfaceDrawCount === 3 && fallback.counts.auxiliary.unmergedDrawCount === 5, `fallback failed to merge normal and depth: ${JSON.stringify(fallback.counts.auxiliary)}`);
    let distinct = 0;
    for (let i = 0; i < 64 * 64; i++) if (fallback.pixels.depth[i * 4] < 0.999 && fallback.pixels.motion[i * 4 + 3] !== 0) {
      if (fallback.pixels.motion[i * 4 + 2] - fallback.pixels.depth[i * 4] > 0.04) distinct++;
    }
    check(distinct > 100, 'transparent auxiliary depth replaced opaque motion depth');

    probe.needsMotionTexture = probe.needsOutlineMask = false;
    const otherCamera = new Entity('different-depth-range').addComponent(new Transform3D().setTranslation(0, 0, 3))
      .addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: 1, far: 20 }));
    state.world.addEntity(otherCamera);
    state.views.push(new RenderView({ key: 'other-range', camera: otherCamera, target }).snapshot());
    probe.depthCopies = new Map();
    try {
      await runRealRendererBenchmarkFrame(state);
      check(probe.depthCopies.size === 2, 'both depth ranges must be captured');
      for (const [key, copy] of probe.depthCopies) {
        const depth = await copy.read();
        let minimum = 1;
        for (let i = 0; i < depth.length; i += 4) minimum = Math.min(minimum, depth[i]);
        const expected = key === 0.1 ? (3 - 0.1) / (10 - 0.1) : (3 - 1) / (20 - 1);
        check(Math.abs(minimum - expected) < 0.00001, `view ${key} used another camera's depth range: ${minimum} != ${expected}`);
      }
      cases.push({ name: 'same-submission-view-depth-ranges', ranges: [[0.1, 10], [1, 20]] });
    } finally {
      for (const copy of probe.depthCopies.values()) copy.destroy();
      probe.depthCopies = null;
    }
    const validationError = await device.popErrorScope();
    if (validationError) errors.push(validationError.message);
    check(errors.length === 0, errors.join('\n'));
  } finally {
    gpuTimestampProbe?.destroy();
    try { if (state) await destroyRealRendererBenchmarkScenario(state); }
    finally { target.destroy(); maskTexture.destroy(); device.destroy(); }
  }
  check(state.finalMetrics.ownerResidual === 0, `released renderer owner has residual GPU resources: ${state.finalMetrics.ownerResidual}`);
  resultNode.textContent = JSON.stringify({ schemaVersion: 1, suite: 'auxiliary.material-geometry-semantics', status: 'passed', role: 'diagnostic-regression', generatedAt: new Date().toISOString(), browser: navigator.userAgent, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, dimensions: [64, 64], cases, gpuTiming: { supported: gpuTimestampProbe.supported, reason: gpuTimestampProbe.reason }, ownerResidual: state.finalMetrics.ownerResidual, validationErrors: errors });
  resultNode.dataset.status = 'passed';
} catch (error) {
  resultNode.textContent = error.stack ?? String(error);
  resultNode.dataset.status = 'failed';
}

function comparePixels(actual, expected, tolerance, label) {
  check(actual.length === expected.length, `${label}: dimensions differ`);
  for (let i = 0; i < actual.length; i++) check(Number.isFinite(actual[i]) && Math.abs(actual[i] - expected[i]) <= tolerance,
    `${label}: component ${i}: ${actual[i]} != ${expected[i]}`);
}

function compareCoverage(pixels, deformedNormal) {
  for (let i = 0; i < 64 * 64; i++) {
    const covered = pixels.color[i * 4] > 0.02;
    check((pixels.depth[i * 4] < 0.999) === covered, `depth coverage mismatch at ${i}`);
    check((pixels.outlineMask[i * 4] > 0.5) === covered, `outline coverage mismatch at ${i}`);
    check((pixels.outlineVisibleMask[i * 4] > 0.5) === covered, `visible outline coverage mismatch at ${i}`);
    if (deformedNormal) check((pixels.normal[i * 4] < 0.49) === covered, `normal coverage mismatch at ${i}`);
  }
}
function count(data, predicate) { let result = 0; for (let i = 0; i < data.length; i += 4) if (predicate(data.subarray(i, i + 4))) result++; return result; }
