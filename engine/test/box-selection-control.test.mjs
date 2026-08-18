import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BasicMaterial,
  BoxSelectionControl,
  Camera3D,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  Mesh3D,
  World,
} from '../dist/experimental.js';
import { getSpatialIndexService } from '../dist/experimental.js';

function createControl(t, bounds = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) {
  const previousDocument = globalThis.document;
  const overlay = {
    className: '',
    style: {},
    remove() {},
  };
  globalThis.document = {
    body: { appendChild() {} },
    createElement() { return overlay; },
  };

  const listeners = new Map();
  const canvas = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    setPointerCapture() {},
    getBoundingClientRect() { return bounds; },
  };
  const world = new World('BoxSelectionWorld');
  const cameraEntity = new Entity('Camera');
  cameraEntity.addComponent(new Camera3D());
  cameraEntity.addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(cameraEntity);
  const control = new BoxSelectionControl(canvas, world, cameraEntity);

  t.after(() => {
    control.dispose();
    globalThis.document = previousDocument;
  });
  return { control, world };
}

test('BoxSelectionControl invalidates bounds by geometry version without retaining geometry ids', t => {
  const { control } = createControl(t);
  const geometry = new Geometry3D({
    positions: new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
    ]),
  });

  const first = control._getLocalSphere(geometry);
  geometry.positions.set([
    10, 0, 0,
    12, 0, 0,
    10, 2, 0,
  ]);
  geometry.markDirty();
  const second = control._getLocalSphere(geometry);

  assert.equal(control._sphereCache instanceof WeakMap, true);
  assert.notEqual(first, second);
  assert.ok(second.center[0] > 10);
});

test('BoxSelectionControl propagates parent world versions to child transforms', t => {
  const { control, world } = createControl(t);
  const parent = new Entity('Parent');
  const parentTransform = new CartesianTransform3D({ position: [1, 0, 0] });
  parent.addComponent(parentTransform);
  const child = new Entity('Child');
  const childTransform = new CartesianTransform3D({ position: [2, 0, 0] });
  child.addComponent(childTransform);
  parent.addChild(child);
  world.addEntity(parent);

  control._updateWorldMatrix(child);
  assert.equal(childTransform.worldMatrix[12], 3);

  parentTransform.setPosition(5, 0, 0);
  control._updateWorldMatrix(child);
  assert.equal(childTransform.worldMatrix[12], 7);
});

test('BoxSelectionControl rejects a zero-sized canvas before building projection data', t => {
  const { control } = createControl(t, {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  });

  assert.equal(control._buildSelectionFrustum({ x: 0, y: 0, width: 10, height: 10 }), null);
});

test('BoxSelectionControl uses the shared Mesh3D spatial index as its broad phase', t => {
  const { control, world } = createControl(t);
  const geometry = new Geometry3D({
    positions: new Float32Array([
      -0.5, -0.5, 0,
       0.5, -0.5, 0,
       0.0,  0.5, 0,
    ]),
  });
  const selected = new Entity('Selected')
    .addComponent(new CartesianTransform3D())
    .addComponent(new Mesh3D(geometry, new BasicMaterial()));
  const outside = new Entity('Outside')
    .addComponent(new CartesianTransform3D({ position: [100, 0, 0] }))
    .addComponent(new Mesh3D(geometry, new BasicMaterial()));
  world.addEntity(selected).addEntity(outside);
  world.update(0, 0);

  const service = getSpatialIndexService(world);
  const result = control.selectRect(
    { x: 0, y: 0, width: 100, height: 100 },
    { type: 'pointerup' },
  );

  assert.deepEqual(result?.entities, [selected]);
  assert.equal(service.meshIndex.entryCount, 2, 'the shared index owns all mesh bounds, not selection policy');
  assert.equal(service.meshSyncCount, 1);
  assert.equal(control._spatialCandidates.length, 0, 'caller-owned query scratch is reusable');
});
