import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Material2D,
  Material2DRendererRegistry,
  BasicMaterial,
  BlinnPhongMaterial,
  DepthMaterial,
  NormalMaterial,
  Entity,
  Render3DSystem,
  EngineErrorCode,
  EnginePluginHost,
  EngineRegistryHub,
  assertPluginDependencies,
} from '../dist/experimental.js';
import { Material, MaterialRendererRegistry } from '../dist/material.js';
import { createMockEngine } from './helpers.mjs';

class TestMaterial extends Material {
  type = 'test';
}

class DerivedMaterial extends TestMaterial {
  type = 'derived';
}

class CrossRealmLikeMaterial extends Material {
  type = 'cross-realm';
}

class CrossRealmLikeMaterial2D extends Material2D {
  type = 'cross-realm-2d';
}

test('MaterialRendererRegistry resolves exact and derived material registrations', () => {
  const registry = new MaterialRendererRegistry();
  const base = { materialType: TestMaterial, renderItem() {} };
  const derived = { materialType: DerivedMaterial, renderItem() {} };

  registry.register(base);
  assert.equal(registry.resolve(new TestMaterial()), base);
  assert.equal(registry.resolve(new DerivedMaterial()), base);

  registry.register(derived);
  assert.equal(registry.resolve(new DerivedMaterial()), derived);
});

test('MaterialRendererRegistry unregister and destroy clean up registrations', () => {
  const registry = new MaterialRendererRegistry();
  let destroyed = 0;
  registry.register({ materialType: TestMaterial, renderItem() {}, destroy: () => destroyed++ });

  registry.unregister(TestMaterial);
  assert.equal(registry.resolve(new TestMaterial()), null);
  assert.equal(destroyed, 1);

  registry.register({ materialType: TestMaterial, renderItem() {}, destroy: () => destroyed++ });
  registry.destroy();
  assert.equal(registry.resolve(new TestMaterial()), null);
  assert.equal(destroyed, 2);
});

test('MaterialRendererRegistry resolves string materialType without instanceof', () => {
  const registry = new MaterialRendererRegistry();
  const constructorRegistration = { materialType: CrossRealmLikeMaterial, renderItem() {} };
  const stringRegistration = { materialType: 'cross-realm', renderItem() {} };
  const material = new CrossRealmLikeMaterial();

  registry.register(constructorRegistration);
  registry.register(stringRegistration);

  assert.equal(material.type, 'cross-realm');
  assert.equal(registry.resolve(material), stringRegistration);

  registry.unregister('cross-realm');
  assert.equal(registry.resolve(material), constructorRegistration);
});

test('MaterialRendererRegistry resolves directional-shadow culling explicitly', () => {
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: BasicMaterial,
    shadowCullMode: material => material.cullMode,
    renderItem() {},
  });

  assert.equal(registry.resolveShadowCullMode(new BasicMaterial({ cullMode: 'front' })), 'front');
  assert.equal(registry.resolveShadowCullMode(new TestMaterial()), null);
});

test('MaterialRendererRegistry exposes directional-shadow receiving as a registration capability', () => {
  const registry = new MaterialRendererRegistry();
  registry.register({
    materialType: BasicMaterial,
    receivesDirectionalShadow: material => material.blending === 'none',
    renderItem() {},
  });

  assert.equal(registry.receivesDirectionalShadow(new BasicMaterial()), true);
  assert.equal(registry.receivesDirectionalShadow(new BasicMaterial({ blending: 'normal' })), false);
  assert.equal(registry.receivesDirectionalShadow(new TestMaterial()), false);
});

test('Material base exposes explicit revision helpers', () => {
  const material = new BasicMaterial({ blending: 'normal', depthWrite: false, cullMode: 'front' });
  assert.equal('materialType' in material, false);
  assert.equal('getCullMode' in material, false);
  const initialVersion = material.revision;

  material.markDirty();
  assert.equal(material.revision, initialVersion + 1);
});

test('Material2DRendererRegistry resolves string materialType and transparent hooks', () => {
  const registry = new Material2DRendererRegistry();
  const material = new CrossRealmLikeMaterial2D();
  const registration = {
    materialType: 'cross-realm-2d',
    isTransparent: () => true,
    transparentOrder: () => 7,
    transparentDepthSort: () => false,
    render() {},
  };

  registry.register(registration);

  assert.equal(registry.resolve(material), registration);
  assert.equal(registry.resolve(material).isTransparent(material), true);
  assert.equal(registry.resolve(material).transparentOrder(material), 7);
  assert.equal(registry.resolve(material).transparentDepthSort(material), false);
});

