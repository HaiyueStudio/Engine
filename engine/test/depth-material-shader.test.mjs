import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('DepthMaterial derives normalized linear depth from view space', async () => {
  const source = await readFile(new URL('../src/shaders/generated/deformation-depth.generated.wgsl', import.meta.url), 'utf8');

  assert.match(source, /sceneFrame\.view\s*\*\s*worldPosition/);
  assert.match(source, /out\.viewDepth\s*=\s*-viewPosition\.z/);
  assert.match(source, /in\.viewDepth\s*-\s*params\.near/);
  assert.doesNotMatch(source, /in\.clipPos\.z\s*\/\s*in\.clipPos\.w/);
});

test('DepthMaterial uses the current morph-then-skin deformation for depth rejection', async () => {
  const source = await readFile(new URL('../src/shaders/generated/deformation-depth.generated.wgsl', import.meta.url), 'utf8');
  const morph = source.indexOf('applyMorphPosition(');
  const skin = source.indexOf('skinPosition(');
  const world = source.indexOf('object.model * localPosition');

  assert.ok(morph >= 0 && skin > morph && world > skin);
  assert.match(source, /object\.morphWeights/);
  assert.match(source, /object\.deformationFlags\.y\s*>\s*0\.5/);
});

test('Depth and Normal shaders select storage-table objects with instance_index', async () => {
  const [depth, normal] = await Promise.all([
    readFile(new URL('../src/shaders/generated/deformation-depth.generated.wgsl', import.meta.url), 'utf8'),
    readFile(new URL('../src/shaders/generated/simple3d-normal-material.generated.wgsl', import.meta.url), 'utf8'),
  ]);

  for (const source of [depth, normal]) {
    assert.match(source, /var<storage,\s*read>\s+objects\s*:\s*array<ObjectUniforms>/);
    assert.match(source, /@builtin\(instance_index\)\s+instanceIndex\s*:\s*u32/);
    assert.match(source, /let\s+object\s*=\s*objects\[input\.instanceIndex\]/);
    assert.doesNotMatch(source, /var<uniform>\s+object\s*:\s*ObjectUniforms/);
  }
});

test('NormalMaterial resets homogeneous w before converting world normals to view space', async () => {
  const source = await readFile(
    new URL('../src/shaders/generated/simple3d-normal-material.generated.wgsl', import.meta.url),
    'utf8',
  );

  assert.match(source, /let worldNormal = normalize\(\(object\.normalMatrix \* vec4<f32>\(input\.normal, 0\.0\)\)\.xyz\)/);
  assert.match(source, /sceneFrame\.view \* vec4<f32>\(worldNormal, 0\.0\)/);
  assert.doesNotMatch(source, /sceneFrame\.view \* object\.normalMatrix/);
});
