import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ids = [
  'instanced-mesh3d', 'line3d', 'planar-mirror', 'volume',
  'texture-convolution', 'mipmap', 'equirectangular-to-cube',
];
const passes = new Map(await Promise.all(ids.map(async id => [
  id,
  await readFile(new URL(`../src/shaders/generated/specialized-${id}.generated.wgsl`, import.meta.url), 'utf8'),
])));

test('all specialized production passes share one generated family identity', () => {
  const hashes = new Set();
  for (const [id, source] of passes) {
    assert.match(source, /haiyue:specialized-rendering-abi 1/, id);
    const hash = source.match(/haiyue:specialized-rendering-module ([a-f0-9]{64})/)?.[1];
    assert.ok(hash, id);
    hashes.add(hash);
  }
  assert.equal(hashes.size, 1);
});

test('instanced and line specializations are resolved before runtime', () => {
  const instanced = passes.get('instanced-mesh3d');
  const line = passes.get('line3d');
  assert.doesNotMatch(instanced, /\bMAX_LIGHTS\b/);
  assert.match(instanced, /min\(lights\.countVec\.x, 8u\)/);
  assert.doesNotMatch(line, /\b(?:CAP_SEGS|VERTS_PER_SEG)\b/);
  assert.match(line, /let capVertCount = 8u \* 3u/);
  assert.match(line, /let corner\s*= vi % 54u/);
});

test('scene-frame passes and fixed texture utilities retain their reviewed behavior', () => {
  assert.match(passes.get('planar-mirror'), /textureSampleLevel\(reflectionTexture/);
  assert.match(passes.get('volume'), /for \(var i = 0; i < 192/);
  assert.match(passes.get('mipmap'), /textureSample\(sourceTexture/);
  assert.match(passes.get('equirectangular-to-cube'), /cubeDirection\(input\.faceIndex/);
  assert.match(passes.get('texture-convolution'), /@workgroup_size\(8, 8\)/);
});
