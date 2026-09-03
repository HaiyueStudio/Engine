import assert from 'node:assert/strict';
import test from 'node:test';
import { animationMaskCompositeKey, animationMaskTargetKey, assertAnimationMaskBudget } from '../dist-test/animation/AnimationMaskBudget.js';
import { cubismMaskCoverage } from '../dist-test/deformable-animation/runtime/DeformableMaskComposition.js';
import {
  animationBlendFragmentEntryPoint,
  animationBlendState,
  composeAnimationBlendPixel,
} from '../dist-test/animation/AnimationBlendMode.js';
import {
  DEFORMABLE_MESH_2D_EXTENSION_ID,
  decodeDeformableMesh2DData,
  encodeDeformableMesh2DData,
} from '@haiyue/animation-spec/deformable2d';
import { Entity, Transform2D } from '@haiyue/engine';
import {
  createDeformableMesh2DRuntimeExtension,
  sampleDeformableMesh2DDrawable,
} from '../dist/deformable-animation.js';
import { sampleDeformableMesh2DDrawableColors } from '../dist-test/deformable-animation/runtime/DeformableMesh2DSampler.js';
import {
  DeformableMesh2DClipMixer,
  DeformableMesh2DPoseBuffer,
  DeformableMesh2DPoseError,
  sampleDeformableMesh2DPose,
} from '../dist-test/deformable-animation/runtime/DeformableMesh2DPoseMixer.js';

test('animation premultiplied blend contract covers normal, additive, multiplicative and screen semantics', () => {
  assert.deepEqual(animationBlendState('normal'), {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  });
  assert.deepEqual(animationBlendState('additive'), {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  });
  assert.deepEqual(animationBlendState('multiplicative'), {
    color: { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
  });
  assert.deepEqual(animationBlendState('screen'), {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  });
  assert.equal(animationBlendFragmentEntryPoint('normal'), 'fs_main');
  assert.equal(animationBlendFragmentEntryPoint('additive'), 'fs_main');
  assert.equal(animationBlendFragmentEntryPoint('multiplicative'), 'fs_main');
  assert.equal(animationBlendFragmentEntryPoint('screen'), 'fs_main');
  assert.equal(animationBlendFragmentEntryPoint('normal', 'premultiplied'), 'fs_main_premultiplied_texture');
  assert.equal(animationBlendFragmentEntryPoint('additive', 'premultiplied'), 'fs_main_premultiplied_texture');
  assert.equal(animationBlendFragmentEntryPoint('multiplicative', 'premultiplied'), 'fs_main_premultiplied_texture');
  assert.equal(animationBlendFragmentEntryPoint('normal', 'rive-text'), 'fs_main_rive_text');

  const source = [0.8, 0.25, 0.5, 0.5];
  const destination = [0.2, 0.4, 0.6, 0.75];
  const common = { source, destination, opacity: 0.5, coverage: 0.5 };
  assertPixelClose(composeAnimationBlendPixel({ ...common, mode: 'normal' }), [0.275, 0.38125, 0.5875, 0.78125]);
  assertPixelClose(composeAnimationBlendPixel({ ...common, mode: 'additive' }), [0.3, 0.43125, 0.6625, 0.75]);
  assertPixelClose(composeAnimationBlendPixel({ ...common, mode: 'multiplicative' }), [0.195, 0.3625, 0.5625, 0.75]);
  assertPixelClose(composeAnimationBlendPixel({ ...common, mode: 'screen' }), [0.28, 0.41875, 0.625, 0.78125]);
  assert.deepEqual(
    composeAnimationBlendPixel({ ...common, coverage: 0, mode: 'multiplicative' }),
    destination,
    'outside a Cubism mask must preserve the destination exactly',
  );
});

function assertPixelClose(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= 1e-12, `channel ${index}: ${actual[index]} != ${expected[index]}`);
  }
}

