import assert from 'node:assert/strict';
import test from 'node:test';

import * as extensionsRoot from '@haiyue/extensions';
import * as animation3d from '@haiyue/extensions/animation3d';
import * as gltf from '@haiyue/extensions/gltf';
import * as gltfAnimation3d from '@haiyue/extensions/gltf-animation3d';
import * as experimentalGltfWorker from '@haiyue/extensions/experimental/gltf-worker';
import * as experimentalSpineWorker from '@haiyue/extensions/experimental/spine-worker';
import * as animation from '@haiyue/extensions/animation';
import * as canvasText from '@haiyue/extensions/canvas-text';
import * as grid from '@haiyue/extensions/grid';
import * as hyaStateMachine from '@haiyue/extensions/hya-state-machine';
import * as spine from '@haiyue/extensions/spine';
import * as tilemap from '@haiyue/extensions/tilemap';
import * as tween from '@haiyue/extensions/tween';

test('extensions root stays a minimal authoring base instead of aggregating optional runtimes', () => {
  assert.deepEqual(Object.keys(extensionsRoot), ['RenderSystem2DBase']);
});

test('package exports resolve the reviewed Animation3D facades', () => {
  assert.equal(typeof animation3d.Animation3DMixer, 'function');
  assert.equal(typeof animation3d.Animation3DPoseBuffer, 'function');
  assert.equal(typeof animation3d.Animation3DStateMachineController, 'function');
  assert.equal(typeof gltfAnimation3d.createGltfAnimation3DRuntime, 'function');
  assert.equal(typeof gltfAnimation3d.createGltfAnimation3DClips, 'function');
});

test('stable glTF legacy sampler remains available without the adapter subpath', () => {
  assert.equal(typeof gltf.applyGltfAnimationClip, 'function');
  assert.equal('createInlineGltfAssetWorkerClient' in gltf, false);
  assert.equal('loadParsedGltfAsset' in gltf, false);
  assert.equal(typeof experimentalGltfWorker.createInlineGltfAssetWorkerClient, 'function');
});

test('second-batch stable extension facades resolve without worker protocol leakage', () => {
  assert.equal(typeof animation.Animation2DSystem, 'function');
  assert.equal(typeof hyaStateMachine.Animation2DStateMachineSystem, 'function');
  assert.equal(typeof spine.Spine2DRenderSystem, 'function');
  assert.equal(typeof tilemap.createTilemapPlugin, 'function');
  assert.equal(typeof canvasText.CanvasText2DRenderSystem, 'function');
  assert.equal(typeof tween.Tween2DSystem, 'function');
  assert.equal(typeof grid.Grid2DComponent, 'function');
  assert.equal('SpineAssetWorkerClient' in spine, false);
  assert.equal('parseSpineAssetPayload' in spine, false);
  assert.equal(typeof experimentalSpineWorker.SpineAssetWorkerClient, 'function');
  assert.equal(typeof experimentalSpineWorker.parseSpineAssetPayload, 'function');
});
