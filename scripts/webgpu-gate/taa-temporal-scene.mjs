import { BasicMaterial, Camera3D, Entity, Geometry3D, Mesh3D, RenderView, Transform3D } from '../../engine/dist/experimental.js';
import { MotionBlurPass, TaaPass } from '../../engine/dist/postprocess.js';
import { createAuditTarget, createRealRendererBenchmarkScenario, destroyRealRendererBenchmarkScenario, resetRealRendererBenchmarkMetrics, runRealRendererBenchmarkFrame, warmRealRendererBenchmarkPipelines } from '../benchmark/real-renderer-scenario.mjs';
import { readFloatTexture } from './float-texture-readback.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
class TemporalProbe extends TaaPass {
  inputs = new Map();
  setSceneTextures(textures) {
    super.setSceneTextures(textures);
    this.inputs.set(textures.frame.viewKey, { ...textures, frame: { ...textures.frame, projectionJitter: textures.frame.projectionJitter.slice() } });
  }
}

export async function verifyTemporalScene(device, cases) {
  const large = createAuditTarget(device, 64, 64);
  const small = createAuditTarget(device, 32, 32);
  const resized = createAuditTarget(device, 48, 48);
  let state;
  try {
    state = await createRealRendererBenchmarkScenario({ device, target: large, entityCount: 0 });
    const mainTransform = new Transform3D().setTranslation(0, 0, 3);
    const main = new Entity('taa-ortho').addComponent(mainTransform).addComponent(new Camera3D({ type: 'orthographic', left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 10 }));
    const other = new Entity('taa-perspective').addComponent(new Transform3D().setTranslation(0, 0, 3)).addComponent(new Camera3D({ near: 0.1, far: 10, fov: Math.PI / 3 }));
    state.world.addEntity(main); state.world.addEntity(other);
    state.world.removeEntity(state.world.getEntity('shadow-sun'));
    const views = mainTarget => [new RenderView({ key: 'taa-main', camera: main, target: mainTarget }).snapshot(), new RenderView({ key: 'taa-other', camera: other, target: small }).snapshot()];
    state.views = views(large);
    const geometry = new Geometry3D({
      positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      morphTargets: [{ positions: new Float32Array([0.2, 0, 0, 0.2, 0, 0, 0.2, 0, 0, 0.2, 0, 0]) }], morphWeights: [0],
      skinning: { joints: new Float32Array(16), weights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), jointMatrices: identity() },
      boundsMode: 'manual', localBounds: { center: [0, 0, 0], radius: 2 },
    });
    const transform = new Transform3D();
    const entity = new Entity('taa-mesh').addComponent(transform).addComponent(new Mesh3D(geometry, new BasicMaterial({ color: [0.8, 0.6, 0.4, 1] })));
    state.world.addEntity(entity);
    state.render3d.checkEntityManager(state.world);
    const taa = new TemporalProbe({ sharpness: 0 });
    state.render3d.passes.splice(0, state.render3d.passes.length, taa);
    await warmRealRendererBenchmarkPipelines(state);
    resetRealRendererBenchmarkMetrics(state);
    async function capture(name) {
      await runRealRendererBenchmarkFrame(state);
      const snapshots = new Map();
      for (const [key, input] of taa.inputs) {
        const motion = await readFloatTexture(device, input.motion);
        const depth = await readFloatTexture(device, input.depth);
        const covered = [];
        for (let i = 0; i < motion.length; i += 4) if (motion[i + 3] !== 0) covered.push(i);
        check(covered.length > 40, `${name}/${key}: missing geometry`);
        snapshots.set(key, { motion, depth, covered });
      }
      const summary = Object.fromEntries([...snapshots].map(([key, value]) => [key, {
        covered: value.covered.length, velocityX: value.motion[value.covered[0]], previousDepth: value.motion[value.covered[0] + 2], valid: value.motion[value.covered[0] + 3],
      }]));
      cases.push({ name, views: summary });
      return snapshots;
    }
    function validate(samples, key, velocity, validity, previousDepth) {
      const { motion, covered } = samples.get(key);
      for (const i of covered) {
        if (velocity !== null) check(Math.abs(motion[i] - velocity) < 0.0005 && Math.abs(motion[i + 1]) < 0.0005, `${key} velocity expected ${velocity}, got ${motion[i]},${motion[i + 1]}`);
        check(motion[i + 3] === validity, `${key} validity expected ${validity}, got ${motion[i + 3]}`);
        if (previousDepth !== null) check(Math.abs(motion[i + 2] - previousDepth) < 0.0005, `${key} previous depth expected ${previousDepth}, got ${motion[i + 2]}`);
      }
    }
    let samples = await capture('scene-first-frame');
    for (const key of ['taa-main', 'taa-other']) validate(samples, key, 0, -1, (3 - 0.1) / 9.9);
    samples = await capture('scene-static-halton-jitter');
    for (const key of ['taa-main', 'taa-other']) validate(samples, key, 0, 1, (3 - 0.1) / 9.9);
    transform.setTranslation(0.2, 0, 0.3);
    samples = await capture('scene-rigid-depth-motion');
    validate(samples, 'taa-main', 0.1, 1, (3 - 0.1) / 9.9);
    validate(samples, 'taa-other', null, 1, (3 - 0.1) / 9.9);
    geometry.setMorphWeights([0.5]);
    samples = await capture('scene-morph-motion');
    validate(samples, 'taa-main', 0.05, 1, (2.7 - 0.1) / 9.9);
    const pose = identity(); pose[12] = 0.2; geometry.updateSkinningMatrices(pose);
    samples = await capture('scene-skinned-motion');
    validate(samples, 'taa-main', 0.1, 1, (2.7 - 0.1) / 9.9);
    mainTransform.setTranslation(0.2, 0, 3);
    samples = await capture('scene-camera-motion');
    validate(samples, 'taa-main', -0.1, 1, (2.7 - 0.1) / 9.9);
    taa.resetHistory('taa-main');
    samples = await capture('scene-view-local-reset');
    validate(samples, 'taa-main', 0, -1, (2.7 - 0.1) / 9.9);
    validate(samples, 'taa-other', 0, 1, (2.7 - 0.1) / 9.9);
    state.views = views(resized);
    samples = await capture('scene-view-resize');
    validate(samples, 'taa-main', 0, -1, (2.7 - 0.1) / 9.9);
    validate(samples, 'taa-other', 0, 1, (2.7 - 0.1) / 9.9);
    check(taa.stats.historyCount === 2, 'view resize leaked history entries');
    state.render3d.reverseZ = true;
    await capture('scene-reverse-z-reset');
    samples = await capture('scene-reverse-z-continuous');
    for (const key of ['taa-main', 'taa-other']) validate(samples, key, 0, 1, (2.7 - 0.1) / 9.9);
    state.render3d.passes.unshift(new MotionBlurPass());
    samples = await capture('scene-motion-blur-taa');
    for (const key of ['taa-main', 'taa-other']) validate(samples, key, 0, 1, (2.7 - 0.1) / 9.9);
    state.render3d.passes[0].reconstruction = 'tile-neighbor-max';
    transform.setTranslation(0.3, 0, 0.3);
    samples = await capture('scene-tile-motion-blur-taa');
    validate(samples, 'taa-main', 0.05, 1, (2.7 - 0.1) / 9.9);
    check(state.render3d.passes[0]._sizedResources.size === 2, 'obsolete motion blur sizes were not retired');
  } finally {
    if (state) await destroyRealRendererBenchmarkScenario(state);
    large.destroy(); small.destroy(); resized.destroy();
  }
}
