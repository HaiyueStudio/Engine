import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ClippingPlanes, MAX_CLIPPING_PLANES } from '../dist/components.js';
import { coreComponentSerializationRegistry } from '../dist/serialization.js';

test('ClippingPlanes normalizes equations, validates capacity, and tracks semantic changes', () => {
  const clipping = new ClippingPlanes({
    planes: [
      { normal: [2, 0, 0], constant: -4 },
      { normal: [0, 3, 0], constant: 6 },
    ],
  });
  assert.equal(MAX_CLIPPING_PLANES, 8);
  assert.equal(clipping.count, 2);
  assert.deepEqual(clipping.getPlane(0), { normal: [1, 0, 0], constant: -2 });
  assert.deepEqual(clipping.getPlane(1), { normal: [0, 1, 0], constant: 2 });

  const revision = clipping.revision;
  clipping.setPlane(0, { normal: [4, 0, 0], constant: -8 });
  assert.equal(clipping.revision, revision, 'equivalent normalized planes must not trigger another upload');
  clipping.setPlane(0, { normal: [1, 0, 0], constant: -1 });
  assert.equal(clipping.revision, revision + 1);

  assert.throws(() => clipping.setPlane(2, { normal: [1, 0, 0], constant: 0 }), /outside/);
  assert.throws(() => new ClippingPlanes([{ normal: [0, 0, 0], constant: 0 }]), /non-zero normal/);
  assert.throws(() => new ClippingPlanes(Array.from({ length: 9 }, () => ({ normal: [1, 0, 0], constant: 0 }))), /at most 8/);
});

test('ClippingPlanes clones independently and survives core scene serialization', () => {
  const clipping = new ClippingPlanes([
    { normal: [1, 0, 0], constant: 0.25 },
    { normal: [0, 0, -2], constant: 1 },
  ]);
  clipping.disabled = true;
  const clone = clipping.clone();
  assert.notEqual(clone, clipping);
  assert.equal(clone.disabled, true);
  assert.deepEqual(clone.getPlane(1), { normal: [0, 0, -1], constant: 0.5 });
  clone.setPlane(0, { normal: [1, 0, 0], constant: 1 });
  assert.equal(clipping.getPlane(0).constant, 0.25);

  const data = coreComponentSerializationRegistry.serialize(clipping);
  const restored = coreComponentSerializationRegistry.deserialize(data);
  assert.ok(restored instanceof ClippingPlanes);
  assert.equal(restored.count, 2);
  assert.deepEqual(restored.getPlane(0), { normal: [1, 0, 0], constant: 0.25 });
  assert.deepEqual(restored.getPlane(1), { normal: [0, 0, -1], constant: 0.5 });
});

test('generated render families apply clipping in every geometry pass', async () => {
  const surfaceFiles = [
    'deformation-forward.generated.wgsl',
    'deformation-depth.generated.wgsl',
    'deformation-shadow.generated.wgsl',
    'deformation-motion-vector.generated.wgsl',
    'deformation-outline.generated.wgsl',
    'simple3d-normal-material.generated.wgsl',
    'material-lighting-pbr.generated.wgsl',
    'material-lighting-blinn-phong.generated.wgsl',
    'material-lighting-toon.generated.wgsl',
  ];
  for (const file of surfaceFiles) {
    const source = await readFile(new URL(`../src/shaders/generated/${file}`, import.meta.url), 'utf8');
    assert.match(source, /fn hy_is_clipped\(/, `${file} must contain the shared clipping function`);
    assert.match(source, /if \(hy_is_clipped\([^\n]+\)\) \{ discard; \}/, `${file} must discard clipped fragments`);
  }

  const volumeSource = await readFile(
    new URL('../src/shaders/generated/specialized-volume.generated.wgsl', import.meta.url),
    'utf8',
  );
  assert.match(volumeSource, /fn hy_is_clipped\(/);
  assert.match(
    volumeSource,
    /if \(hy_is_clipped\([^\n]+\)\) \{ continue; \}/,
    'volume clipping must skip clipped ray-march samples instead of discarding the proxy-box fragment',
  );
});
