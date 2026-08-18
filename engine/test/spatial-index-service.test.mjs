import assert from 'node:assert/strict';
import test from 'node:test';
import { BvhLod3D, Transform3D } from '../dist/components.js';
import { RenderView } from '../dist/core.js';
import { Frustum } from '../dist/math.js';
import { Render3DSystem } from '../dist/systems.js';
import {
  BasicMaterial,
  Camera3D,
  CartesianTransform3D,
  Component,
  DirectionalLight,
  Entity,
  Geometry3D,
  Mesh3D,
  World,
} from '../dist/index.js';
import { SpatialIndex, getSpatialIndexService } from '../dist/experimental.js';
import { MaterialRendererRegistry } from '../dist/material.js';

function triangleGeometry(offset = 0) {
  return new Geometry3D({
    positions: new Float32Array([
      -0.5 + offset, -0.5, 0,
       0.5 + offset, -0.5, 0,
       0.0 + offset,  0.5, 0,
    ]),
  });
}

function unitFrustum() {
  return new Frustum().setFromPlanes(new Float32Array([
     1,  0,  0, 1,
    -1,  0,  0, 1,
     0,  1,  0, 1,
     0, -1,  0, 1,
     0,  0,  1, 1,
     0,  0, -1, 1,
  ]));
}

test('SpatialIndex supports transactional sweep and point/ray/frustum queries', () => {
  const index = new SpatialIndex(1);
  const near = { name: 'near' };
  const far = { name: 'far' };
  index.beginUpdate()
    .upsert('near', near, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5)
    .upsert('far', far, 5, 5, 5, 6, 6, 6);
  assert.equal(index.endUpdate(), true);
  assert.equal(index.entryCount, 2);
  assert.ok(index.nodeCount > 1);

  const points = new Set();
  index.queryPoint(0, 0, 0, points);
  assert.deepEqual([...points], [near]);

  const ray = [];
  index.queryRay(new Float32Array([0, 0, 2]), new Float32Array([0, 0, -1]), Infinity, ray);
  assert.deepEqual(ray, [near]);

  const visible = [];
  index.queryFrustum(unitFrustum(), visible);
  assert.deepEqual(visible, [near]);

  const rebuildCount = index.rebuildCount;
  index.beginUpdate()
    .upsert('near', near, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5);
  assert.equal(index.endUpdate(), true, 'omitting far sweeps it and rebuilds the tree');
  assert.equal(index.entryCount, 1);
  assert.equal(index.rebuildCount, rebuildCount + 1);

  index.beginUpdate()
    .upsert('near', near, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5);
  assert.equal(index.endUpdate(), false, 'an unchanged transaction does not rebuild');
  assert.equal(index.rebuildCount, rebuildCount + 1);
});

test('SpatialIndex rejects invalid transactions and bounds', () => {
  const index = new SpatialIndex();
  assert.throws(() => index.upsert(1, 'value', 0, 0, 0, 1, 1, 1), /active update transaction/);
  index.beginUpdate();
  assert.throws(() => index.beginUpdate(), /cannot be nested/);
  assert.throws(() => index.upsert(1, 'value', 2, 0, 0, 1, 1, 1), /bounds must be finite/);
  assert.throws(() => index.queryPoint(0, 0, 0, new Set()), /before endUpdate/);
  index.cancelUpdate();
  assert.doesNotThrow(() => index.queryPoint(0, 0, 0, new Set()));
});

test('World component change journal is cursor-based and non-destructive for multiple consumers', () => {
  const world = new World('ComponentJournalWorld');
  const entity = new Entity('Mesh').addComponent(new Transform3D());
  world.addEntity(entity);
  const cursor = world.componentChangeRevision;
  const mesh = new Mesh3D(triangleGeometry(), new BasicMaterial());
  entity.addComponent(mesh);
  mesh.material = new BasicMaterial();
  entity.removeComponent(mesh);

  const firstConsumer = [];
  const secondConsumer = [];
  assert.equal(world.readComponentChangesSince(cursor, firstConsumer), true);
  assert.equal(world.readComponentChangesSince(cursor, secondConsumer), true);
  assert.deepEqual(firstConsumer.map(change => change.kind), ['add', 'update', 'remove']);
  assert.deepEqual(secondConsumer, firstConsumer);
});

