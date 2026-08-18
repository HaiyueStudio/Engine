import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Mesh3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import {
  applyGltfAnimationClip,
  disposeGltfModel,
  loadGltfModel,
} from '../dist/gltf.js';
import * as gltfAnimation3d from '../dist/gltf-animation3d.js';
import {
  createGltfAnimation3DClips,
  createGltfAnimation3DRuntime,
} from '../dist/gltf-animation3d.js';

const FIXTURE_URL = new URL('./fixtures/gltf/animation-characterization.gltf', import.meta.url);

async function loadFixtureModel() {
  const source = await readFile(FIXTURE_URL, 'utf8');
  return loadGltfModel(`data:model/gltf+json,${encodeURIComponent(source)}`);
}

function findEntity(root, name) {
  if (root.name === name) return root;
  for (const child of root.children) {
    const match = findEntity(child, name);
    if (match) return match;
  }
  return null;
}

function requireEntity(root, name) {
  const entity = findEntity(root, name);
  assert.ok(entity, `Expected fixture entity "${name}"`);
  return entity;
}

function requireGeometry(root, nodeName) {
  const node = requireEntity(root, nodeName);
  const primitive = node.children.find(child => child.getComponent(Mesh3D));
  const mesh = primitive?.getComponent(Mesh3D);
  assert.ok(mesh, `Expected fixture mesh below "${nodeName}"`);
  return mesh.geometry;
}

function assertArrayClose(actual, expected, epsilon = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const delta = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    assert.ok(
      delta <= epsilon,
      `value ${index}: ${actual[index]} differs from ${expected[index]} by ${delta}`,
    );
  }
}

function assertRuntimeReleased(runtime) {
  assert.equal(runtime.state, 'destroyed');
  assert.equal(runtime.root, null);
  assert.equal(runtime.clips.length, 0);
  assert.equal(runtime.mixer.state, 'destroyed');
  assert.equal(runtime.mixer.actions.length, 0);
  assert.equal(runtime.bindingCount, 0);
  assert.equal(runtime.targetCount, 0);
}

test('stable glTF Animation3D facade exports no resolver or pose-applier handle', () => {
  assert.deepEqual(Object.keys(gltfAnimation3d).sort(), [
    'GltfAnimation3DRuntime',
    'createGltfAnimation3DClips',
    'createGltfAnimation3DRuntime',
  ]);
  assert.equal('GltfAnimation3DBindingResolver' in gltfAnimation3d, false);
  assert.equal('GltfAnimation3DPoseApplier' in gltfAnimation3d, false);
});

test('glTF adapter creates source-independent Animation3D clips without losing sampler data', async () => {
  const model = await loadFixtureModel();
  try {
    const clips = createGltfAnimation3DClips(model, 'fixture');
    assert.equal(clips.length, 2);
    assert.deepEqual(clips.map(clip => clip.name), ['Take', 'Take']);
    assert.deepEqual(clips.map(clip => clip.id), ['fixture:0', 'fixture:1']);
    assert.notEqual(clips[0].id, clips[1].id);

    const expectedInterpolation = {
      STEP: 'step',
      LINEAR: 'linear',
      CUBICSPLINE: 'cubic-spline',
    };
    const expectedPath = {
      translation: 'transform.translation',
      rotation: 'transform.rotation',
      scale: 'transform.scale',
      weights: 'morph.weights',
    };

    for (let clipIndex = 0; clipIndex < model.animationClips.length; clipIndex++) {
      const source = model.animationClips[clipIndex];
      const converted = clips[clipIndex];
      assert.equal(converted.tracks.length, source.channels.length);
      for (let trackIndex = 0; trackIndex < source.channels.length; trackIndex++) {
        const channel = source.channels[trackIndex];
        const track = converted.tracks[trackIndex];
        assert.equal(track.interpolation, expectedInterpolation[channel.interpolation]);
        assert.equal(track.binding.path, expectedPath[channel.path]);
        assert.equal(track.binding.target.kind, 'node-path');
        assert.ok(track.binding.target.segments.length > 0);
        assert.deepEqual([...track.times], [...channel.input]);
        assert.deepEqual([...track.values], [...channel.output]);
        assert.notEqual(track.times, channel.input);
        assert.notEqual(track.values, channel.output);
        assert.equal('entity' in track.binding.target, false);
      }
    }

    assert.deepEqual(
      clips[0].tracks.map(track => [track.binding.path, track.interpolation]),
      [
        ['transform.translation', 'linear'],
        ['transform.rotation', 'step'],
        ['transform.scale', 'cubic-spline'],
        ['morph.weights', 'linear'],
        ['transform.translation', 'linear'],
      ],
    );
    assert.equal(typeof applyGltfAnimationClip, 'function');
  } finally {
    disposeGltfModel(model);
  }
});