test('deformable sampler interpolates positions and opacity, flips screen Y, and steps render order', () => {
  const data = decodeDeformableMesh2DData(encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0, 1]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: new Float32Array([0, 10, 20, 10, 0, 30, 10, 20, 30, 20, 10, 40]),
      opacities: new Float32Array([1, 0]), renderOrders: new Float32Array([2, 9]),
      multiplyColors: new Float32Array([1, 1, 1, 1, 0.5, 0.75, 1, 0.5]),
      screenColors: new Float32Array([0, 0, 0, 0, 0.2, 0.4, 0.6, 0.8]),
    }],
  }));
  const target = new Float32Array(6);
  const sample = sampleDeformableMesh2DDrawable(data.times, data.drawables[0], 0.5, target);
  assert.deepEqual([...target], [5, -15, 25, -15, 5, -35]);
  assert.equal(sample.opacity, 0.5);
  assert.equal(sample.renderOrder, 2);
  assert.equal(sample.progress, 0.5);
  const multiply = new Float32Array(4);
  const screen = new Float32Array(4);
  sampleDeformableMesh2DDrawableColors(data.drawables[0], sample, multiply, screen);
  assertFloatArrayClose(multiply, [0.75, 0.875, 1, 0.75]);
  assertFloatArrayClose(screen, [0.1, 0.2, 0.3, 0.4]);
});

test('deformable clip mixer cross-fades two ranges on one retained pose with deterministic discrete winners', () => {
  const data = decodeDeformableMesh2DData(deformableData({
    duration: 2.25,
    times: new Float32Array([0, 1, 1.25, 2.25]),
    positions: new Float32Array([
      0, 10, 20, 10, 0, 30, 10, 10, 30, 10, 10, 30,
      100, 10, 120, 10, 100, 30, 110, 10, 130, 10, 110, 30,
    ]),
    opacities: new Float32Array([1, 0.8, 0.4, 0.2]),
    renderOrders: new Float32Array([1, 2, 8, 9]),
  }));
  const mixer = new DeformableMesh2DClipMixer(data);
  const output = mixer.output;
  const positions = output.positions[0];
  const first = { id: 'idle', clip: { id: 'idle', start: 0, duration: 1, loop: false }, time: 1, weight: 0.5, order: 0 };
  const second = { id: 'tap', clip: { id: 'tap', start: 1.25, duration: 1, loop: false }, time: 0, weight: 0.5, order: 1 };
  assert.equal(mixer.evaluate([first, second]), output);
  assert.equal(output.positions[0], positions, 'cross-fade must reuse one model pose buffer');
  assert.deepEqual([...positions], [55, -10, 75, -10, 55, -30]);
  assert.ok(Math.abs(output.opacities[0] - 0.6) < 1e-6);
  assert.equal(output.renderOrders[0], 8, 'equal-weight discrete tie resolves by stable action order');
  const revision = output.revision;
  mixer.evaluate([second, first]);
  assert.equal(output.revision, revision + 1);
  assert.deepEqual([...positions], [55, -10, 75, -10, 55, -30], 'input permutation must not alter the mixed pose');
  assert.equal(output.renderOrders[0], 8);
  mixer.destroy();
  mixer.destroy();
  assert.throws(() => mixer.evaluate([]), error => error instanceof DeformableMesh2DPoseError && error.code === 'E_DEFORMABLE_POSE_DESTROYED');
});

