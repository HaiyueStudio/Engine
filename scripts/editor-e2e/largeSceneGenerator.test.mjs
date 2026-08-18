import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeterministicEditorScene } from './largeSceneGenerator.mjs';

function countEntities(entities) {
  let count = 0;
  const stack = [...entities];
  while (stack.length > 0) {
    const entity = stack.pop();
    if (!entity) continue;
    count++;
    stack.push(...entity.children);
  }
  return count;
}

for (const entityCount of [1000, 10000]) {
  test(`deterministic editor scene generator emits exactly ${entityCount} entities`, () => {
    const first = createDeterministicEditorScene(entityCount);
    const second = createDeterministicEditorScene(entityCount);
    assert.equal(countEntities(first.scene.entities), entityCount);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.json, second.json);
    assert.ok(first.scene.entities.every(root => root.children.length <= 99));
    assert.ok(first.scene.entities.every(root => root.components[0].type === 'CartesianTransform3D'));
    assert.equal(first.scene.resources.geometries.length, 1);
    assert.equal(first.scene.resources.materials.length, 1);
    assert.equal(
      first.scene.entities.filter(root => root.components.some(component => component.type === 'Mesh3D')).length,
      first.rootCount,
      'each hierarchy group keeps resource tracking active without reducing the entity workload',
    );
  });
}
