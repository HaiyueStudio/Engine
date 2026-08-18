import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineErrorCode, Entity, getSceneRenderPipeline, normalizeSceneOptions, Scene, System } from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

class DummySystem extends System {
  constructor() {
    super(() => false);
  }

  record() {}
}

class WarmupSystem extends DummySystem {
  compiled = 0;

  contributePipelineWarmup(plan) {
    plan.add({
      id: 'warmup-system:main',
      label: 'Warmup system main pipeline',
      compile: async () => { this.compiled++; },
    });
  }
}

test('Scene creates world, render pipeline, and default 3D camera without render systems when disabled', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, {
    name: 'UnitScene',
    render3D: false,
    render2D: false,
    gui: false,
    camera: { camera3D: { far: 500 } },
  });

  assert.equal(scene.world.name, 'UnitScene');
  assert.equal(getSceneRenderPipeline(scene).size, 0);
  assert.equal(scene.render3DSystem, null);
  assert.equal(scene.render2DSystem, null);
  assert.equal(scene.guiSystem, null);
  assert.equal(scene.world.hasEntity(scene.cameraEntity), true);
});

test('Scene owns independent RenderView state without mutating Engine defaults', () => {
  const engine = createMockEngine();
  const original = {
    clearColor: { ...engine.clearColor },
    reverseZ: engine.reverseZ,
    msaaSamples: engine.msaaSamples,
  };
  const first = new Scene(engine, {
    render3D: false,
    render2D: false,
    gui: false,
    view: {
      clearColor: { r: 0.2, g: 0.3, b: 0.4, a: 1 },
      depthConvention: 'reverse',
      sampleCount: 4,
    },
  });
  const second = new Scene(engine, {
    render3D: false,
    render2D: false,
    gui: false,
  });

  assert.deepEqual(engine.clearColor, original.clearColor);
  assert.equal(engine.reverseZ, original.reverseZ);
  assert.equal(engine.msaaSamples, original.msaaSamples);
  assert.equal(first.renderView.reverseZ, true);
  assert.equal(first.renderView.sampleCount, 4);
  assert.equal(second.renderView.reverseZ, false);
  assert.equal(second.renderView.sampleCount, 1);

  first.renderView.clearColor.r = 0.9;
  assert.equal(second.renderView.clearColor.r, 0);
});

test('Scene add, setCamera, and addSystem wire through world and render pipeline', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const entity = new Entity('Object');
  const camera = new Entity('Camera2');
  const system = new DummySystem();

  scene.add(entity).setCamera(camera).addSystem(system);

  assert.equal(scene.world.hasEntity(entity), true);
  assert.equal(scene.world.hasEntity(camera), true);
  assert.equal(scene.cameraEntity.name, 'Camera');
  assert.equal(scene.activeCameraEntity, camera);
  assert.equal(getSceneRenderPipeline(scene).size, 1);
});

test('Scene builds and runs a pipeline warmup plan from installed systems', async () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const system = new WarmupSystem();
  scene.addSystem(system, false);

  const plan = scene.createPipelineWarmupPlan('Scene load shaders');
  assert.equal(plan.snapshot().label, 'Scene load shaders');
  assert.equal(plan.snapshot().total, 1);

  const result = await scene.warmupPipelines();
  assert.equal(result.status, 'completed');
  assert.equal(result.total, 1);
  assert.equal(system.compiled, 1);
});

test('Scene presets configure common high-level workflows', () => {
  const engine = createMockEngine();
  const scene2D = new Scene(engine, normalizeSceneOptions('2d'));
  assert.equal(scene2D.render3DSystem, null);
  assert.notEqual(scene2D.render2DSystem, null);

  const guiScene = new Scene(engine, normalizeSceneOptions('gui'));
  assert.equal(guiScene.render3DSystem, null);
  assert.notEqual(guiScene.guiSystem, null);
});