test('deformable pose port handles looping, missing channels, additive vertices, and topology mismatch', () => {
  const data = decodeDeformableMesh2DData(deformableData({
    times: new Float32Array([0, 1]),
    positions: new Float32Array([0, 10, 20, 10, 0, 30, 10, 20, 30, 20, 10, 40]),
    opacities: new Float32Array([1, 0.5]),
    renderOrders: new Float32Array([2, 9]),
    multiplyColors: new Float32Array([1, 1, 1, 1, 0.5, 0.75, 1, 0.5]),
    screenColors: new Float32Array([0, 0, 0, 0, 0.2, 0.4, 0.6, 0.8]),
  }));
  const pose = new DeformableMesh2DPoseBuffer(data);
  sampleDeformableMesh2DPose(data, 0.5, pose);
  assert.deepEqual([...pose.positions[0]], [5, -15, 25, -15, 5, -35]);
  assertFloatArrayClose(pose.multiplyColors, [0.75, 0.875, 1, 0.75]);
  assertFloatArrayClose(pose.screenColors, [0.1, 0.2, 0.3, 0.4]);
  const mixer = new DeformableMesh2DClipMixer(data);
  const onlyVertices = new Set(['vertices']);
  mixer.evaluate([{ id: 'loop', clip: { id: 'loop', start: 0, duration: 1 }, time: 1.5, weight: 1, channels: onlyVertices }]);
  assert.equal(mixer.output.opacities[0], 1, 'missing opacity channel retains the reference value');
  assert.equal(mixer.output.renderOrders[0], 2, 'missing discrete channel retains the reference winner');
  mixer.evaluate([{ id: 'add', clip: { id: 'add', start: 0, duration: 1, loop: false }, time: 1, weight: 0.5, blend: 'additive', channels: onlyVertices }]);
  assert.deepEqual([...mixer.output.positions[0]], [5, -15, 25, -15, 5, -35]);
  const onlyColor = new Set(['color']);
  mixer.evaluate([{ id: 'color-override', clip: { id: 'color', start: 0, duration: 1, loop: false }, time: 1, weight: 0.5, channels: onlyColor }]);
  assertFloatArrayClose(mixer.output.multiplyColors, [0.75, 0.875, 1, 0.75]);
  assertFloatArrayClose(mixer.output.screenColors, [0.1, 0.2, 0.3, 0.4]);
  mixer.evaluate([{ id: 'color-add', clip: { id: 'color-add', start: 0, duration: 1, loop: false }, time: 1, weight: 0.5, blend: 'additive', channels: onlyColor }]);
  assertFloatArrayClose(mixer.output.multiplyColors, [0.75, 0.875, 1, 0.75]);
  assertFloatArrayClose(mixer.output.screenColors, [0.1, 0.2, 0.3, 0.4]);
  assert.throws(() => mixer.evaluate([{ id: 'bad-add', clip: { id: 'bad', start: 0, duration: 1 }, time: 0, weight: 1, blend: 'additive' }]), error => error instanceof DeformableMesh2DPoseError && error.code === 'E_DEFORMABLE_POSE_ADDITIVE_DISCRETE');
  const incompatible = decodeDeformableMesh2DData(encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0]),
    drawables: [{ id: 'other', textureIndex: 0, blendMode: 'normal', culling: false, masks: [], uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), positions: new Float32Array([0, 0, 1, 0, 0, 1]), opacities: new Float32Array([1]), renderOrders: new Float32Array([0]) }],
  }));
  assert.throws(() => mixer.rebind(incompatible), error => error instanceof DeformableMesh2DPoseError && error.code === 'E_DEFORMABLE_POSE_TOPOLOGY');
});

test('deformable runtime preserves its owner transform chain and display-encoded texture colors', async () => {
  const encoded = encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'additive', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: new Float32Array([0, 10, 20, 10, 0, 30]),
      opacities: new Float32Array([1]), renderOrders: new Float32Array([2]),
    }],
  });
  const textureOptions = [];
  const releaseCounts = { data: 0, texture: 0 };
  const assetManager = {
    async load() {
      return { value: encoded, release() { releaseCounts.data++; } };
    },
    async loadTexture(_uri, options) {
      textureOptions.push(options);
      return { value: {}, release() { releaseCounts.texture++; } };
    },
  };
  const parent = new Entity('extension parent');
  const ownerTransform = new Transform2D();
  ownerTransform.setScale(1.75).setPosition(24, -13);
  parent.addComponent(ownerTransform);
  const controller = new AbortController();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const handler = createDeformableMesh2DRuntimeExtension({
    onStatus(status) {
      if (status.state === 'ready' || status.state === 'error') resolveReady(status);
    },
  });
  assert.equal(handler.id, DEFORMABLE_MESH_2D_EXTENSION_ID);
  const instance = handler.create({
    animation: {
      canvas: { width: 100, height: 100 },
      duration: 1,
      resources: [
        { id: 'mesh-data', type: 'binary', uri: 'mesh.hyad' },
        { id: 'texture-0', type: 'image', uri: 'texture.png', colorSpace: 'srgb' },
      ],
    },
    node: { id: 'model', name: 'model', components: [] },
    component: {
      type: DEFORMABLE_MESH_2D_EXTENSION_ID,
      dataResource: 'mesh-data',
      textures: ['texture-0'],
    },
    parent,
    assetManager,
    instanceId: 1,
    signal: controller.signal,
  });

  const status = await ready;
  assert.deepEqual(status, { state: 'ready', drawableCount: 1 });
  assert.equal(parent.children.length, 1);
  const runtimeRoot = parent.children[0];
  assert.ok(runtimeRoot.getComponent(Transform2D), 'runtime root must bridge the owning transform to drawable children');
  assert.equal(runtimeRoot.children.length, 1);
  const visual = runtimeRoot.children[0].getComponent(Symbol.for('AnimationVisual2D'));
  assert.equal(visual.blendMode, 'additive');
  assert.equal(visual.textureAlphaMode, 'premultiplied');
  assert.equal(textureOptions[0].format, 'rgba8unorm', 'sRGB source bytes must stay display encoded in the 2D compositor');
  assert.equal(textureOptions[0].premultipliedAlpha, true, 'Cubism filtering must operate on premultiplied texels');

  const geometryId = visual.geometry.id;
  const initialRevision = visual.revision;
  instance.apply(0, 0.4);
  assert.equal(visual.geometry.id, geometryId, 'sampling must update one shared geometry instead of rebuilding the drawable');
  assert.equal(visual.color[3], 0.4);
  assert.ok(visual.revision > initialRevision);

  instance.destroy();
  instance.destroy();
  assert.deepEqual(releaseCounts, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);
});

