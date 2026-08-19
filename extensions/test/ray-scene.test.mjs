import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh3D, Transform3D } from '@haiyue/engine/components';
import { Entity, World } from '@haiyue/engine/ecs';
import { Geometry3D } from '@haiyue/engine/geometry';
import { BasicMaterial } from '@haiyue/engine/material';
import { traceRayBruteForce } from '../src/ray-tracing/reference/index.ts';
import {
  extractRayTracingScene,
  hasRaySceneSourceRevisionChanged,
} from '../src/ray-tracing/scene/index.ts';

function createTriangle({ indexed = false, empty = false, degenerate = false } = {}) {
  const positions = empty
    ? new Float32Array()
    : degenerate
      ? new Float32Array([0, 0, 0, 1, 1, 0, 2, 2, 0])
      : new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return new Geometry3D({
    positions,
    normals: empty ? undefined : new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: indexed && !empty ? new Uint16Array([0, 1, 2]) : undefined,
  });
}

function addMesh(world, {
  geometry = createTriangle(),
  material = new BasicMaterial(),
  name = 'mesh',
  transform = null,
  parent = null,
} = {}) {
  const entity = new Entity(name);
  const transformComponent = new Transform3D();
  if (transform) transformComponent.setMatrix(Float32Array.from(transform));
  entity.add(transformComponent);
  entity.add(new Mesh3D(geometry, material));
  if (parent) parent.addChild(entity);
  else world.addEntity(entity);
  return { entity, transform: transformComponent, mesh: entity.getComponent(Mesh3D), geometry, material };
}

test('extracts indexed and non-indexed Engine geometry into an immutable canonical snapshot', () => {
  const world = new World('ray-scene');
  const first = addMesh(world, { geometry: createTriangle({ indexed: true }), name: 'indexed' });
  const second = addMesh(world, {
    geometry: createTriangle(),
    name: 'non-indexed',
    transform: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      2, 0, 0, 1,
    ],
  });
  const result = extractRayTracingScene(world);
  assert.equal(result.valid, true);
  assert.equal(result.snapshot.geometries.length, 2);
  assert.equal(result.snapshot.instances.length, 2);
  assert.ok(Object.isFrozen(result.snapshot));
  assert.ok(Object.isFrozen(result.snapshot.geometries[0].positions));
  assert.ok(Object.isFrozen(result.snapshot.instances[0].transform));
  assert.match(result.snapshot.fingerprint, /^fnv1a64:[0-9a-f]{16}$/);
  assert.equal(result.snapshot.provenance.find(item => item.entityId === `entity:${first.entity.id}`)?.material.materialId,
    `material:${first.material.id}`);

  const hit = traceRayBruteForce(result.snapshot, {
    origin: [2.25, 0.25, 1], direction: [0, 0, -1],
  });
  assert.equal(hit.hit?.entityId, undefined);
  assert.equal(hit.hit?.identity.entityId, `entity:${second.entity.id}`);
  assert.equal(hit.hit?.t, 1);
});

test('computes hierarchy world matrices without mutating Transform3D world state', () => {
  const world = new World('hierarchy');
  const parent = new Entity('parent');
  const parentTransform = new Transform3D().setTranslation(10, 0, 0);
  parent.add(parentTransform);
  world.addEntity(parent);
  const child = addMesh(world, {
    parent,
    transform: [
      -2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ],
  });
  const parentWorldBefore = [...parentTransform.worldMatrix];
  const childWorldBefore = [...child.transform.worldMatrix];
  const parentDirtyBefore = parentTransform.worldMatrixDirty;
  const childDirtyBefore = child.transform.worldMatrixDirty;

  const result = extractRayTracingScene(world);
  assert.deepEqual([...parentTransform.worldMatrix], parentWorldBefore);
  assert.deepEqual([...child.transform.worldMatrix], childWorldBefore);
  assert.equal(parentTransform.worldMatrixDirty, parentDirtyBefore);
  assert.equal(child.transform.worldMatrixDirty, childDirtyBefore);
  assert.deepEqual(result.snapshot.instances[0].transform.slice(12, 15), [10, 0, 0]);

  const hit = traceRayBruteForce(result.snapshot, {
    origin: [9.5, 0.75, 1], direction: [0, 0, -1],
  });
  assert.equal(hit.hit?.identity.entityId, `entity:${child.entity.id}`);
  assert.equal(hit.hit?.frontFace, false);
});