test('Material2DRendererRegistry uses the shared material registry resolution contract', () => {
  const registry = new Material2DRendererRegistry();
  const constructorRegistration = { materialType: CrossRealmLikeMaterial2D, render() {} };
  const stringRegistration = { materialType: 'cross-realm-2d', render() {} };
  const material = new CrossRealmLikeMaterial2D();

  registry.register(constructorRegistration);
  registry.register(stringRegistration);

  assert.equal(registry.resolve(material), stringRegistration);

  registry.unregister('cross-realm-2d');
  assert.equal(registry.resolve(material), constructorRegistration);
});

test('Render3DSystem can selectively skip default material renderers', () => {
  const engine = createMockEngine();
  const camera = new Entity('Camera');
  const render3D = new Render3DSystem(engine, camera, {
    registerDefaultMaterialRenderers: {
      basic: false,
      blinnPhong: false,
      depth: true,
      normal: true,
      volume: false,
    },
  });

  assert.equal(render3D.materialRenderers.resolve(new BasicMaterial()), null);
  assert.equal(render3D.materialRenderers.resolve(new BlinnPhongMaterial()), null);
  assert.equal(typeof render3D.materialRenderers.resolve(new DepthMaterial())?.renderBatch, 'function');
  assert.equal(typeof render3D.materialRenderers.resolve(new NormalMaterial())?.renderBatch, 'function');
});

test('Render3DSystem dispatches BlinnPhongMaterial through its default material registry', () => {
  const render3D = new Render3DSystem(createMockEngine(), new Entity('Camera'));

  const registration = render3D.materialRenderers.resolve(new BlinnPhongMaterial());
  assert.equal(typeof registration?.renderItem, 'function');
  assert.equal(typeof registration?.renderBatch, 'function');
});

test('assertPluginDependencies reports missing plugin dependencies with EngineError', () => {
  assert.doesNotThrow(() => assertPluginDependencies(
    { name: 'feature', version: '1.0.0', dependencies: ['core'] },
    name => name === 'core',
  ));

  assert.throws(
    () => assertPluginDependencies(
      { name: 'feature', version: '1.0.0', dependencies: ['missing'] },
      () => false,
    ),
    error => error.code === EngineErrorCode.PluginDependencyMissing,
  );
});

test('EngineRegistryHub registers, replaces, and clears component registrations', () => {
  const registry = new EngineRegistryHub();
  const first = { type: 'UnitComponent', component: function First() {} };
  const second = { type: 'UnitComponent', component: function Second() {} };

  registry.registerComponent(first);
  assert.equal(registry.getRegisteredComponent('UnitComponent'), first);
  registry.registerComponent(second);
  assert.equal(registry.getRegisteredComponent('UnitComponent'), second);
  registry.unregisterComponent('UnitComponent');
  assert.equal(registry.getRegisteredComponent('UnitComponent'), undefined);
  registry.registerComponent(first);
  registry.clear();
  assert.equal(registry.getRegisteredComponent('UnitComponent'), undefined);
});

test('EnginePluginHost installs, rolls back, enables dependencies in order, and protects unload', () => {
  const calls = [];
  const host = new EnginePluginHost({
    scope: 'engine',
    installHint: 'install hint',
    createContext(tracker) {
      return {
        scope: 'engine',
        engine: {},
        rollback: tracker,
        hasPlugin: name => host.hasPlugin(name),
        unregister: () => tracker.unregister(),
        registerComponent() {},
        registerAssetLoader() {},
      };
    },
    hasDependency: name => host.hasPlugin(name),
    isDependencyEnabled: name => host.isPluginEnabled(name),
  });

  const base = {
    name: 'base',
    version: '1.0.0',
    installEngine() { calls.push('base:install'); },
    enableEngine() { calls.push('base:enable'); },
    disableEngine() { calls.push('base:disable'); },
    uninstallEngine() { calls.push('base:uninstall'); },
  };
  const dependent = {
    name: 'dependent',
    version: '1.0.0',
    dependencies: ['base'],
    installEngine() { calls.push('dependent:install'); },
    enableEngine() { calls.push('dependent:enable'); },
  };

  host.installPlugin(base);
  assert.equal(host.hasPlugin('base'), true);
  assert.equal(host.isPluginEnabled('base'), true);
  host.disablePlugin('base');
  assert.equal(host.isPluginEnabled('base'), false);

  host.installPlugin(dependent);
  assert.equal(host.isPluginEnabled('base'), true);
  assert.equal(host.isPluginEnabled('dependent'), true);
  assert.throws(
    () => host.disablePlugin('base'),
    error => error.code === EngineErrorCode.PluginDependencyInUse,
  );
  assert.throws(
    () => host.removePlugin('base'),
    error => error.code === EngineErrorCode.PluginDependencyInUse,
  );

  host.clear();
  assert.equal(host.hasPlugin('base'), false);
  assert.equal(host.hasPlugin('dependent'), false);
  assert.deepEqual(calls, [
    'base:install',
    'base:enable',
    'base:disable',
    'dependent:install',
    'base:enable',
    'dependent:enable',
    'base:disable',
    'base:uninstall',
  ]);
});