test('Scene remove and clear keep the default camera by default', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const entity = new Entity('Object');
  const child = new Entity('Child');
  entity.addChild(child);

  scene.add(entity);
  assert.equal(scene.world.hasEntity(entity), true);
  assert.equal(scene.world.hasEntity(child), true);
  scene.remove(entity);
  assert.equal(scene.world.hasEntity(entity), false);
  assert.equal(scene.world.hasEntity(child), false);
  assert.equal(scene.world.hasEntity(scene.cameraEntity), true);

  scene.add(new Entity('Object2'));
  scene.clear();
  assert.equal(scene.world.rootEntityList.length, 1);
  assert.equal(scene.world.hasEntity(scene.cameraEntity), true);
});

test('Scene load helpers retain handles until releaseAssets or destroy', async () => {
  const engine = createMockEngine();
  const released = [];
  const loaded = [];
  engine.assetManager = {
    resolveType(url) {
      return url.endsWith('.ktx2') ? 'texture/ktx2' : null;
    },
    async loadUrl(url, options = {}) {
      loaded.push([options.type ?? 'auto', url]);
      return { key: `asset:${options.type ?? 'auto'}:${url}`, value: { type: options.type, url }, release() { released.push(`${options.type}:${url}`); } };
    },
    async loadTexture(url) {
      loaded.push(['texture', url]);
      return { key: `texture:${url}`, value: { url }, release() { released.push(url); } };
    },
    async loadAsset(type, url) {
      loaded.push([type, url]);
      return { key: `asset:${type}:${url}`, value: { type, url }, release() { released.push(`${type}:${url}`); } };
    },
  };
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const assigned = [];

  const texture = await scene.load('albedo.png');
  const assets = await scene.loadMany([
    { key: 'model', type: 'model/gltf', url: 'scene.gltf', assign: asset => assigned.push(asset.url) },
    { url: 'normal.ktx2' },
  ]);

  assert.deepEqual(texture, { url: 'albedo.png' });
  assert.equal(assets.get('model').url, 'scene.gltf');
  assert.equal(assets.get('normal.ktx2').type, 'texture/ktx2');
  assert.deepEqual(assigned, ['scene.gltf']);
  assert.deepEqual(loaded, [
    ['texture', 'albedo.png'],
    ['model/gltf', 'scene.gltf'],
    ['texture/ktx2', 'normal.ktx2'],
  ]);
  scene.releaseAssets();
  assert.deepEqual(released, ['albedo.png', 'model/gltf:scene.gltf', 'texture/ktx2:normal.ktx2']);
});

test('Scene loadMany releases handles acquired during a failed batch', async () => {
  const engine = createMockEngine();
  const released = [];
  const loaded = [];
  engine.assetManager = {
    resolveType(url) {
      return url.endsWith('.gltf') ? 'model/gltf' : null;
    },
    async loadUrl(url, options = {}) {
      loaded.push([options.type, url]);
      if (url === 'broken.gltf') throw new Error('load failed');
      return { key: `asset:${url}`, value: { url }, release() { released.push(url); } };
    },
    async loadTexture(url) {
      loaded.push(['texture', url]);
      return { key: `texture:${url}`, value: { url }, release() { released.push(url); } };
    },
  };
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });

  await assert.rejects(
    () => scene.loadMany([
      { url: 'ok.gltf' },
      { url: 'albedo.png' },
      { url: 'broken.gltf' },
    ]),
    /load failed/,
  );

  assert.deepEqual(loaded, [
    ['model/gltf', 'ok.gltf'],
    ['texture', 'albedo.png'],
    ['model/gltf', 'broken.gltf'],
  ]);
  assert.deepEqual(released, ['ok.gltf', 'albedo.png']);

  scene.releaseAssets();
  assert.deepEqual(released, ['ok.gltf', 'albedo.png']);
});