test('deformable runtime reuses one combined target for shared multi-source alpha and inverted masks', async () => {
  const encoded = sharedMaskGroupData();
  const parent = new Entity('shared mask owner');
  const controller = new AbortController();
  const { instance, ready } = createRuntime({ encoded, parent, signal: controller.signal });
  assert.deepEqual(await ready, { state: 'ready', drawableCount: 4 });

  const runtimeRoot = parent.children[0];
  const visuals = runtimeRoot.children.map(child => child.getComponent(Symbol.for('AnimationVisual2D')));
  const mainVisuals = visuals.filter(visual => !visual.sourceOnly);
  const maskSources = visuals.filter(visual => visual.sourceOnly);
  assert.equal(mainVisuals.length, 4, 'mask source drawables must remain visible in the main scene');
  assert.equal(maskSources.length, 2, 'one shared two-source group must not duplicate a target per consumer');
  assert.equal(new Set(maskSources.map(visual => visual.nodeId)).size, 1, 'both sources must render into one stable group identity');

  const alpha = mainVisuals.find(visual => visual.nodeId === 'draw:masked-alpha');
  const inverted = mainVisuals.find(visual => visual.nodeId === 'draw:masked-inverted');
  assert.equal(alpha.compositeLayers.length, 1);
  assert.equal(inverted.compositeLayers.length, 1);
  assert.equal(alpha.compositeLayers[0].source, inverted.compositeLayers[0].source);
  assert.equal(alpha.compositeLayers[0].mode, 'alpha');
  assert.equal(inverted.compositeLayers[0].mode, 'alpha-inverted');

  instance.apply(0, 0.5);
  const maskAMain = mainVisuals.find(visual => visual.nodeId === 'draw:mask-a');
  const maskASource = maskSources.find(visual => visual.geometry === maskAMain.geometry);
  assert.equal(maskAMain.color[3], 0.125, 'mask source remains visible in the main pass with sampled drawable/model opacity');
  assert.equal(maskASource.color[3], 1, 'Cubism setup-mask contribution must ignore drawable/model opacity');
  assert.equal(maskASource.compositeLayers.length, 0, 'Cubism setup-mask contribution must ignore the source drawable clipping context');
  instance.destroy();
});

test('mask allocation budgets fail with structured group, texture and pixel diagnostics', () => {
  const base = { groupCount: 2, maxGroupCount: 2, width: 64, height: 32, maxTextureDimension2D: 4096, maxPixels: 4096, viewKey: 'fixture' };
  assert.doesNotThrow(() => assertAnimationMaskBudget(base));
  assert.throws(
    () => assertAnimationMaskBudget({ ...base, groupCount: 3 }),
    error => error.code === 'E_ANIMATION_LIMIT_EXCEEDED' && error.path.endsWith('.maskGroups'),
  );
  assert.throws(
    () => assertAnimationMaskBudget({ ...base, width: 4097 }),
    error => error.code === 'E_ANIMATION_LIMIT_EXCEEDED' && error.path.endsWith('.maskTexture'),
  );
  assert.throws(
    () => assertAnimationMaskBudget({ ...base, maxPixels: 4095 }),
    error => error.code === 'E_ANIMATION_LIMIT_EXCEEDED' && error.path.endsWith('.maskPixels'),
  );
});

test('mask target and composite identities are collision-free across views', () => {
  assert.notEqual(animationMaskTargetKey('view:a', 'source'), animationMaskTargetKey('view', 'a:source'));
  assert.notEqual(animationMaskCompositeKey('view:a', ['one', 'two']), animationMaskCompositeKey('view', ['a:one', 'two']));
  assert.equal(animationMaskTargetKey('view', 'source'), animationMaskTargetKey('view', 'source'));
});