test('Idle to Run cross-fade drives root TRS, skinning joints, and GPU morph together', async () => {
  const model = await loadFixtureModel();
  const runtime = createGltfAnimation3DRuntime(model);
  try {
    assert.equal(runtime.mixer.constructor.name, 'Animation3DMixer');
    assert.equal(runtime.pose.constructor.name, 'Animation3DPoseBuffer');
    const animatedTransform = requireEntity(model.root, 'AnimatedTRS').getComponent(Transform3D);
    assert.ok(animatedTransform);
    const geometry = requireGeometry(model.root, 'SkinnedMorph');
    assert.equal(geometry.morphUseGpu, true);
    assert.equal(geometry.hasMorphTargets, true);
    assert.ok(geometry.skinning);
    const basePositions = Float32Array.from(geometry.positions);

    const idle = runtime.mixer.createAction(runtime.clips[1], {
      id: 'Idle',
      loop: 'once',
      clampWhenFinished: true,
    });
    const run = runtime.mixer.createAction(runtime.clips[0], {
      id: 'Run',
      loop: 'once',
      clampWhenFinished: true,
    });
    idle.play();
    run.crossFadeFrom(idle, 1);

    runtime.update(0);
    assertArrayClose(animatedTransform.localMatrix, [
      0, 1, 0, 0,
      -1, 0, 0, 0,
      0, 0, 1, 0,
      1, 2, 3, 1,
    ]);
    assertArrayClose(geometry.morphWeights, [0.1, 0.2]);
    assertArrayClose(geometry.skinning.jointMatrices, [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);

    runtime.update(0.5);
    assertArrayClose(animatedTransform.localMatrix, [
      0, 1.25, 0, 0,
      -1.5, 0, 0, 0,
      0, 0, 1.75, 0,
      1.5, 2.5, 3.5, 1,
    ]);
    assertArrayClose(geometry.morphWeights, [0.3, 0.35]);
    assertArrayClose(geometry.skinning.jointMatrices.slice(28, 32), [0, 0.5, 0, 1]);

    runtime.update(0.5);
    assertArrayClose(animatedTransform.localMatrix, [
      -2, 0, 0, 0,
      0, -3, 0, 0,
      0, 0, 4, 0,
      3, 4, 5, 1,
    ]);
    assertArrayClose(geometry.morphWeights, [0.75, 0.25]);
    assertArrayClose(geometry.skinning.jointMatrices.slice(28, 32), [0, 2, 0, 1]);

    assertArrayClose(geometry.positions, basePositions);
    assert.ok(geometry.morphVersion >= 2);
    assert.ok(geometry.skinning.version >= 3);
  } finally {
    runtime.destroy();
    disposeGltfModel(model);
  }
});

test('abort releases all model-scoped Animation3D bindings and actions', async () => {
  const model = await loadFixtureModel();
  const controller = new AbortController();
  const runtime = createGltfAnimation3DRuntime(model, { signal: controller.signal });
  runtime.mixer.createAction(runtime.clips[0], { id: 'Run' }).play();
  controller.abort('fixture-replaced');
  assertRuntimeReleased(runtime);
  assert.equal(model.root.destroyed, false);
  disposeGltfModel(model);
});

test('model replacement disposal and scene-root destruction release the Animation3D runtime', async () => {
  const replacedModel = await loadFixtureModel();
  const replacedRuntime = createGltfAnimation3DRuntime(replacedModel);
  replacedRuntime.mixer.createAction(replacedRuntime.clips[0]).play();
  disposeGltfModel(replacedModel);
  assertRuntimeReleased(replacedRuntime);

  const destroyedModel = await loadFixtureModel();
  const destroyedRuntime = createGltfAnimation3DRuntime(destroyedModel);
  destroyedRuntime.mixer.createAction(destroyedRuntime.clips[0]).play();
  destroyedModel.root.destroy();
  assertRuntimeReleased(destroyedRuntime);
});
