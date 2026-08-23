import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDeformableMesh2DData, DEFORMABLE_MESH_2D_EXTENSION_ID } from '@haiyue/animation-spec/deformable2d';
import { Entity, Geometry2D } from '@haiyue/engine';
import {
  AnimationVisual2D,
  AnimationVisual2DConfigurationError,
  composeAnimationDrawableColorPixel,
} from '../dist-test/animation/AnimationVisual2D.js';
import { composeAnimationBlendPixel } from '../dist-test/animation/AnimationBlendMode.js';
import { createDeformableMesh2DRuntimeExtension } from '../dist/deformable-animation.js';

test('CPU oracle matches frozen Cubism multiply then alpha-aware screen order', () => {
  const input = {
    texture: [0.4, 0.2, 0.1, 0.5],
    textureAlphaMode: 'premultiplied',
    baseColor: [0.8, 0.5, 1, 0.6],
    multiplyColor: [0.5, 1, 0.25, 0.1],
    screenColor: [0.2, 0.4, 0.6, 0.9],
    coverage: 0.25,
  };
  assertPixelClose(composeAnimationDrawableColorPixel(input), officialDrawableColor(input));
  assert.deepEqual(
    composeAnimationDrawableColorPixel({ texture: [0, 0, 0, 0], screenColor: [1, 1, 1, 1] }),
    [0, 0, 0, 0],
    'alpha-aware screen tint must not color transparent texels',
  );
  const alphaVariant = composeAnimationDrawableColorPixel({ ...input, multiplyColor: [0.5, 1, 0.25, 1], screenColor: [0.2, 0.4, 0.6, 0] });
  assertPixelClose(alphaVariant, composeAnimationDrawableColorPixel(input), 'tint alpha is ignored');
  const mask = composeAnimationDrawableColorPixel({ ...input, outputMask: true });
  const neutralMask = composeAnimationDrawableColorPixel({
    ...input,
    multiplyColor: [1, 1, 1, 1],
    screenColor: [0, 0, 0, 0],
    outputMask: true,
  });
  assertPixelClose(mask, neutralMask, 'mask setup is tint independent');
});

test('neutral drawable colors preserve legacy straight and premultiplied output', () => {
  assertPixelClose(
    composeAnimationDrawableColorPixel({ texture: [0.8, 0.4, 0.2, 0.5], baseColor: [0.5, 0.75, 1, 0.4], coverage: 0.5 }),
    [0.04, 0.03, 0.02, 0.1],
  );
  assertPixelClose(
    composeAnimationDrawableColorPixel({ texture: [0.4, 0.2, 0.1, 0.5], textureAlphaMode: 'premultiplied', baseColor: [0.5, 0.75, 1, 0.4], coverage: 0.5 }),
    [0.04, 0.03, 0.02, 0.1],
  );
});

test('drawable color composes before all three framebuffer blend modes', () => {
  const source = composeAnimationDrawableColorPixel({
    texture: [0.4, 0.2, 0.1, 0.5], textureAlphaMode: 'premultiplied',
    multiplyColor: [0.5, 0.75, 1, 1], screenColor: [0.2, 0.1, 0.4, 0],
  });
  const destination = [0.2, 0.4, 0.6, 0.75];
  for (const mode of ['normal', 'additive', 'multiplicative']) {
    const result = composeAnimationBlendPixel({ source, destination, opacity: 1, coverage: 1, mode });
    assert.ok(result.every(Number.isFinite), `${mode} composition must remain finite`);
  }
});

test('AnimationVisual2D keeps neutral defaults, retained mutable colors, clone parity and structured failures', () => {
  const geometry = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
  const visual = new AnimationVisual2D({ geometry, color: [1, 1, 1, 1], instanceId: 1, nodeId: 'mesh', order: 0 });
  assert.deepEqual(visual.multiplyColor, [1, 1, 1, 1]);
  assert.deepEqual(visual.screenColor, [0, 0, 0, 0]);
  const revision = visual.revision;
  visual.setDrawableColors(new Float32Array([0.5, 0.6, 0.7, 0.25]), new Float32Array([0.1, 0.2, 0.3, 0.75]));
  assert.equal(visual.revision, revision + 1);
  const clone = visual.clone();
  assert.deepEqual(clone.multiplyColor, visual.multiplyColor);
  assert.deepEqual(clone.screenColor, visual.screenColor);
  assert.notEqual(clone.multiplyColor, visual.multiplyColor);
  assert.throws(
    () => visual.setDrawableColors(new Float32Array([1, 1, Number.NaN, 1]), new Float32Array(4)),
    error => error instanceof AnimationVisual2DConfigurationError
      && error.code === 'E_ANIMATION_2D_MULTIPLY_COLOR_INVALID'
      && error.path === '$.multiplyColor',
  );
  assert.throws(
    () => new AnimationVisual2D({ geometry, color: [1, 1, 1, 1], screenColor: [0, 0, 2, 0], instanceId: 1, nodeId: 'bad', order: 0 }),
    error => error instanceof AnimationVisual2DConfigurationError
      && error.code === 'E_ANIMATION_2D_SCREEN_COLOR_INVALID'
      && error.path === '$.screenColor',
  );
});