test('CPU mask oracle matches Cubism remaining-coverage composition for single, multi-source and inverted masks', () => {
  assert.equal(cubismMaskCoverage([0.25]), 0.25);
  assert.equal(cubismMaskCoverage([0.25, 0.25]), 0.4375, 'repeated Core mask references must contribute repeatedly');
  assert.equal(cubismMaskCoverage([0.25, 0.5]), 0.625);
  assert.equal(cubismMaskCoverage([0.25, 0.5], true), 0.375);
  assert.equal(cubismMaskCoverage([0.25, 0.5]), 1 - ((1 - 0.25) * (1 - 0.5)));
  assert.throws(() => cubismMaskCoverage([1.01]), /inside \[0, 1\]/);
});

test('deformable runtime samples geometry and order in place across random seek', async () => {
  const encoded = deformableData({
    times: new Float32Array([0, 1]),
    positions: new Float32Array([0, 10, 20, 10, 0, 30, 10, 20, 30, 20, 10, 40]),
    opacities: new Float32Array([1, 0.5]),
    renderOrders: new Float32Array([2, 9]),
  });
  const parent = new Entity('seek owner');
  const controller = new AbortController();
  const { instance, ready } = createRuntime({ encoded, parent, signal: controller.signal });
  assert.deepEqual(await ready, { state: 'ready', drawableCount: 1 });
  const visual = parent.children[0].children[0].getComponent(Symbol.for('AnimationVisual2D'));
  const geometry = visual.geometry;
  instance.apply(0.5, 0.8);
  assert.deepEqual([...geometry.positions], [5, -15, 25, -15, 5, -35]);
  assert.ok(Math.abs(visual.color[3] - 0.6) < 1e-9);
  assert.equal(visual.order, 2);
  const revision = geometry.version;
  instance.apply(1, 1);
  assert.equal(visual.geometry, geometry);
  assert.deepEqual([...geometry.positions], [10, -20, 30, -20, 10, -40]);
  assert.equal(visual.order, 9);
  assert.ok(geometry.version > revision);
  instance.destroy();
});

test('owner abort destroys a ready runtime and releases every asset exactly once', async () => {
  const encoded = deformableData();
  const parent = new Entity('abort owner');
  const controller = new AbortController();
  const releases = { data: 0, texture: 0 };
  const { instance, ready } = createRuntime({ encoded, parent, signal: controller.signal, releases });
  await ready;
  controller.abort('owner-destroyed');
  assert.equal(parent.children.length, 0);
  assert.deepEqual(releases, { data: 1, texture: 1 });
  instance.destroy();
  assert.deepEqual(releases, { data: 1, texture: 1 });
});

test('deformable model replacement releases the old mask runtime before installing a fresh owner', async () => {
  const parent = new Entity('replacement owner');
  const firstReleases = { data: 0, texture: 0 };
  const first = createRuntime({ encoded: sharedMaskGroupData(), parent, signal: new AbortController().signal, releases: firstReleases });
  assert.equal((await first.ready).state, 'ready');
  const oldRoot = parent.children[0];
  assert.ok(oldRoot.children.some(child => child.getComponent(Symbol.for('AnimationVisual2D'))?.sourceOnly));
  first.instance.destroy();
  assert.deepEqual(firstReleases, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);

  const secondReleases = { data: 0, texture: 0 };
  const second = createRuntime({ encoded: sharedMaskGroupData(), parent, signal: new AbortController().signal, releases: secondReleases });
  assert.equal((await second.ready).state, 'ready');
  assert.equal(parent.children.length, 1);
  assert.notEqual(parent.children[0], oldRoot);
  assert.equal(parent.children[0].children.filter(child => child.getComponent(Symbol.for('AnimationVisual2D'))?.sourceOnly).length, 2);
  second.instance.destroy();
  second.instance.destroy();
  assert.deepEqual(secondReleases, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);
});