test('typed World journals isolate unrelated churn and coalesce unread updates', () => {
  class NoiseComponent extends Component {}
  const world = new World('TypedComponentJournalWorld');
  const noise = new NoiseComponent();
  const entity = new Entity('Noise').addComponent(noise);
  world.addEntity(entity);
  const globalCursor = world.componentChangeRevision;
  const meshJournal = world.createComponentChangeJournal([Mesh3D]);
  const noiseJournal = world.createComponentChangeJournal([NoiseComponent]);

  for (let i = 0; i < 9_000; i++) noise.disabled = !noise.disabled;

  const globalChanges = [];
  const meshChanges = [];
  const noiseChanges = [];
  assert.equal(world.readComponentChangesSince(globalCursor, globalChanges), false);
  assert.equal(world.consumeComponentChanges(meshJournal, meshChanges), true);
  assert.equal(meshChanges.length, 0);
  assert.equal(world.consumeComponentChanges(noiseJournal, noiseChanges), true);
  assert.equal(noiseChanges.length, 1);
  assert.equal(noiseChanges[0].kind, 'update');
});

test('SpatialIndex ignores unrelated component journal overflow', () => {
  class NoiseComponent extends Component {}
  const world = new World('SpatialTypedJournalWorld');
  const meshEntity = new Entity('Mesh')
    .addComponent(new Transform3D())
    .addComponent(new Mesh3D(triangleGeometry(), new BasicMaterial()));
  const noise = new NoiseComponent();
  world.addEntity(meshEntity);
  world.addEntity(new Entity('Noise').addComponent(noise));
  world.frameData.begin(world, null, 0, 0);
  const service = getSpatialIndexService(world);
  service.syncMeshIndex();
  const syncCount = service.meshSyncCount;
  const fullScanCount = service.meshFullScanCount;

  for (let i = 0; i < 9_000; i++) noise.disabled = !noise.disabled;
  service.syncMeshIndex();

  assert.equal(service.meshSyncCount, syncCount);
  assert.equal(service.meshFullScanCount, fullScanCount);
});

test('SpatialIndex refits sparse leaves and rebuilds high-churn updates', () => {
  const index = new SpatialIndex(1);
  index.beginUpdate();
  for (let item = 0; item < 16; item++) {
    index.upsert(item, item, item, 0, 0, item + 0.5, 0.5, 0.5);
  }
  index.endUpdate();
  const rebuildCount = index.rebuildCount;
  const refitCount = index.refitCount;

  index.beginIncrementalUpdate();
  index.upsertIncremental(3, 3, 3.1, 0, 0, 3.6, 0.5, 0.5);
  assert.equal(index.endIncrementalUpdate(), true);
  assert.equal(index.rebuildCount, rebuildCount, 'one changed leaf preserves the existing topology');
  assert.equal(index.refitCount, refitCount + 1);
  const moved = new Set();
  index.queryPoint(3.55, 0.25, 0.25, moved);
  assert.deepEqual([...moved], [3]);

  index.beginIncrementalUpdate();
  for (let item = 0; item < 4; item++) {
    index.upsertIncremental(item, item, item + 0.2, 0, 0, item + 0.7, 0.5, 0.5);
  }
  index.endIncrementalUpdate();
  assert.equal(index.rebuildCount, rebuildCount + 1, 'the 25% churn threshold rebuilds the tree');

  index.beginIncrementalUpdate();
  index.upsertIncremental(15, 15, 1_000, 0, 0, 1_000.5, 0.5, 0.5);
  index.endIncrementalUpdate();
  assert.equal(index.rebuildCount, rebuildCount + 2, 'tree-cost degradation triggers a topology rebuild');
});