test('snapshot is value-owned and fingerprint invalidates geometry, transform, and material mutations', () => {
  const world = new World('revision');
  const source = addMesh(world);
  const initial = extractRayTracingScene(world).snapshot;
  const initialPositions = [...initial.geometries[0].positions];
  const initialTransform = [...initial.instances[0].transform];
  assert.equal(hasRaySceneSourceRevisionChanged(initial, world), false);

  source.geometry.positions[0] = 4;
  source.geometry.markDirty();
  const geometryChanged = extractRayTracingScene(world).snapshot;
  assert.notEqual(geometryChanged.fingerprint, initial.fingerprint);
  assert.deepEqual(initial.geometries[0].positions, initialPositions);

  source.transform.setTranslation(3, 4, 5);
  const transformChanged = extractRayTracingScene(world).snapshot;
  assert.notEqual(transformChanged.fingerprint, geometryChanged.fingerprint);
  assert.deepEqual(initial.instances[0].transform, initialTransform);

  source.material.markDirty();
  const materialChanged = extractRayTracingScene(world).snapshot;
  assert.notEqual(materialChanged.fingerprint, transformChanged.fingerprint);
  assert.equal(materialChanged.provenance[0].material.revision, 1);
});

test('removal and source destruction cannot mutate or repopulate an existing snapshot', () => {
  const world = new World('lifecycle');
  const source = addMesh(world);
  const beforeRemoval = extractRayTracingScene(world).snapshot;
  world.removeEntity(source.entity);
  assert.equal(hasRaySceneSourceRevisionChanged(beforeRemoval, world), true);
  const afterRemoval = extractRayTracingScene(world).snapshot;
  assert.equal(afterRemoval.instances.length, 0);
  assert.notEqual(afterRemoval.fingerprint, beforeRemoval.fingerprint);
  assert.equal(beforeRemoval.instances.length, 1);

  source.entity.destroy();
  world.destroy();
  assert.equal(beforeRemoval.instances.length, 1);
  assert.equal(beforeRemoval.geometries[0].positions[0], 0);
  const destroyed = extractRayTracingScene(world);
  assert.equal(destroyed.valid, false);
  assert.ok(destroyed.diagnostics.some(entry => entry.code === 'RAY_SCENE_SOURCE_DESTROYED'));
});

test('empty, degenerate, invalid, disabled, and removed facts have explicit deterministic outcomes', () => {
  const world = new World('invalid');
  const empty = addMesh(world, { geometry: createTriangle({ empty: true }), name: 'empty' });
  const degenerate = addMesh(world, { geometry: createTriangle({ degenerate: true }), name: 'degenerate' });
  const invalid = addMesh(world, { geometry: createTriangle({ indexed: true }), name: 'invalid-index' });
  invalid.geometry.indices = new Uint16Array([0, 1, 99]);
  const disabled = addMesh(world, { name: 'disabled' });
  disabled.entity.disabled = true;

  const result = extractRayTracingScene(world);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some(entry => entry.code === 'RAY_SCENE_GEOMETRY_EMPTY'));
  assert.ok(result.diagnostics.some(entry => entry.code === 'RAY_SCENE_TRIANGLE_DEGENERATE'));
  assert.ok(result.diagnostics.some(entry => entry.code === 'RAY_SCENE_INDICES_INVALID'));
  assert.ok(result.snapshot.instances.some(entry => entry.entityId === `entity:${empty.entity.id}`));
  assert.ok(result.snapshot.instances.some(entry => entry.entityId === `entity:${degenerate.entity.id}`));
  assert.ok(!result.snapshot.instances.some(entry => entry.entityId === `entity:${invalid.entity.id}`));
  assert.ok(!result.snapshot.instances.some(entry => entry.entityId === `entity:${disabled.entity.id}`));

  const repeat = extractRayTracingScene(world);
  assert.equal(repeat.snapshot.fingerprint, result.snapshot.fingerprint);
  assert.deepEqual(repeat.diagnostics.map(entry => entry.code), result.diagnostics.map(entry => entry.code));
});

test('scene ordering is canonical and does not depend on insertion order', () => {
  const sharedGeometry = createTriangle({ indexed: true });
  const sharedMaterial = new BasicMaterial();
  const firstWorld = new World('first');
  const a = addMesh(firstWorld, { geometry: sharedGeometry, material: sharedMaterial, name: 'a' });
  const b = addMesh(firstWorld, { geometry: sharedGeometry, material: sharedMaterial, name: 'b' });
  const snapshot = extractRayTracingScene(firstWorld).snapshot;
  const ids = snapshot.instances.map(entry => entry.instanceId);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(snapshot.geometries.length, 1);
  assert.notEqual(a.entity.id, b.entity.id);
});