test('late data completion after owner abort cannot write back and releases its handle', async () => {
  const encoded = deformableData();
  const parent = new Entity('late owner');
  const controller = new AbortController();
  let resolveData;
  let dataReleases = 0;
  let textureLoads = 0;
  const assetManager = {
    load() {
      return new Promise(resolve => { resolveData = resolve; });
    },
    async loadTexture() {
      textureLoads++;
      return { value: {}, release() {} };
    },
  };
  const handler = createDeformableMesh2DRuntimeExtension();
  const instance = handler.create(runtimeContext(parent, assetManager, controller.signal));
  controller.abort('owner-destroyed');
  resolveData({ value: encoded, release() { dataReleases++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(parent.children.length, 0);
  assert.equal(textureLoads, 0);
  assert.equal(dataReleases, 1);
  instance.destroy();
});

test('texture failure rolls back earlier handles and reports one classified runtime error', async () => {
  const encoded = deformableData();
  const parent = new Entity('failure owner');
  const controller = new AbortController();
  const releases = { data: 0, texture: 0 };
  let textureIndex = 0;
  const assetManager = {
    async load() { return { value: encoded, release() { releases.data++; } }; },
    async loadTexture() {
      if (textureIndex++ === 0) return { value: {}, release() { releases.texture++; } };
      throw new Error('fixture texture failed');
    },
  };
  let resolveStatus;
  const status = new Promise(resolve => { resolveStatus = resolve; });
  const handler = createDeformableMesh2DRuntimeExtension({ onStatus(value) { if (value.state === 'error') resolveStatus(value); } });
  const context = runtimeContext(parent, assetManager, controller.signal);
  context.animation.resources.push({ id: 'texture-1', type: 'image', uri: 'texture-1.png', colorSpace: 'srgb' });
  context.component.textures.push('texture-1');
  handler.create(context);
  const failed = await status;
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /Texture 1 failed: fixture texture failed/);
  assert.deepEqual(releases, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);
});

function deformableData(overrides = {}) {
  const times = overrides.times ?? new Float32Array([0]);
  return encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: overrides.duration ?? 1, frameRate: 1, times,
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: overrides.positions ?? new Float32Array([0, 10, 20, 10, 0, 30]),
      opacities: overrides.opacities ?? new Float32Array([1]),
      renderOrders: overrides.renderOrders ?? new Float32Array([2]),
      ...(overrides.multiplyColors === undefined ? {} : { multiplyColors: overrides.multiplyColors }),
      ...(overrides.screenColors === undefined ? {} : { screenColors: overrides.screenColors }),
    }],
  });
}

function assertFloatArrayClose(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `index ${index}: ${actual[index]} != ${expected[index]}`);
}

function sharedMaskGroupData() {
  const geometry = {
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    positions: new Float32Array([0, 10, 20, 10, 0, 30]),
    renderOrders: new Float32Array([0]),
  };
  const drawable = (id, order, opacity, masks = [], maskMode = 'alpha') => ({
    id,
    textureIndex: 0,
    blendMode: 'normal',
    culling: false,
    masks,
    maskMode,
    uvs: geometry.uvs.slice(),
    indices: geometry.indices.slice(),
    positions: geometry.positions.slice(),
    opacities: new Float32Array([opacity]),
    renderOrders: new Float32Array([order]),
  });
  return encodeDeformableMesh2DData({
    canvasWidth: 100,
    canvasHeight: 100,
    duration: 1,
    frameRate: 1,
    times: new Float32Array([0]),
    drawables: [
      drawable('mask-a', 0, 0.25),
      drawable('mask-b', 1, 0.5),
      drawable('masked-alpha', 2, 1, ['mask-b', 'mask-a']),
      drawable('masked-inverted', 3, 1, ['mask-a', 'mask-b'], 'alpha-inverted'),
    ],
  });
}

function runtimeContext(parent, assetManager, signal) {
  return {
    animation: {
      canvas: { width: 100, height: 100 }, duration: 1,
      resources: [
        { id: 'mesh-data', type: 'binary', uri: 'mesh.hydm' },
        { id: 'texture-0', type: 'image', uri: 'texture.png', colorSpace: 'srgb' },
      ],
    },
    node: { id: 'model', name: 'model', components: [] },
    component: { type: DEFORMABLE_MESH_2D_EXTENSION_ID, dataResource: 'mesh-data', textures: ['texture-0'] },
    parent, assetManager, instanceId: 1, signal,
  };
}

function createRuntime({ encoded, parent, signal, releases = { data: 0, texture: 0 } }) {
  const assetManager = {
    async load() { return { value: encoded, release() { releases.data++; } }; },
    async loadTexture() { return { value: {}, release() { releases.texture++; } }; },
  };
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const handler = createDeformableMesh2DRuntimeExtension({ onStatus(status) {
    if (status.state === 'ready' || status.state === 'error') resolveReady(status);
  } });
  return { instance: handler.create(runtimeContext(parent, assetManager, signal)), ready, releases };
}