test('deformable runtime samples colors in place on main and mask clones without re-instantiation', async () => {
  const parent = new Entity('drawable color owner');
  const encoded = drawableColorData();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const releases = { data: 0, texture: 0 };
  const handler = createDeformableMesh2DRuntimeExtension({ onStatus(status) {
    if (status.state === 'ready' || status.state === 'error') resolveReady(status);
  } });
  const instance = handler.create(runtimeContext(parent, encoded, releases));
  assert.equal((await ready).state, 'ready');
  const root = parent.children[0];
  const visuals = root.children.map(child => child.getComponent(Symbol.for('AnimationVisual2D'))).filter(Boolean);
  const identities = [...visuals];
  instance.apply(0.5, 0.4);
  const sourceVisuals = visuals.filter(visual => visual.nodeId === 'draw:source' || visual.sourceOnly);
  assert.equal(sourceVisuals.length, 2);
  for (const visual of sourceVisuals) {
    assertPixelClose(visual.multiplyColor, [0.75, 0.625, 0.5, 0.5]);
    assertPixelClose(visual.screenColor, [0.1, 0.2, 0.3, 0.4]);
  }
  assert.equal(sourceVisuals.find(visual => visual.sourceOnly).color[3], 1, 'mask setup ignores drawable/model opacity');
  assert.ok(Math.abs(sourceVisuals.find(visual => !visual.sourceOnly).color[3] - 0.3) <= 1e-12, 'main visual keeps sampled drawable opacity');
  for (const time of [1, 0, 0.75, 0.25]) instance.apply(time, 1);
  assert.deepEqual(root.children.map(child => child.getComponent(Symbol.for('AnimationVisual2D'))).filter(Boolean), identities);
  instance.destroy();
  instance.destroy();
  assert.deepEqual(releases, { data: 1, texture: 1 });
});

function officialDrawableColor(input) {
  const alpha = input.texture[3];
  const rgb = input.texture.slice(0, 3);
  for (let index = 0; index < 3; index++) {
    rgb[index] *= input.multiplyColor[index];
    rgb[index] = rgb[index] + input.screenColor[index] * alpha - rgb[index] * input.screenColor[index];
    rgb[index] *= input.baseColor[index] * input.baseColor[3] * input.coverage;
  }
  return [...rgb, alpha * input.baseColor[3] * input.coverage];
}

function assertPixelClose(actual, expected, message = '') {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= 1e-6, `${message} channel ${index}: ${actual[index]} != ${expected[index]}`);
  }
}

function drawableColorData() {
  const drawable = (id, masks, colors = {}) => ({
    id, textureIndex: 0, blendMode: 'normal', culling: false, masks,
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    positions: new Float32Array([0, 0, 1, 0, 0, 1, 0.1, 0, 1.1, 0, 0.1, 1]),
    opacities: new Float32Array([1, 0.5]), renderOrders: new Float32Array([0, 1]),
    ...colors,
  });
  return encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0, 1]),
    drawables: [
      drawable('source', [], {
        multiplyColors: new Float32Array([1, 1, 1, 1, 0.5, 0.25, 0, 0]),
        screenColors: new Float32Array([0, 0, 0, 0, 0.2, 0.4, 0.6, 0.8]),
      }),
      drawable('masked', ['source']),
    ],
  });
}

function runtimeContext(parent, encoded, releases) {
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
    parent,
    assetManager: {
      async load() { return { value: encoded, release() { releases.data++; } }; },
      async loadTexture() { return { value: {}, release() { releases.texture++; } }; },
    },
    instanceId: 1,
    signal: new AbortController().signal,
  };
}
