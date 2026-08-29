import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ids = [
  'pbr', 'pbr-clearcoat', 'pbr-transmission', 'pbr-transmission-clearcoat', 'blinn-phong', 'toon',
];
const passes = new Map(await Promise.all(ids.map(async id => [
  id,
  await readFile(new URL(`../src/shaders/generated/material-lighting-${id}.generated.wgsl`, import.meta.url), 'utf8'),
])));

test('all production lighting passes share one generated module identity', () => {
  const hashes = new Set();
  for (const [id, source] of passes) {
    assert.match(source, /haiyue:material-lighting-abi 1/, id);
    const hash = source.match(/haiyue:material-lighting-module ([a-f0-9]{64})/)?.[1];
    assert.ok(hash, id);
    hashes.add(hash);
  }
  assert.equal(hashes.size, 1);
});

test('PBR variants preserve one deformation ABI and specialize only clearcoat/transmission', () => {
  const deformationHashes = new Set();
  for (const id of ids.slice(0, 4)) {
    const source = passes.get(id);
    deformationHashes.add(source.match(/haiyue:deformation-module ([a-f0-9]{64})/)?.[1]);
    assert.doesNotMatch(source, /\b(?:MAX_LIGHTS|MAX_DIRECTIONAL_SHADOWS|CLEARCOAT_ENABLED|TRANSMISSION_ENABLED)\b/);
    assert.match(source, /@group\(3\) @binding\(8\) var<storage, read> skin/);
    assert.match(source, /morphWeights : vec4<f32>/);
    assert.match(source, /deformationFlags : vec4<f32>/);
  }
  assert.equal(deformationHashes.size, 1);
  assert.match(passes.get('pbr'), /if \(false\)/);
  assert.match(passes.get('pbr-clearcoat'), /if \(true\)/);
  assert.match(passes.get('pbr-transmission'), /if \(true && transmission > 0\.0\)/);
});

test('Blinn and Toon share the eight-light and post-lighting Fog contract', () => {
  const blinn = passes.get('blinn-phong');
  const toon = passes.get('toon');
  assert.match(blinn, /array<LightData, 8u>/);
  assert.match(toon, /array<LightData, 8u>/);
  assert.match(blinn, /let mapped = outColor \/ \(outColor \+ vec3<f32>\(1\.0\)\)/);
  assert.match(blinn, /let displayColor = pow\(mapped, vec3<f32>\(1\.0 \/ 2\.2\)\)/);
  assert.match(blinn, /applyFog\(displayColor/);
  assert.match(toon, /applyFog\(color/);
  assert.match(toon, /array<DirectionalShadowData, 1u>/);
});
