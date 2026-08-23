import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeDeformableMesh2DData, DEFORMABLE_MESH_2D_EXTENSION_ID } from '@haiyue/animation-spec/deformable2d';
import { Entity, Geometry2D } from '@haiyue/engine';
import {
  AnimationVisual2D,
  AnimationVisual2DConfigurationError,
  Animation2DPipelineCreationError,
  ANIMATION_2D_WEBGPU_FRONT_FACE,
  animation2DCullingPipelineKey,
  animation2DCullingPrimitive,
  createAnimation2DPipeline,
} from '../dist-test/animation/AnimationVisual2D.js';
import {
  deformableWebGpuTriangleWinding,
  deformableTriangleSurvivesBackFaceCulling,
} from '../dist-test/deformable-animation/runtime/DeformableMaskComposition.js';
import { createDeformableMesh2DRuntimeExtension } from '../dist/deformable-animation.js';

test('source CCW remains WebGPU CCW and real reflection policy is deterministic', () => {
  const sourceCcw = [0, 0, 1, 0, 0, 1];
  assert.equal(deformableWebGpuTriangleWinding(sourceCcw), 'ccw');
  assert.equal(deformableWebGpuTriangleWinding(sourceCcw, [0, 1, 2], [-1, 1]), 'cw');
  assert.equal(deformableWebGpuTriangleWinding(sourceCcw, [0, 1, 2], [1, -1]), 'cw');
  assert.equal(deformableWebGpuTriangleWinding(sourceCcw, [0, 1, 2], [-1, -1]), 'ccw');
  assert.equal(deformableWebGpuTriangleWinding(sourceCcw, [0, 1, 2], [1, 1], true), 'cw');
  assert.equal(deformableTriangleSurvivesBackFaceCulling('ccw', true), true);
  assert.equal(deformableTriangleSurvivesBackFaceCulling('cw', true), false);
  assert.equal(deformableTriangleSurvivesBackFaceCulling('cw', false), true);
});

test('culling state has two stable pipeline variants and an explicit WebGPU primitive', () => {
  assert.equal(ANIMATION_2D_WEBGPU_FRONT_FACE, 'ccw');
  assert.deepEqual(animation2DCullingPrimitive(false), { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' });
  assert.deepEqual(animation2DCullingPrimitive(true), { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' });
  const keys = new Set(Array.from({ length: 100 }, (_, frame) => animation2DCullingPipelineKey(frame % 2 === 0)));
  assert.deepEqual([...keys].sort(), ['back:ccw', 'none:ccw']);
  const cause = new Error('fixture pipeline failure');
  assert.throws(
    () => createAnimation2DPipeline('visual:test:back:ccw', () => { throw cause; }),
    error => error instanceof Animation2DPipelineCreationError
      && error.code === 'E_ANIMATION_2D_PIPELINE_CREATION_FAILED'
      && error.path === '$runtime.animation2D.pipeline'
      && error.pipelineKey === 'visual:test:back:ccw'
      && error.cause === cause,
  );
});

test('AnimationVisual2D defaults to two-sided, clones culling, and rejects unknown state structurally', () => {
  const geometry = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
  const base = { geometry, color: [1, 1, 1, 1], instanceId: 1, nodeId: 'mesh', order: 0 };
  assert.equal(new AnimationVisual2D(base).culling, false);
  const culled = new AnimationVisual2D({ ...base, culling: true });
  assert.equal(culled.clone().culling, true);
  assert.throws(
    () => new AnimationVisual2D({ ...base, culling: 'back' }),
    error => error instanceof AnimationVisual2DConfigurationError
      && error.code === 'E_ANIMATION_2D_CULLING_INVALID'
      && error.path === '$.culling',
  );
});

test('deformable runtime keeps one culling value on main and every shared mask clone across seeks', async () => {
  const encoded = cullingData();
  const parent = new Entity('culling runtime');
  const releases = { data: 0, texture: 0 };
  const assetManager = {
    async load() { return { value: encoded, release() { releases.data++; } }; },
    async loadTexture() { return { value: {}, release() { releases.texture++; } }; },
  };
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const handler = createDeformableMesh2DRuntimeExtension({ onStatus(status) {
    if (status.state === 'ready' || status.state === 'error') resolveReady(status);
  } });
  const controller = new AbortController();
  const instance = handler.create(runtimeContext(parent, assetManager, controller.signal));
  assert.equal((await ready).state, 'ready');
  const root = parent.children[0];
  const visuals = root.children.map(child => child.getComponent(Symbol.for('AnimationVisual2D'))).filter(Boolean);
  const cullingVisuals = visuals.filter(visual => visual.nodeId.includes('source') || visual.nodeId === 'draw:source');
  assert.ok(cullingVisuals.length >= 2);
  assert.ok(cullingVisuals.every(visual => visual.culling === true));
  const identities = [...visuals];
  for (const time of [0.75, 0.1, 1.25, 0, 2]) instance.apply(time, 1);
  const after = root.children.map(child => child.getComponent(Symbol.for('AnimationVisual2D'))).filter(Boolean);
  assert.deepEqual(after, identities);
  assert.ok(after.filter(visual => visual.nodeId.includes('source') || visual.nodeId === 'draw:source').every(visual => visual.culling === true));
  instance.destroy();
  instance.destroy();
  assert.deepEqual(releases, { data: 1, texture: 1 });
  assert.equal(parent.children.length, 0);
});

function cullingData() {
  const drawable = (id, culling, masks = []) => ({
    id, textureIndex: 0, blendMode: 'normal', culling, masks,
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    positions: new Float32Array([0, 0, 1, 0, 0, 1, 0.1, 0, 1.1, 0, 0.1, 1]),
    opacities: new Float32Array([1, 0.5]), renderOrders: new Float32Array([0, 1]),
  });
  return encodeDeformableMesh2DData({
    canvasWidth: 100, canvasHeight: 100, duration: 1, frameRate: 1,
    times: new Float32Array([0, 1]),
    drawables: [drawable('source', true), drawable('masked-a', false, ['source']), drawable('masked-b', false, ['source'])],
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
