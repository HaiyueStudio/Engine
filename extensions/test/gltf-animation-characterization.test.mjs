import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Mesh3D } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import {
  applyGltfAnimationClip,
  loadGltfModel,
} from '../dist/gltf.js';

const FIXTURE_URL = new URL('./fixtures/gltf/animation-characterization.gltf', import.meta.url);
const EXPECTED_POSES_URL = new URL(
  './fixtures/gltf/animation-characterization.expected-poses.json',
  import.meta.url,
);

async function loadFixtureModel() {
  const source = await readFile(FIXTURE_URL, 'utf8');
  return loadGltfModel(`data:model/gltf+json,${encodeURIComponent(source)}`);
}

async function readExpectedPoses() {
  return JSON.parse(await readFile(EXPECTED_POSES_URL, 'utf8'));
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

test('checked-in glTF animation corpus retains sampler features and duplicate clip identity', async () => {
  const [model, expected] = await Promise.all([
    loadFixtureModel(),
    readExpectedPoses(),
  ]);
  try {
    assert.equal(model.assetStats.animationCount, 2);
    assert.deepEqual(model.animations.map(clip => clip.name), ['Take', 'Take']);
    assert.deepEqual(model.animationClips.map(clip => clip.name), ['Take', 'Take']);
    assert.notEqual(model.animationClips[0], model.animationClips[1]);

    for (const clipExpectation of expected.clips) {
      const clip = model.animationClips[clipExpectation.index];
      assert.ok(clip);
      assert.equal(clip.name, clipExpectation.name);
      assert.deepEqual(
        clip.channels.map(channel => [channel.path, channel.interpolation]),
        clipExpectation.channels,
      );
    }

    const partialClip = model.animationClips[1];
    assert.ok(partialClip);
    const presentPaths = new Set(partialClip.channels.map(channel => channel.path));
    for (const missingPath of expected.clips[1].missingChannels) {
      assert.equal(presentPaths.has(missingPath), false);
    }
  } finally {
    model.root.destroy();
  }
});

test('glTF animation corpus reaches the expected TRS, skin, and morph pose', async () => {
  const [model, expected] = await Promise.all([
    loadFixtureModel(),
    readExpectedPoses(),
  ]);
  try {
    const expectation = expected.clips[0];
    const clip = model.animationClips[expectation.index];
    assert.ok(clip);
    applyGltfAnimationClip(clip, expectation.time);

    const transform = requireEntity(model.root, expectation.pose.node).getComponent(Transform3D);
    assert.ok(transform);
    assertArrayClose(transform.localMatrix, expectation.pose.localMatrix);

    const geometry = requireGeometry(model.root, expectation.pose.morphNode);
    assertArrayClose(geometry.morphWeights, expectation.pose.morphWeights);
    assert.ok(geometry.skinning);
    assertArrayClose(geometry.skinning.jointMatrices, expectation.pose.skinJointMatrices);
  } finally {
    model.root.destroy();
  }
});

test('glTF clip with missing channels preserves the fixture base pose', async () => {
  const [model, expected] = await Promise.all([
    loadFixtureModel(),
    readExpectedPoses(),
  ]);
  try {
    const expectation = expected.clips[1];
    const clip = model.animationClips[expectation.index];
    assert.ok(clip);
    applyGltfAnimationClip(clip, expectation.time);

    const transform = requireEntity(model.root, expectation.pose.node).getComponent(Transform3D);
    assert.ok(transform);
    assertArrayClose(transform.localMatrix, expectation.pose.localMatrix);

    const geometry = requireGeometry(model.root, expectation.pose.morphNode);
    assertArrayClose(geometry.morphWeights, expectation.pose.morphWeights);
  } finally {
    model.root.destroy();
  }
});
