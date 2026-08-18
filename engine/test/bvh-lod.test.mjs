import test from 'node:test';
import assert from 'node:assert/strict';
import { BvhLod3D } from '../dist/components.js';
import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Mesh3D,
  World,
} from '../dist/index.js';
import { BvhLodSystem } from '../dist/experimental.js';

function geometry(scale) {
  return new Geometry3D({
    positions: new Float32Array([
      -scale, -scale, 0,
       scale, -scale, 0,
       0, scale, 0,
    ]),
  });
}

function createFixture() {
  const world = new World('BvhLodWorld');
  const cameraTransform = new CartesianTransform3D({ position: [0, 0, 5] });
  const camera = new Entity('Camera')
    .addComponent(new Camera3D({ far: 500 }))
    .addComponent(cameraTransform);
  world.addEntity(camera);

  const original = geometry(1);
  const high = geometry(1.1);
  const medium = geometry(0.8);
  const low = geometry(0.5);
  const originalMaterial = new BasicMaterial({ color: [1, 1, 1, 1] });
  const highMaterial = new BasicMaterial({ color: [0, 1, 0, 1] });
  const entity = new Entity('LOD Mesh')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Mesh3D(original, originalMaterial));
  const lod = new BvhLod3D({
    bounds: { center: [0, 0, 0], radius: 1 },
    hysteresis: 0.1,
    levels: [
      { geometry: high, material: highMaterial, maxDistance: 10 },
      { geometry: medium, maxDistance: 30 },
      { geometry: low, maxDistance: Infinity },
    ],
  });
  entity.addComponent(lod);
  world.addEntity(entity);
  const system = new BvhLodSystem(camera, { leafSize: 1 });
  world.addSystem(system);
  return {
    world,
    cameraTransform,
    entity,
    mesh: entity.getComponent(Mesh3D),
    lod,
    system,
    resources: { original, high, medium, low, originalMaterial, highMaterial },
  };
}

test('BvhLod3D validates ordered levels and applies switch hysteresis', () => {
  const high = geometry(1);
  const low = geometry(0.5);
  assert.throws(() => new BvhLod3D({ levels: [] }), /at least one level/);
  assert.throws(() => new BvhLod3D({ levels: [{ geometry: high, maxDistance: 10 }] }), /final level/);
  assert.throws(() => new BvhLod3D({ levels: [
    { geometry: high, maxDistance: 20 },
    { geometry: low, maxDistance: 10 },
  ] }), /strictly increasing|final level/);

  const lod = new BvhLod3D({
    hysteresis: 0.1,
    levels: [
      { geometry: high, maxDistance: 10 },
      { geometry: low, maxDistance: Infinity },
    ],
  });
  assert.equal(lod.selectLevel(8), 0);
  assert.equal(lod.selectLevel(10.5, 0), 0);
  assert.equal(lod.selectLevel(11.1, 0), 1);
  assert.equal(lod.selectLevel(9.5, 1), 1);
  assert.equal(lod.selectLevel(8.9, 1), 0);
});

test('BvhLod3D applies hysteresis across adjacent boundaries for multi-level jumps', () => {
  const high = geometry(1);
  const medium = geometry(0.75);
  const low = geometry(0.5);
  const lod = new BvhLod3D({
    hysteresis: 0.1,
    levels: [
      { geometry: high, maxDistance: 10 },
      { geometry: medium, maxDistance: 30 },
      { geometry: low, maxDistance: Infinity },
    ],
  });

  assert.equal(lod.selectLevel(15, 2), 1, 'Low must advance to Medium even when High hysteresis is not crossed');
  assert.equal(lod.selectLevel(8, 2), 0, 'a distance beyond both adjacent hysteresis boundaries may advance to High');
  assert.equal(lod.selectLevel(31, 0), 1, 'High must fall to Medium before the Low hysteresis boundary is crossed');
  assert.equal(lod.selectLevel(34, 0), 2, 'a distance beyond both downgrade boundaries may fall to Low');
});

