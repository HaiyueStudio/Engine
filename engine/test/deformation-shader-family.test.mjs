import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const passes = await Promise.all([
  'forward', 'forward-skinned', 'depth', 'shadow', 'shadow-morph',
  'shadow-skinned', 'shadow-skinned-morph', 'motion-vector', 'outline',
].map(async id => [id, await readFile(new URL(`../src/shaders/generated/deformation-${id}.generated.wgsl`, import.meta.url), 'utf8')]));

test('every production deformation pass is generated from one ABI module', () => {
  const hashes = new Set();
  for (const [id, source] of passes) {
    assert.match(source, /haiyue:deformation-abi 1/, id);
    const hash = source.match(/haiyue:deformation-module ([a-f0-9]{64})/)?.[1];
    assert.ok(hash, id);
    hashes.add(hash);
  }
  assert.equal(hashes.size, 1);
});

test('forward, depth, shadow and outline preserve morph-before-skin semantics', () => {
  for (const id of ['forward-skinned', 'depth', 'shadow-skinned-morph', 'outline']) {
    const source = passes.find(([pass]) => pass === id)[1];
    const morph = source.lastIndexOf('applyMorphPosition(');
    const skin = source.lastIndexOf('skinPosition(');
    assert.ok(morph >= 0 && skin > morph, id);
  }
});

test('outline now consumes morph, skin and the shared object deformation prefix', () => {
  const source = passes.find(([id]) => id === 'outline')[1];
  assert.match(source, /morphWeights : vec4<f32>/);
  assert.match(source, /deformationFlags : vec4<f32>/);
  assert.match(source, /@group\(3\) @binding\(0\).*skin/s);
  assert.match(source, /@builtin\(instance_index\) instanceIndex/);
});

test('motion evaluates current and previous morph and skin state symmetrically', () => {
  const source = passes.find(([id]) => id === 'motion-vector')[1];
  assert.match(source, /object\.currentMorphWeights/);
  assert.match(source, /object\.previousMorphWeights/);
  assert.match(source, /skinMotionPosition\(currentLocal, joints, weights, false\)/);
  assert.match(source, /skinMotionPosition\(previousLocal, joints, weights, true\)/);
  assert.match(source, /previousViewProjection \* object\.previousModel/);
});
