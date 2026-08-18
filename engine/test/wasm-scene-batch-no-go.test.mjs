import test from 'node:test';
import assert from 'node:assert/strict';
import { Entity, Transform3D } from '../dist/experimental.js';
import { SceneBatchCandidate } from '../../scripts/benchmark/m025-scene-batch-candidate.mjs';

const IDENTITY = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function matrix(x, y, z) {
  const result = new Float32Array(IDENTITY);
  result[12] = x;
  result[13] = y;
  result[14] = z;
  return result;
}

function createBatchAccess() {
  const indicesBySphere = new WeakMap();
  return {
    indicesBySphere,
    access: {
      getLocalMatrix: renderable => renderable.entity.getComponent(Transform3D)?.localMatrix ?? renderable.worldMatrix,
      getLocalVersion: renderable => renderable.entity.getComponent(Transform3D)?.localVersion ?? 0,
      bindSphere: (sphere, batchIndex) => indicesBySphere.set(sphere, batchIndex),
    },
  };
}

function renderable(entity, worldMatrix, worldVersion, sphere) {
  return {
    entity,
    entityId: entity.id,
    mesh: null,
    lod: null,
    helper: null,
    outlined: false,
    clippingPlanes: null,
    worldMatrix,
    worldVersion,
    worldSphere: sphere,
  };
}

test('SceneBatch keeps stable identity/topology and only advances numeric revision for dirty values', () => {
  const batch = new SceneBatchCandidate();
  const { access } = createBatchAccess();
  const parent = new Entity('Parent').add(Transform3D);
  const child = new Entity('Child').add(Transform3D);
  parent.add(child);
  const parentMatrix = matrix(0, 0, -2);
  const childMatrix = matrix(0, 0, -4);
  const inside = { center: [0, 0, 0], radius: 0.5 };
  const outside = { center: [4, 0, 0], radius: 0.5 };
  const state = {
    frameId: 1,
    phaseRevision: 1,
    renderables: [
      renderable(child, childMatrix, 1, outside),
      renderable(parent, parentMatrix, 1, inside),
    ],
    totalCount: 2,
  };
  batch.sync(state, access);

  assert.deepEqual(Array.from(batch.entityIds), [child.id, parent.id]);
  assert.deepEqual(Array.from(batch.parentIndices), [1, -1]);
  assert.deepEqual(Array.from(batch._topology.subarray(0, 2)), [1, 0]);
  assert.equal(batch.structuralRevision, 1);
  assert.equal(batch.numericRevision, 1);
  const arrays = [batch._entityIds, batch._worldMatrices, batch._spheres, batch._visibleIndices];

  batch.sync(state, access);
  assert.equal(batch.structuralRevision, 1);
  assert.equal(batch.numericRevision, 1);
  assert.deepEqual([batch._entityIds, batch._worldMatrices, batch._spheres, batch._visibleIndices], arrays);

  child.getComponent(Transform3D).setTranslation(1, 0, 0);
  state.renderables[0].worldMatrix = matrix(1, 0, -4);
  state.renderables[0].worldVersion++;
  batch.sync(state, access);
  assert.equal(batch.structuralRevision, 1);
  assert.equal(batch.numericRevision, 2);
  assert.equal(batch.worldMatrices[12], 1);
});

test('SceneBatch cull/depth output matches the object oracle in stable source order', () => {
  const batch = new SceneBatchCandidate();
  const { access, indicesBySphere } = createBatchAccess();
  const first = new Entity('First').add(Transform3D);
  const second = new Entity('Second').add(Transform3D);
  const state = {
    frameId: 1,
    phaseRevision: 1,
    renderables: [
      renderable(first, matrix(0, 0, -2), 1, { center: [0, 0, 0], radius: 0.5 }),
      renderable(second, matrix(4, 0, -5), 1, { center: [4, 0, 0], radius: 0.5 }),
    ],
    totalCount: 2,
  };
  const planes = new Float32Array([
    1, 0, 0, 1,
    -1, 0, 0, 1,
    0, 1, 0, 1,
    0, -1, 0, 1,
    0, 0, 1, 10,
    0, 0, -1, 10,
  ]);
  batch.sync(state, access);
  batch.prepareView(planes, IDENTITY, true);

  assert.equal(batch.visibleCount, 1);
  assert.deepEqual(Array.from(batch.visibleIndices), [0]);
  assert.deepEqual(Array.from(batch.visibleIndices, index => batch.entityIds[index]), [first.id]);
  assert.deepEqual(Array.from(batch.depth), [2, 5]);
  assert.equal(batch.isVisible(0), true);
  assert.equal(batch.isVisible(1), false);
  assert.equal(indicesBySphere.get(state.renderables[0].worldSphere), 0);
});

test('no production WASM runtime, glue, or public export remains after the admission no-go', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  await assert.rejects(stat(new URL('../src/wasm/Render3DSceneBatch.ts', import.meta.url)), { code: 'ENOENT' });
  await assert.rejects(stat(new URL('../src/wasm/Render3DSceneBatchController.ts', import.meta.url)), { code: 'ENOENT' });
  await stat(new URL('../../scripts/benchmark/m025-scene-batch-candidate.mjs', import.meta.url));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(packageJson.exports).some(key => key.includes('wasm')), false);
  assert.equal(packageJson.dependencies['@haiyue/wasm'], undefined);
});