test('SpatialIndex inserts, removes, and locally rotates sparse leaves without rebuilding', () => {
  const index = new SpatialIndex(1);
  index.beginUpdate();
  for (let item = 0; item < 64; item++) {
    index.upsert(item, item, item, 0, 0, item + 0.1, 0.1, 0.1);
  }
  index.endUpdate();
  const rebuildCount = index.rebuildCount;

  index.beginIncrementalUpdate();
  index.upsertIncremental(64, 64, 64, 0, 0, 64.1, 0.1, 0.1);
  index.endIncrementalUpdate(1, 100);
  assert.equal(index.rebuildCount, rebuildCount);
  assert.equal(index.insertionCount, 1);
  const inserted = new Set();
  index.queryPoint(64.05, 0.05, 0.05, inserted);
  assert.deepEqual([...inserted], [64]);

  index.beginIncrementalUpdate();
  assert.equal(index.removeIncremental(7), true);
  index.endIncrementalUpdate(1, 100);
  assert.equal(index.rebuildCount, rebuildCount);
  assert.equal(index.removalCount, 1);
  const removed = new Set();
  index.queryPoint(7.05, 0.05, 0.05, removed);
  assert.equal(removed.size, 0);

  for (let step = 0; step < 128; step++) {
    const item = step % 64;
    if (item === 7) continue;
    const position = (item * 37 + step * 53) % 64;
    index.beginIncrementalUpdate();
    index.upsertIncremental(item, item, position, 0, 0, position + 0.1, 0.1, 0.1);
    index.endIncrementalUpdate(1, 100);
  }
  assert.equal(index.rebuildCount, rebuildCount);
  assert.ok(index.rotationCount > 0, 'sparse adversarial motion repairs local SAH topology with rotations');
});

test('SpatialIndexService shares Mesh3D state and invalidates transforms, geometry, and removals', () => {
  const world = new World('SpatialWorld');
  const material = new BasicMaterial();
  const geometry = triangleGeometry();
  const transform = new CartesianTransform3D({ position: [0, 0, 0] });
  const entity = new Entity('Mesh')
    .addComponent(transform)
    .addComponent(new Mesh3D(geometry, material));
  world.addEntity(entity);
  world.update(0, 0);

  const service = getSpatialIndexService(world);
  assert.equal(service, getSpatialIndexService(world));
  const index = service.syncMeshIndex(1);
  assert.equal(index, service.meshIndex);
  assert.equal(index.entryCount, 1);
  const firstRebuild = index.rebuildCount;
  service.syncMeshIndex(1);
  assert.equal(index.rebuildCount, firstRebuild, 'unchanged mesh snapshots reuse the BVH');
  assert.equal(service.meshSyncCount, 1, 'consumers in one FrameData snapshot share one mesh scan');
  service.syncMeshIndex(16);
  assert.equal(service.meshLeafSize, 1, 'a later consumer cannot loosen another consumer\'s shared index');
  assert.equal(index.rebuildCount, firstRebuild);

  const mesh = entity.getComponent(Mesh3D);
  entity.removeComponent(Mesh3D);
  service.syncMeshIndex(1);
  assert.equal(index.entryCount, 0, 'component removal invalidates an already-synced frame');
  entity.addComponent(mesh);
  service.syncMeshIndex(1);
  assert.equal(index.entryCount, 1, 'component addition invalidates an already-synced frame');

  transform.setPosition(10, 0, 0);
  world.update(1, 16);
  service.syncMeshIndex(1);
  const oldPosition = new Set();
  const newPosition = new Set();
  index.queryPoint(0, 0, 0, oldPosition);
  index.queryPoint(10, 0, 0, newPosition);
  assert.equal(oldPosition.size, 0);
  assert.equal(newPosition.size, 1);

  geometry.positions.set([
    4.5, -0.5, 0,
    5.5, -0.5, 0,
    5.0,  0.5, 0,
  ]);
  geometry.markDirty();
  world.update(2, 16);
  service.syncMeshIndex(1);
  const geometryShift = new Set();
  index.queryPoint(15, 0, 0, geometryShift);
  assert.equal(geometryShift.size, 1, 'geometry version changes refresh local and world bounds');

  world.removeEntity(entity);
  service.syncMeshIndex(1);
  assert.equal(index.entryCount, 0);
});