test('Scene plugin install, enable, disable, and uninstall receive scene context', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const calls = [];
  const plugin = {
    name: 'unit-plugin',
    version: '1.0.0',
    installScene(context) {
      calls.push(['install', context.scene === scene, context.world === scene.world]);
      context.registerComponent({ type: 'UnitComponent', component: function UnitComponent() {} });
    },
    uninstallScene(context) {
      calls.push(['uninstall', context.scene === scene]);
    },
    enableScene(context) {
      calls.push(['enable', context.scene === scene]);
    },
    disableScene(context) {
      calls.push(['disable', context.scene === scene]);
    },
  };

  scene.installPlugin(plugin);
  assert.equal(scene.hasPlugin('unit-plugin'), true);
  assert.equal(scene.isPluginEnabled('unit-plugin'), true);
  assert.equal(scene.getRegisteredComponent('UnitComponent')?.type, 'UnitComponent');
  scene.disablePlugin('unit-plugin');
  assert.equal(scene.isPluginEnabled('unit-plugin'), false);
  assert.equal(scene.getRegisteredComponent('UnitComponent')?.type, 'UnitComponent');
  scene.enablePlugin('unit-plugin');
  assert.equal(scene.isPluginEnabled('unit-plugin'), true);
  scene.removePlugin('unit-plugin');

  assert.equal(scene.hasPlugin('unit-plugin'), false);
  assert.deepEqual(calls, [
    ['install', true, true],
    ['enable', true],
    ['disable', true],
    ['enable', true],
    ['disable', true],
    ['uninstall', true],
  ]);
});

test('Scene plugin context automatically rolls back registered resources on removePlugin', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const system = new DummySystem();
  const plugin = {
    name: 'rollback-plugin',
    version: '1.0.0',
    installScene(context) {
      context.registerComponent({ type: 'RollbackComponent', component: function RollbackComponent() {} });
      context.addSystem(system, false);
      context.registerAssetLoader({ type: 'unit/asset', async load() { return 'asset'; } });
    },
  };

  scene.installPlugin(plugin);
  assert.equal(scene.getRegisteredComponent('RollbackComponent')?.type, 'RollbackComponent');
  assert.equal(engine.getRegisteredComponent('RollbackComponent')?.type, 'RollbackComponent');
  assert.equal(scene.world.hasSystem(system), true);
  assert.equal(engine.assetManager.hasLoader('unit/asset'), true);

  scene.removePlugin('rollback-plugin');

  assert.equal(scene.getRegisteredComponent('RollbackComponent'), undefined);
  assert.equal(engine.getRegisteredComponent('RollbackComponent'), undefined);
  assert.equal(scene.world.hasSystem(system), false);
  assert.equal(engine.assetManager.hasLoader('unit/asset'), false);
});

test('Scene plugin install failure rolls back registered resources', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const system = new DummySystem();
  const plugin = {
    name: 'failing-plugin',
    version: '1.0.0',
    installScene(context) {
      context.registerComponent({ type: 'FailingComponent', component: function FailingComponent() {} });
      context.addSystem(system, false);
      context.registerAssetLoader({ type: 'failing/asset', async load() { return 'asset'; } });
      throw new Error('install failed');
    },
  };

  let error;
  try {
    scene.installPlugin(plugin);
  } catch (err) {
    error = err;
  }

  assert.ok(error);
  assert.equal(error.code, EngineErrorCode.PluginInstallFailed);
  assert.equal(scene.hasPlugin('failing-plugin'), false);
  assert.equal(scene.getRegisteredComponent('FailingComponent'), undefined);
  assert.equal(engine.getRegisteredComponent('FailingComponent'), undefined);
  assert.equal(scene.world.hasSystem(system), false);
  assert.equal(engine.assetManager.hasLoader('failing/asset'), false);
});

test('Scene plugin enable restores dependencies first and protects dependencies in use', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine, { render3D: false, render2D: false, gui: false });
  const basePlugin = {
    name: 'base-plugin',
    version: '1.0.0',
    installScene() {},
  };
  const dependentPlugin = {
    name: 'dependent-plugin',
    version: '1.0.0',
    dependencies: ['base-plugin'],
    installScene() {},
  };

  scene.installPlugin(basePlugin);
  scene.disablePlugin('base-plugin');
  scene.installPlugin(dependentPlugin);
  assert.equal(scene.isPluginEnabled('base-plugin'), true);
  assert.equal(scene.isPluginEnabled('dependent-plugin'), true);
  assert.throws(
    () => scene.removePlugin('base-plugin'),
    error => error.code === EngineErrorCode.PluginDependencyInUse,
  );
});
