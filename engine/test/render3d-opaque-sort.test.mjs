import test from 'node:test';
import assert from 'node:assert/strict';
import { Render3DOpaqueSorter } from '../dist/experimental.js';

function createItems(count) {
  const items = [];
  for (let index = count - 1; index >= 0; index--) {
    items.push({
      entityId: index + 1,
      viewDepth: ((index * 37) % 101) + (index % 4) * 0.25,
      opaqueSortKey: {
        rendererSlot: (index * 7) % 3,
        materialSlot: (index * 11) % 13,
        geometrySlot: (index * 5) % 17,
        entitySlot: index,
      },
    });
  }
  return items;
}

function expectedOrder(items) {
  return [...items].sort((a, b) => (
    (a.opaqueSortKey.rendererSlot - b.opaqueSortKey.rendererSlot)
    || (a.opaqueSortKey.materialSlot - b.opaqueSortKey.materialSlot)
    || (a.opaqueSortKey.geometrySlot - b.opaqueSortKey.geometrySlot)
    || (a.viewDepth - b.viewDepth)
    || (a.opaqueSortKey.entitySlot - b.opaqueSortKey.entitySlot)
  ));
}

test('Render3DOpaqueSorter uses cached scene keys for small comparison sorts', () => {
  const sorter = new Render3DOpaqueSorter(512);
  const items = createItems(64);
  const expected = expectedOrder(items).map(item => item.entityId);

  sorter.sort(items);

  assert.equal(sorter.stats.mode, 'comparison');
  assert.equal(sorter.stats.itemCount, 64);
  assert.deepEqual(items.map(item => item.entityId), expected);
});

test('Render3DOpaqueSorter radix path matches lexicographic scene-key and view-depth order', () => {
  const sorter = new Render3DOpaqueSorter(512);
  const items = createItems(1_024);
  const originalItems = new Set(items);
  const expected = expectedOrder(items).map(item => item.entityId);

  sorter.sort(items);

  assert.equal(sorter.stats.mode, 'radix');
  assert.equal(sorter.stats.itemCount, 1_024);
  assert.deepEqual(items.map(item => item.entityId), expected);
  assert.equal(items.every(item => originalItems.has(item)), true, 'radix sorting only reorders pooled render-item objects');
});

test('Render3DOpaqueSorter can prioritize contiguous scene object slots for instancing', () => {
  for (const threshold of [512, 2]) {
    const sorter = new Render3DOpaqueSorter(threshold);
    const items = createItems(64);
    const expected = [...items].sort((a, b) => (
      (a.opaqueSortKey.rendererSlot - b.opaqueSortKey.rendererSlot)
      || (a.opaqueSortKey.materialSlot - b.opaqueSortKey.materialSlot)
      || (a.opaqueSortKey.geometrySlot - b.opaqueSortKey.geometrySlot)
      || (a.opaqueSortKey.entitySlot - b.opaqueSortKey.entitySlot)
      || (a.viewDepth - b.viewDepth)
    )).map(item => item.entityId);

    sorter.sort(items, true);

    assert.deepEqual(items.map(item => item.entityId), expected);
  }
});