test('SpatialIndexService owns custom indexes and is released by World clear/destroy', () => {
  const world = new World('SpatialLifecycle');
  const service = getSpatialIndexService(world);
  const owner = {};
  const custom = service.acquireIndex(owner, 2);
  assert.equal(custom, service.acquireIndex(owner, 2));
  assert.equal(service.releaseIndex(owner), true);
  assert.equal(service.releaseIndex(owner), false);

  world.clearEntities();
  assert.equal(service.destroyed, true);
  const replacement = getSpatialIndexService(world);
  assert.notEqual(replacement, service);

  world.destroy();
  assert.equal(replacement.destroyed, true);
  assert.throws(() => replacement.syncMeshIndex(), /destroyed/);
  assert.throws(() => getSpatialIndexService(world), /destroyed World/);
});

test('SpatialIndexService incrementally syncs static, 1%, 10%, and 100% dynamic meshes', () => {
  const world = new World('SpatialIncrementalRatios');
  const material = new BasicMaterial();
  const geometry = triangleGeometry();
  const transforms = [];
  for (let item = 0; item < 100; item++) {
    const transform = new Transform3D().setTranslation(item * 2, 0, 0);
    transforms.push(transform);
    world.addEntity(new Entity(`Mesh:${item}`).addComponent(transform).addComponent(new Mesh3D(geometry, material)));
  }
  world.update(0, 0);
  const service = getSpatialIndexService(world);
  const index = service.syncMeshIndex(8);
  assert.equal(service.meshFullScanCount, 1);
  assert.equal(service.lastMeshUpdatedEntryCount, 100);
  const initialRebuilds = index.rebuildCount;

  const added = new Entity('Incremental add')
    .addComponent(new Transform3D().setTranslation(400, 0, 0))
    .addComponent(new Mesh3D(geometry, material));
  world.addEntity(added);
  service.syncMeshIndex(8);
  assert.equal(index.entryCount, 101);
  assert.equal(index.rebuildCount, initialRebuilds, 'one component addition inserts a dynamic leaf');
  world.removeEntity(added);
  service.syncMeshIndex(8);
  assert.equal(index.entryCount, 100);
  assert.equal(index.rebuildCount, initialRebuilds, 'one component removal repairs only its leaf ancestry');
  const stableSyncs = service.meshSyncCount;

  world.update(1, 16);
  service.syncMeshIndex(8);
  assert.equal(service.lastMeshUpdatedEntryCount, 0, 'static frames do not revisit mesh bounds');
  assert.equal(index.rebuildCount, initialRebuilds);
  assert.equal(service.meshSyncCount, stableSyncs, 'static frames reuse the prior index without an update transaction');

  transforms[0].setTranslation(0.25, 0, 0);
  world.update(2, 16);
  service.syncMeshIndex(8);
  assert.equal(service.lastMeshUpdatedEntryCount, 1);
  assert.equal(index.rebuildCount, initialRebuilds);

  for (let item = 0; item < 10; item++) transforms[item].setTranslation(item * 2 + 0.5, 0, 0);
  world.update(3, 16);
  service.syncMeshIndex(8);
  assert.equal(service.lastMeshUpdatedEntryCount, 10);
  assert.equal(index.rebuildCount, initialRebuilds);

  for (let item = 0; item < 100; item++) transforms[item].setTranslation(item * 2 + 0.75, 0, 0);
  world.update(4, 16);
  service.syncMeshIndex(8);
  assert.equal(service.lastMeshUpdatedEntryCount, 100);
  assert.equal(index.rebuildCount, initialRebuilds + 1, '100% dynamic bounds cross the rebuild threshold');
  assert.equal(service.meshFullScanCount, 1, 'dynamic rebuilds never require a World mesh scan');
});

