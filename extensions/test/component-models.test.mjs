import assert from 'node:assert/strict';
import test from 'node:test';
import { GltfModelComponent } from '../dist/gltf.js';
import { Spine2DComponent } from '../dist/spine.js';

test('GltfModelComponent caches source keys and clone excludes runtime state', () => {
  const component = new GltfModelComponent({
    src: 'models/hero.glb',
    scene: 1,
    autoLoad: false,
    clearPrevious: false,
    baseColorFactor: [0.1, 0.2, 0.3, 1],
  });

  assert.equal(component.sourceKey, 'models/hero.glb|1');
  component.src = 'models/hero-v2.glb';
  assert.equal(component.sourceKey, 'models/hero-v2.glb|1');
  component.scene = null;
  assert.equal(component.sourceKey, 'models/hero-v2.glb|');

  component.status = 'loaded';
  component.error = 'runtime error';
  component.runtimeCompatibilityReport = { status: 'compatible' };
  component.runtimeSourceKey = 'runtime-key';
  component.loadingSourceKey = 'loading-key';

  const clone = component.clone();
  assert.notEqual(clone, component);
  assert.equal(clone.sourceKey, 'models/hero-v2.glb|');
  assert.equal(clone.autoLoad, false);
  assert.equal(clone.clearPrevious, false);
  assert.deepEqual(clone.baseColorFactor, [0.1, 0.2, 0.3, 1]);
  assert.equal(clone.status, 'idle');
  assert.equal(clone.error, null);
  assert.equal(clone.runtimeCompatibilityReport, null);
  assert.equal(clone.runtimeSourceKey, '');
  assert.equal(clone.loadingSourceKey, '');
});

test('Spine2DComponent source keys track image URL maps and clone deep-copies options', () => {
  const component = new Spine2DComponent({
    jsonUrl: 'spine/hero.json',
    atlasUrl: 'spine/hero.atlas',
    imageUrl: '',
    imageUrls: { hero: 'hero.png' },
    skin: 'default',
    animation: 'idle',
    loop: false,
    timeScale: 1.5,
    scale: 0.5,
    premultipliedAlpha: true,
    debugMesh: true,
    debugBones: true,
    mixDuration: 0.2,
  });

  assert.equal(component.sourceKey, 'spine/hero.json|spine/hero.atlas||{"hero":"hero.png"}|default');
  component.imageUrls.hero = 'hero@2x.png';
  assert.equal(component.sourceKey, 'spine/hero.json|spine/hero.atlas||{"hero":"hero.png"}|default');
  component.invalidateSourceKey();
  assert.equal(component.sourceKey, 'spine/hero.json|spine/hero.atlas||{"hero":"hero@2x.png"}|default');

  const clone = component.clone();
  assert.notEqual(clone.imageUrls, component.imageUrls);
  clone.imageUrls.hero = 'clone.png';
  assert.equal(component.imageUrls.hero, 'hero@2x.png');
  assert.equal(clone.animation, 'idle');
  assert.equal(clone.loop, false);
  assert.equal(clone.timeScale, 1.5);
  assert.equal(clone.scale, 0.5);
  assert.equal(clone.premultipliedAlpha, true);
  assert.equal(clone.debugMesh, true);
  assert.equal(clone.debugBones, true);
  assert.equal(clone.mixDuration, 0.2);
});
