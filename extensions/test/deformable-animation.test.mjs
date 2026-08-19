import assert from 'node:assert/strict';
import test from 'node:test';
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

test('deformable sampler interpolates positions and opacity, flips screen Y, and steps render order', () => {
  const data = decodeDeformableMesh2DData(encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0, 1]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
      positions: new Float32Array([0, 10, 20, 10, 0, 30, 10, 20, 30, 20, 10, 40]),
      opacities: new Float32Array([1, 0]), renderOrders: new Float32Array([2, 9]),
    }],
  }));
  const target = new Float32Array(6);
  const sample = sampleDeformableMesh2DDrawable(data.times, data.drawables[0], 0.5, target);
  assert.deepEqual([...target], [5, -15, 25, -15, 5, -35]);
  assert.equal(sample.opacity, 0.5);
  assert.equal(sample.renderOrder, 2);
  assert.equal(sample.progress, 0.5);
});

test('deformable runtime preserves its owner transform chain and display-encoded texture colors', async () => {
  const encoded = encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1, times: new Float32Array([0]),
    drawables: [{
      id: 'mesh', textureIndex: 0, blendMode: 'normal', culling: false, masks: [],
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
  assert.equal(textureOptions[0].format, 'rgba8unorm', 'sRGB source bytes must stay display encoded in the 2D compositor');

  instance.destroy();
  assert.deepEqual(releaseCounts, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);
});
