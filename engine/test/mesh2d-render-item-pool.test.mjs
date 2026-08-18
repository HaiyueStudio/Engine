import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Camera2D,
  Entity,
  Geometry2D,
  Material2D,
  Mesh2D,
  Mesh2DRenderSystem,
  Transform2D,
  World,
} from '../dist/experimental.js';

test('Mesh2DRenderSystem reuses one stable render item per live entity', () => {
  const engine = {
    device: {},
    displayWidth: 800,
    displayHeight: 600,
    reverseZ: false,
    msaaSamples: 1,
    registerDeviceRecoveryParticipant() { return () => {}; },
  };
  const world = new World('mesh2d-item-pool');
  const camera = new Entity('camera').addComponent(new Transform2D()).addComponent(new Camera2D());
  world.addEntity(camera);
  const geometry = new Geometry2D(new Float32Array([0, 0, 1, 0, 0, 1]));
  const material = new Material2D();
  for (let index = 0; index < 4; index++) {
    world.addEntity(new Entity(`mesh:${index}`)
      .addComponent(new Transform2D({ x: index }))
      .addComponent(new Mesh2D(geometry, material)));
  }
  const system = new Mesh2DRenderSystem(engine, camera);
  const frames = [];
  system._renderer = {
    reverseZ: false,
    msaaSamples: 1,
    prepare() {},
    updateCamera() {},
    renderMany(_pass, items) { frames.push([...items]); },
    releaseEntitiesNotIn() {},
    releaseGeometriesNotIn() {},
    destroy() {},
  };
  world.addSystem(system);
  const context = { device: engine.device, passEncoder: { end() {} } };
  world.frameData.begin(world, engine, 1, 16);
  system.record(world, context);
  world.frameData.begin(world, engine, 2, 16);
  system.record(world, context);

  assert.equal(system._renderItemPool.length, 4);
  assert.equal(frames.length, 2);
  for (let index = 0; index < 4; index++) assert.equal(frames[0][index], frames[1][index]);
  world.destroy();
});
