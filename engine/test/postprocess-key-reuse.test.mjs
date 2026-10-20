import test from 'node:test';
import assert from 'node:assert/strict';
import { importEngineSource } from './helpers/internal-source.mjs';
const { PostProcessGraph, registerPostProcessGraphAccess } = await importEngineSource('postprocess/PostProcessGraph.ts');

test('postprocess stable keys rebind instances and observe changing live contracts and all auxiliary requirements', () => {
  const graph = new PostProcessGraph(), first = { label: 'color' }, last = { label: 'output' };
  let readsColor = true, sideEffect = false;
  registerPostProcessGraphAccess(first, () => ({ readsColor: true, sideEffect: false }));
  registerPostProcessGraphAccess(last, () => ({ readsColor, sideEffect }));
  assert.deepEqual(graph.compile([first, last]), [first, last]);
  const keys = [...graph.accessKeys];
  const replacement = { ...last }; registerPostProcessGraphAccess(replacement, () => ({ readsColor, sideEffect }));
  assert.deepEqual(graph.compile([first, replacement]), [first, replacement]);
  assert.equal(graph.accessKeys[0], keys[0]); assert.equal(graph.accessKeys[1], keys[1]);
  readsColor = false; assert.deepEqual(graph.compile([first, replacement]), [replacement]);
  let misses = graph.cache.stats.misses;
  for (const name of ['needsDepthTexture','needsNormalTexture','needsMotionTexture','needsOutlineMask']) {
    replacement[name] = true; graph.compile([first, replacement]); assert.equal(graph.cache.stats.misses, ++misses);
  }
  sideEffect = true; graph.compile([first, replacement]); assert.equal(graph.cache.stats.misses, ++misses);
  replacement.label = 'renamed'; graph.compile([first, replacement]); assert.equal(graph.cache.stats.misses, ++misses);
  graph.setCacheScope({}, 'view'); graph.compile([first, replacement]); assert.equal(graph.cache.stats.misses, ++misses);
  assert.deepEqual(graph.compile([]), []); assert.deepEqual(graph.compile([replacement]), [replacement]);
  graph.clearCache(); assert.equal(graph.serializedKey, undefined); assert.equal(graph.accessKeys.length, 0);
});

test('postprocess rechecks requirement getters once per compile and honors disabled cache', () => {
  const graph = new PostProcessGraph(); let reads = 0;
  const pass = { label: 'dynamic', get needsDepthTexture() { reads++; return true; } };
  graph.compile([pass]); graph.compile([pass]); graph.cache.enabled = false; graph.compile([pass]);
  assert.equal(reads, 3); assert.equal(graph.cache.stats.hits, 1); assert.equal(graph.cache.stats.misses, 2);
  assert.ok(graph.resourceLifetimes.some(r => r.name === 'linear-depth'));
});

test('throwing custom requirement cannot leave a stale serialized key for the next compile', () => {
  const graph = new PostProcessGraph(), producer = { label: 'producer' }, output = { label: 'output' };
  let readsColor = true, broken = false;
  registerPostProcessGraphAccess(producer, () => ({ readsColor: true, sideEffect: false }));
  registerPostProcessGraphAccess(output, () => ({ readsColor, sideEffect: false }));
  const tail = { label: 'tail', get needsDepthTexture() { if (broken) throw Error('custom getter'); return false; } };
  graph.compile([producer, output, tail]); readsColor = false; broken = true;
  assert.throws(() => graph.compile([producer, output, tail]), /custom getter/);
  broken = false;
  assert.deepEqual(graph.compile([producer, output, tail]), [output, tail]);
  assert.equal(graph.stats.culledPassCount, 1);
});
