import test from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from '@haiyue/engine/scene';
import { createMockEngine } from '../../engine/test/helpers.mjs';
import { createGltfPlugin, GltfModelSystem } from '../dist/gltf.js';
import { createSpinePlugin, Spine2DRenderSystem } from '../dist/spine.js';
import { createTilemapPlugin, Tilemap2DRenderSystem } from '../dist/tilemap.js';

const plugins = [
  ['gltf', createGltfPlugin, GltfModelSystem],
  ['spine', createSpinePlugin, Spine2DRenderSystem],
  ['tilemap', createTilemapPlugin, Tilemap2DRenderSystem],
];
function setup() {
  const engine = createMockEngine();
  const participants = new Set();
  engine.registerDeviceRecoveryParticipant = participant => {
    participants.add(participant);
    return () => participants.delete(participant);
  };
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  return { engine, scene, participants };
}
function observeDestroy(system) {
  let count = 0;
  const destroy = system.destroy.bind(system);
  system.destroy = () => { count++; return destroy(); };
  return () => count;
}

for (const [name, create, SystemType] of plugins) {
  test(`${name} owns and destroys each scene system independently`, () => {
    const a = setup(), b = setup(), plugin = create();
    try {
      a.scene.installPlugin(plugin);
      b.scene.installPlugin(plugin);
      const first = a.scene.world.getSystem(SystemType), second = b.scene.world.getSystem(SystemType);
      assert.ok(first); assert.ok(second); assert.notEqual(first, second);
      const firstDestroyed = observeDestroy(first), secondDestroyed = observeDestroy(second);
      a.scene.removePlugin(plugin.name);
      assert.equal(firstDestroyed(), 1, 'uninstall must release owned resources, not just detach');
      assert.equal(a.participants.size, 0);
      assert.equal(secondDestroyed(), 0);
      assert.equal(b.scene.world.hasSystem(second), true);
      b.scene.destroy();
      assert.equal(secondDestroyed(), 1, 'scene destruction must release its plugin system');
      assert.equal(b.participants.size, 0);
      a.scene.removePlugin(plugin.name);
      assert.equal(firstDestroyed(), 1, 'uninstall is idempotent');
    } finally { a.scene.destroy(); b.scene.destroy(); }
  });

  test(`${name} destroys its owned system when installation rolls back`, () => {
    const { scene, participants } = setup(), plugin = create();
    let destroyed;
    try {
      assert.throws(() => scene.installPlugin({
        ...plugin,
        installScene(context) {
          plugin.installScene(context);
          destroyed = observeDestroy(context.world.getSystem(SystemType));
          throw new Error('fixture: fail after installing the system');
        },
      }), /Failed to install plugin/);
      assert.equal(scene.world.getSystem(SystemType), null);
      assert.equal(destroyed(), 1);
      assert.equal(participants.size, 0);
    } finally { scene.destroy(); }
  });

  test(`${name} viewport disposal destroys owned systems and preserves borrowed ones`, () => {
    const { engine, scene, participants } = setup(), plugin = create();
    let contribution;
    plugin.installEditor({ registerContribution(value) { contribution = value.components[0]; } });
    const viewport = { engine, world: scene.world, camera2DEntity: scene.cameraEntity };
    try {
      const owned = contribution.installViewport(viewport);
      const system = scene.world.getSystem(SystemType), destroyed = observeDestroy(system);
      const borrowed = contribution.installViewport(viewport);
      borrowed.dispose();
      assert.equal(destroyed(), 0);
      assert.equal(scene.world.hasSystem(system), true);
      owned.dispose(); owned.dispose();
      assert.equal(destroyed(), 1);
      assert.equal(scene.world.hasSystem(system), false);
      assert.equal(participants.size, 0);
    } finally { scene.destroy(); }
  });

  test(`${name} rolls back when attachment fails before returning a registration token`, () => {
    const { scene, participants } = setup(), plugin = create();
    let destroyed;
    try {
      assert.throws(() => scene.installPlugin({
        ...plugin,
        installScene(context) {
          plugin.installScene({ ...context, addSystem(system) {
            destroyed = observeDestroy(system);
            context.world.addSystem(system);
            throw new Error('fixture: partial system attachment');
          } });
        },
      }), /Failed to install plugin/);
      assert.equal(scene.world.getSystem(SystemType), null);
      assert.equal(destroyed(), 1);
      assert.equal(participants.size, 0);
    } finally { scene.destroy(); }
  });

  if (name !== 'gltf') test(`${name} failed viewport registration releases only owned systems`, () => {
    const { engine, scene, participants } = setup(), plugin = create();
    let contribution;
    plugin.installEditor({ registerContribution(value) { contribution = value.components[0]; } });
    const viewport = { engine, world: scene.world, camera2DEntity: scene.cameraEntity };
    const broken = { ...viewport, registerRenderSystem() { throw new Error('fixture: registration rejected'); } };
    try {
      assert.throws(() => contribution.installViewport(broken), /registration rejected/);
      assert.equal(scene.world.getSystem(SystemType), null);
      assert.equal(participants.size, 0);
      const owner = contribution.installViewport(viewport);
      const system = scene.world.getSystem(SystemType);
      assert.throws(() => contribution.installViewport(broken), /registration rejected/);
      assert.equal(scene.world.getSystem(SystemType), system);
      assert.equal(system.autoUpdate, true);
      owner.dispose();
      assert.equal(participants.size, 0);
    } finally { scene.destroy(); }
  });
}
