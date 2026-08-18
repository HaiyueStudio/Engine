import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistrationToken,
  createRenderCapabilities,
  createSceneSystemPlan,
  DEFAULT_RENDER_PROFILE,
  Entity,
  Material,
  resolveRenderProfileFeatures,
  Scene,
  System,
} from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

class TokenMaterial extends Material {
  type = 'token-material';
}

class TokenSystem extends System {
  constructor() { super(() => false); }
  record() {}
}

test('registration tokens are active, reversible, and idempotent', () => {
  let cleanup = 0;
  const token = createRegistrationToken(() => cleanup++);
  assert.equal(token.active, true);
  token.unregister();
  token.unregister();
  assert.equal(token.active, false);
  assert.equal(cleanup, 1);
});

test('scene plugin registration APIs return independently reversible tokens', () => {
  const engine = createMockEngine();
  const scene = new Scene(engine);
  const system = new TokenSystem();
  const tokens = {};

  scene.installPlugin({
    name: 'registration-token-plugin',
    version: '1.0.0',
    installScene(context) {
      tokens.component = context.registerComponent({ type: 'TokenComponent', component: function TokenComponent() {} });
      tokens.system = context.addSystem(system, false);
      tokens.loader = context.registerAssetLoader({ type: 'token/asset', async load() { return 'token'; } });
      tokens.renderer = context.registerMaterialRenderer({ materialType: TokenMaterial, renderItem() {} });
    },
  });

  assert.equal(Object.values(tokens).every(token => token.active), true);
  assert.equal(scene.getRegisteredComponent('TokenComponent')?.type, 'TokenComponent');
  assert.equal(scene.world.hasSystem(system), true);
  assert.equal(engine.assetManager.hasLoader('token/asset'), true);
  assert.notEqual(scene.render3DSystem.materialRenderers.resolve(new TokenMaterial()), null);

  tokens.renderer.unregister();
  tokens.loader.unregister();
  tokens.system.unregister();
  tokens.component.unregister();

  assert.equal(Object.values(tokens).every(token => !token.active), true);
  assert.equal(scene.getRegisteredComponent('TokenComponent'), undefined);
  assert.equal(scene.world.hasSystem(system), false);
  assert.equal(engine.assetManager.hasLoader('token/asset'), false);
  assert.equal(scene.render3DSystem.materialRenderers.resolve(new TokenMaterial()), null);
  assert.doesNotThrow(() => scene.removePlugin('registration-token-plugin'));
});

test('scene presets compile to declarative system plans', () => {
  assert.deepEqual(createSceneSystemPlan({ render3D: false, render2D: true, gui: true }), [
    { role: 'render2d', option: true },
    { role: 'gui', option: true },
  ]);
  assert.deepEqual(createSceneSystemPlan({}), [{ role: 'render3d', option: undefined }]);
});

test('3D-first RenderProfile resolves device requests and immutable capabilities', () => {
  const adapter = {
    features: new Set(['timestamp-query', 'indirect-first-instance', 'texture-compression-bc']),
  };
  const device = {
    features: new Set(['timestamp-query', 'indirect-first-instance', 'texture-compression-bc']),
  };
  const requested = resolveRenderProfileFeatures(adapter.features, 'diagnostic');
  assert.deepEqual(requested, ['indirect-first-instance', 'timestamp-query', 'texture-compression-bc']);

  const capabilities = createRenderCapabilities('diagnostic', adapter, device, 'bgra8unorm');
  assert.equal(DEFAULT_RENDER_PROFILE, 'batched');
  assert.equal(capabilities.profile.name, 'diagnostic');
  assert.equal(capabilities.report.requestedProfile, 'diagnostic');
  assert.equal(capabilities.report.enabledProfile, 'diagnostic');
  assert.equal(capabilities.report.degraded, false);
  assert.equal(capabilities.timestampQuery, true);
  assert.equal(capabilities.indirectFirstInstance, true);
  assert.equal(capabilities.textureCompression.bc, true);
  assert.equal(capabilities.textureCompression.astc, false);
  assert.equal(Object.isFrozen(capabilities), true);
});
