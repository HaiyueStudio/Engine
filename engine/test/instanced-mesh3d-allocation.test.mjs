import test from 'node:test';
import assert from 'node:assert/strict';
import { InstancedMesh3D } from '../dist/components.js';
import { InstancedMaterial } from '../dist/material.js';
import { InstancedMesh3DRenderSystem } from '../dist/systems.js';
import {
  Camera3D,
  CartesianTransform3D,
  Entity,
  Geometry3D,
  World,
} from '../dist/index.js';
import { createMockEngine } from './helpers.mjs';

function createFixture() {
  const engine = createMockEngine();
  const world = new World('Instanced allocation world');
  const camera = new Entity('Camera')
    .addComponent(new Camera3D())
    .addComponent(new CartesianTransform3D({ position: [0, 0, 5] }));
  world.addEntity(camera);
  for (let i = 0; i < 3; i++) {
    const geometry = new Geometry3D({
      positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]),
    });
    const entity = new Entity(`Batch ${i}`)
      .addComponent(new CartesianTransform3D({ position: [i, 0, 0] }))
      .addComponent(new InstancedMesh3D(geometry, new InstancedMaterial(4)));
    world.addEntity(entity);
  }
  const system = new InstancedMesh3DRenderSystem(engine, camera);
  world.addSystem(system);
  world.update(0, 0);
  return { world, system };
}

test('InstancedMesh3D reuses batch, command, and external-indirect objects after warm-up', () => {
  const { world, system } = createFixture();
  const firstBatches = [...system._collectBatches(world)];
  const firstCommands = [...system._writeBatchCommands(firstBatches)];
  const indirectBuffer = {};
  const fakeBatchBuffer = {
    writeIndirectCommandView(index, out) {
      out.indexedIndirectBuffer = indirectBuffer;
      out.drawIndirectBuffer = indirectBuffer;
      out.indexedIndirectOffset = index * 20;
      out.drawIndirectOffset = index * 16;
      return out;
    },
  };
  const firstIndirect = system._getExternalIndirect(fakeBatchBuffer, firstBatches[0]);
  const warmStats = { ...system.allocationStats };

  const secondBatches = [...system._collectBatches(world)];
  const secondCommands = [...system._writeBatchCommands(secondBatches)];
  const secondIndirect = system._getExternalIndirect(fakeBatchBuffer, secondBatches[0]);

  assert.deepEqual(system.allocationStats, warmStats);
  assert.equal(warmStats.batchObjectsCreated, 3);
  assert.equal(warmStats.commandObjectsCreated, 3);
  assert.equal(warmStats.externalIndirectObjectsCreated, 3);
  for (let i = 0; i < firstBatches.length; i++) {
    assert.equal(secondBatches[i], firstBatches[i]);
    assert.equal(secondCommands[i], firstCommands[i]);
  }
  assert.equal(secondIndirect, firstIndirect);
  assert.equal(secondIndirect.indexedIndirectOffset, 0);
});