test('SpatialIndexService uses journal-driven conservative LOD bounds', () => {
  const world = new World('SpatialLodBounds');
  const material = new BasicMaterial();
  const base = triangleGeometry();
  const lod = new BvhLod3D({
    bounds: { center: [10, 0, 0], radius: 1 },
    levels: [
      { geometry: triangleGeometry(), maxDistance: 10 },
      { geometry: triangleGeometry(), maxDistance: Infinity },
    ],
  });
  const entity = new Entity('LOD mesh')
    .addComponent(new Transform3D())
    .addComponent(new Mesh3D(base, material))
    .addComponent(lod);
  world.addEntity(entity);
  world.update(0, 0);
  const service = getSpatialIndexService(world);
  const index = service.syncMeshIndex(1);
  const rebuildCount = index.rebuildCount;
  const atLodBounds = new Set();
  index.queryPoint(10, 0, 0, atLodBounds);
  assert.equal(atLodBounds.size, 1);

  lod.setBounds({ center: [20, 0, 0], radius: 1 });
  service.syncMeshIndex(1);
  const movedBounds = new Set();
  index.queryPoint(20, 0, 0, movedBounds);
  assert.equal(movedBounds.size, 1);
  assert.equal(index.rebuildCount, rebuildCount, 'LOD definition changes refit one shared-index leaf');

  lod.disabled = true;
  service.syncMeshIndex(1);
  const baseBounds = new Set();
  index.queryPoint(0, 0, 0, baseBounds);
  assert.equal(baseBounds.size, 1, 'disabled LOD falls back to Mesh3D geometry bounds');
});

test('Render3D large-scene extraction unions camera and directional-shadow frustum queries', () => {
  const world = new World('SpatialRenderExtraction');
  const material = new BasicMaterial();
  const geometry = triangleGeometry();
  const meshEntities = new Set();
  for (let item = 0; item < 600; item++) {
    const x = item < 500 ? (item % 20) * 0.1 - 1 : item < 550 ? 40 : 1_000;
    const entity = new Entity(`Mesh:${item}`)
      .addComponent(new Transform3D().setTranslation(x, 0, 0))
      .addComponent(new Mesh3D(geometry, material));
    meshEntities.add(entity);
    world.addEntity(entity);
  }
  const camera = new Entity('Camera')
    .addComponent(new Transform3D().setTranslation(0, 0, 5))
    .addComponent(new Camera3D({ near: 0.1, far: 100 }));
  world.addEntity(camera);
  world.frameData.begin(world, null, 0, 0);
  const target = {
    width: 640,
    height: 360,
    getRenderPassDescriptor() { return { colorAttachments: [] }; },
    getOutputView() { return {}; },
  };
  const view = new RenderView({ camera, target }).snapshot();
  const render3d = new Render3DSystem({ device: { features: new Set() }, width: 640, height: 360 }, camera, {
    renderProfile: 'batched',
    spatialCullingThreshold: 512,
    materialRenderers: new MaterialRendererRegistry(),
    registerDefaultMaterialRenderers: false,
  });
  const candidates = render3d._resolveExtractionEntities(
    world,
    world.frameData,
    [view, view, view, view],
    meshEntities,
    [
      new DirectionalLight({ direction: [0, -1, 0], shadow: { extent: 60, far: 120 } }),
      new DirectionalLight({ direction: [1, -1, 0], shadow: { extent: 60, far: 120 } }),
    ],
  );
  assert.equal(render3d.lastSpatialIndexUsed, true);
  assert.equal(render3d.lastSpatialQueryCount, 6);
  assert.equal(render3d.lastSpatialShadowQueryCount, 2);
  assert.ok(candidates.size >= 550 && candidates.size < 600);
  assert.equal(getSpatialIndexService(world).meshSyncCount, 1, 'camera and shadow views reuse one synchronized index');
});
