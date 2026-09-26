import assert from 'node:assert/strict';
import test from 'node:test';
import { importEngineSource } from './helpers/internal-source.mjs';
const { DeferredLightTable, createDeferredReferenceView, validateDeferredView } = await importEngineSource('frame/DeferredLightTable.ts');
const { getDeferredWorldLights } = await importEngineSource('frame/DeferredWorldLights.ts');
const { getSceneRenderEnvironment } = await importEngineSource('frame/SceneRenderEnvironment.ts');
const { Entity } = await importEngineSource('ecs/Entity.ts');
const { World } = await importEngineSource('ecs/World.ts');
const { PointLight } = await importEngineSource('lighting/PointLight.ts');

function candidate(id, type = 2, options = {}) {
  return { id, shadow: null, info: { type, intensity: 2, color: [.25, .5, 1], direction: [0, -2, 0], position: [1, 2, 3], range: 4, ...options } };
}

for (const count of [0, 1, 8, 9, 32, 128, 256, 1024]) test(`complete source and reference view retain every one of ${count} points`, () => {
  const points = Array.from({ length: count }, (_, i) => candidate(2 ** 40 + i));
  const source = new DeferredLightTable().update([...points, candidate(2, 1), candidate(3, 0)], []);
  assert.equal(source.stats.pointCount, count);
  assert.equal(source.stats.directionalCount, 1);
  assert.equal(source.stats.ambientCount, 1);
  assert.equal(source.stats.candidateCount, source.stats.rejectedCount + source.stats.pointCount + source.stats.directionalCount + source.stats.ambientCount);
  const bytes = new DataView(source.bytes);
  assert.deepEqual([0, 4, 8, 12].map(i => bytes.getUint32(i, true)), [1, source.generation, count, 1]);
  assert.deepEqual([48, 52, 56, 60].map(i => bytes.getUint32(16 + i, true)), [1, 1, 0xffffffff, 0]);
  assert.equal(bytes.getFloat32(16 + 36, true), -1, 'direction is normalized');
  if (count) {
    const last = 16 + 64 * count;
    assert.equal(bytes.getFloat32(last + 12, true), 4);
    assert.equal(bytes.getFloat32(last + 16, true), .5);
    assert.equal(bytes.getUint32(last + 52, true), count + 1, 'GPU ID never truncates the large entity ID');
  }
  const view = createDeferredReferenceView(source);
  validateDeferredView(view, source);
  assert.deepEqual([...view.pointIndices], Array.from({ length: count }, (_, i) => i));
  assert.deepEqual(source.ambientRadiance, [.5, 1, 2]);
});

test('source is shared when unchanged; updates cannot mutate an already encoded snapshot', () => {
  const table = new DeferredLightTable(), a = candidate(10), b = candidate(20);
  const first = table.update([a, b], []), copy = first.bytes.slice(0);
  const oldView = createDeferredReferenceView(first);
  assert.equal(table.update([b, a], []), first);
  b.info.color[0] = .75;
  b.info.range = 10;
  const next = table.update([a, b], []);
  assert.equal(next.generation, first.generation + 1);
  assert.deepEqual(first.bytes, copy);
  assert.deepEqual(next.records.map(r => r.identity[1]), first.records.map(r => r.identity[1]));
  assert.throws(() => validateDeferredView(oldView, next), /Stale/);
  const removed = table.update([b], []);
  const readded = table.update([a, b], []);
  assert.equal(removed.records[0].identity[1], first.records[1].identity[1]);
  assert.notEqual(readded.records[0].identity[1], first.records[0].identity[1], 'removed identity is never reused');
});

test('capacities reject explicitly; ambient and shadow slots do not consume the point quota', () => {
  const table = new DeferredLightTable();
  assert.throws(() => table.update(Array.from({ length: 1025 }, (_, i) => candidate(i)), []), { code: 'E_DEFERRED_LIGHTING_CAPABILITY', reason: 'point-capacity' });
  assert.throws(() => table.update(Array.from({ length: 9 }, (_, i) => candidate(i, 1)), []), { reason: 'directional-capacity' });
  const sun = candidate(10, 1); sun.shadow = {};
  const source = table.update([sun, candidate(11, 1), candidate(12, 0), candidate(13, 2, { intensity: NaN })], [sun.shadow]);
  assert.deepEqual(source.records.map(r => r.identity[2]), [0, 0xffffffff]);
  assert.equal(source.stats.rejectedCount, 1);
  assert.throws(() => table.update([candidate(1), candidate(1)], []), /distinct/);
});

test('malformed view indices and headers fail before recording', () => {
  const source = new DeferredLightTable().update([candidate(1), candidate(2)], []);
  const view = createDeferredReferenceView(source);
  view.pointIndices[1] = 0;
  assert.throws(() => validateDeferredView(view, source), /duplicate/);
  view.pointIndices[1] = 2;
  assert.throws(() => validateDeferredView(view, source), /index/);
  new DataView(view.header).setUint32(4, 1, true);
  assert.throws(() => validateDeferredView(view, source), /header/);
});

test('World extraction uses the untruncated source and honors disabled hierarchy and phase changes', () => {
  const world = new World();
  const entities = Array.from({ length: 256 }, () => new Entity().addComponent(new PointLight()));
  for (const entity of entities) world.add(entity);
  const disabled = new Entity(); disabled.disabled = true;
  const child = new Entity().addComponent(new PointLight());
  disabled.addChild(child); world.add(disabled); world.add(child);
  world.frameData.begin(world, null, 1, .016);
  assert.equal(getSceneRenderEnvironment(world.frameData, world).pbrLights.length, 8);
  const source = getDeferredWorldLights(world.frameData, world);
  assert.equal(source.stats.pointCount, 256);
  assert.equal(getDeferredWorldLights(world.frameData, world), source);
  entities[255].getComponent(PointLight).intensity = 5;
  world.frameData.advancePhase();
  const changed = getDeferredWorldLights(world.frameData, world);
  assert.notEqual(changed.generation, source.generation, 'late light beyond Forward slots is updated');
  entities[0].disabled = true;
  world.frameData.advancePhase();
  assert.equal(getDeferredWorldLights(world.frameData, world).stats.pointCount, 255);
});
