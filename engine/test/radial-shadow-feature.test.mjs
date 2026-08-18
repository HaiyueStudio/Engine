import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Camera3D,
  Entity,
  Material,
  Mesh3D,
  RadialShadowRenderFeature,
  Transform3D,
  World,
  createPlane3D,
} from '../dist/experimental.js';
import { createMockEngine } from './helpers.mjs';

class CrossRuntimeRadialShadowMaterial extends Material {
  type = 'radial-shadow';
  color = [0, 0, 0];
  opacity = 0.25;
  innerRadius = 0.1;
}

test('RadialShadowRenderFeature is a render pass contributor with shared pass defaults', () => {
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D());
  camera.addComponent(new Transform3D());
  const feature = new RadialShadowRenderFeature(createMockEngine(), camera);

  assert.equal(feature.name, 'RadialShadowRenderFeature');
  assert.deepEqual(feature.renderPipelineOptions, { pass: 'shared', loadOp: 'load' });
});

test('RadialShadowRenderFeature queries meshes by materialType instead of instanceof', () => {
  const camera = new Entity('Camera');
  camera.addComponent(new Camera3D());
  camera.addComponent(new Transform3D());
  const feature = new RadialShadowRenderFeature(createMockEngine(), camera);
  const world = new World('RadialShadowFeatureWorld');
  const entity = new Entity('Shadow');
  entity.addComponent(new Transform3D());
  entity.addComponent(new Mesh3D(createPlane3D(), new CrossRuntimeRadialShadowMaterial()));

  world.addEntity(entity);
  world.addSystem(feature);

  assert.equal(feature.entitySet.get(world)?.has(entity), true);
});