test('BvhLodSystem selects view-local levels without mutating shared Mesh3D resources', () => {
  const fixture = createFixture();
  const { world, cameraTransform, mesh, system, resources } = fixture;

  world.update(0, 0);
  assert.equal(mesh.geometry, resources.original);
  assert.equal(mesh.material, resources.originalMaterial);
  assert.equal(system.getActiveLevel(fixture.entity), 0);
  assert.equal(system.stats.objectCount, 1);
  assert.equal(system.stats.candidateCount, 1);
  assert.equal(system.stats.rebuilt, true);
  assert.equal(system.stats.fullScanCount, 1);
  assert.equal(system.stats.updatedObjectCount, 1);

  cameraTransform.setPosition(0, 0, 20);
  world.update(1, 16);
  assert.equal(system.getActiveLevel(fixture.entity), 1);
  assert.equal(mesh.geometry, resources.original);
  assert.equal(mesh.material, resources.originalMaterial);
  assert.equal(system.stats.rebuilt, false, 'camera motion must not rebuild the object BVH');
  assert.equal(system.stats.updatedObjectCount, 0, 'camera-only motion does not revisit LOD object bounds');

  cameraTransform.setPosition(0, 0, 80);
  world.update(2, 16);
  assert.equal(mesh.geometry, resources.original);
  assert.equal(system.getActiveLevel(fixture.entity), 2);
  assert.equal(system.stats.candidateCount, 0);
});

test('BvhLodSystem incrementally refits object journals and clears selection on disable/destroy', () => {
  const fixture = createFixture();
  const { world, entity, mesh, lod, system, resources } = fixture;
  world.update(0, 0);

  entity.getComponent(CartesianTransform3D).setPosition(4, 0, 0);
  world.update(1, 16);
  assert.equal(system.stats.rebuilt, false);
  assert.equal(system.stats.updatedObjectCount, 1);
  assert.equal(system.stats.fullScanCount, 1, 'object motion consumes the transform journal without a scene scan');
  const refitCount = system.stats.refitCount;
  const rebuildCount = system.stats.rebuildCount;

  lod.setHysteresis(0.2);
  world.update(2, 16);
  assert.equal(system.stats.rebuilt, false);
  assert.equal(system.stats.rebuildCount, rebuildCount);
  assert.ok(system.stats.refitCount > refitCount);
  assert.equal(system.stats.fullScanCount, 1, 'LOD definition changes consume the component journal');

  lod.disabled = true;
  world.update(3, 16);
  assert.equal(mesh.geometry, resources.original);
  assert.equal(mesh.material, resources.originalMaterial);
  assert.equal(system.getActiveLevel(entity), -1);

  lod.disabled = false;
  world.update(4, 16);
  assert.notEqual(system.getActiveLevel(entity), -1);

  system.destroy();
  assert.equal(mesh.geometry, resources.original);
  assert.equal(mesh.material, resources.originalMaterial);
});

test('BVH candidate set remains local as scene object count grows', () => {
  const fixture = createFixture();
  const { world, system, lod, resources } = fixture;
  for (let i = 0; i < 128; i++) {
    const entity = new Entity(`Far LOD ${i}`)
      .addComponent(new CartesianTransform3D({ position: [200 + i * 8, 0, 0] }))
      .addComponent(new Mesh3D(resources.original, resources.originalMaterial))
      .addComponent(lod.clone());
    world.addEntity(entity);
  }
  world.update(0, 0);
  assert.equal(system.stats.objectCount, 129);
  assert.ok(system.stats.nodeCount > 1);
  assert.equal(system.stats.candidateCount, 1);
});

test('LOD selection never owns or restores user Mesh3D resource edits', () => {
  const fixture = createFixture();
  const { world, lod, mesh, resources } = fixture;
  world.update(0, 0);
  const replacementGeometry = geometry(2);
  const replacementMaterial = new BasicMaterial({ color: [0.2, 0.3, 0.4, 1] });
  mesh.geometry = replacementGeometry;
  mesh.material = replacementMaterial;

  world.update(1, 16);
  assert.equal(mesh.geometry, replacementGeometry);
  assert.equal(mesh.material, replacementMaterial);

  lod.disabled = true;
  world.update(2, 16);
  assert.equal(mesh.geometry, replacementGeometry);
  assert.equal(mesh.material, replacementMaterial);
});
