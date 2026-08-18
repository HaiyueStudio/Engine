import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ids = ['gpu-draw-command', 'gpu-sort-bitonic', 'instanced-cull', 'instanced-depth-sort-key', 'mesh3d-cull'];
const passes = new Map(await Promise.all(ids.map(async id => [id, await readFile(new URL(`../src/shaders/generated/compute-${id}.generated.wgsl`, import.meta.url), 'utf8')]))) ;

test('production compute passes share generated family provenance and explicit ABI markers', () => {
  const hashes = new Set();
  for (const [id, source] of passes) {
    assert.match(source, /haiyue:compute-abi 1/, id);
    assert.match(source, /haiyue:compute-ir [a-f0-9]{64}/, id);
    const hash = source.match(/haiyue:compute-module ([a-f0-9]{64})/)?.[1];
    assert.ok(hash, id);
    hashes.add(hash);
    assert.match(source, /@compute @workgroup_size\(64\)/, id);
  }
  assert.equal(hashes.size, 1);
});

test('generated compute behavior retains indirect writes, atomic culling and bitonic scheduling', () => {
  assert.match(passes.get('gpu-draw-command'), /indexedIndirect\[indexedBase \+ 4u\] = command\.firstInstance/);
  assert.match(passes.get('gpu-sort-bitonic'), /let ixj = i \^ params\.j/);
  assert.match(passes.get('instanced-cull'), /atomicAdd\(&counter\.value, 1u\)/);
  assert.match(passes.get('instanced-depth-sort-key'), /sortKeys\[index\] = 0xffffffffu/);
  assert.match(passes.get('mesh3d-cull'), /drawIndirect\[batchIndex \* 4u \+ 1u\] = instanceCount/);
});
