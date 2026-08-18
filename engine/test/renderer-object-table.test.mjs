import test from 'node:test';
import assert from 'node:assert/strict';
import { RendererObjectTable } from '../dist/renderer.js';

globalThis.GPUBufferUsage ??= {
  COPY_DST: 1 << 2,
  STORAGE: 1 << 3,
};

function createDevice() {
  const writes = [];
  const buffers = [];
  const device = {
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) {
        writes.push({
          buffer,
          offset,
          dataOffset: dataOffset ?? 0,
          size: size ?? data.byteLength,
        });
      },
      onSubmittedWorkDone() {
        return Promise.resolve();
      },
    },
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup(descriptor) {
      return { descriptor };
    },
  };
  return { device, writes, buffers };
}

function createTable({
  slotCount = 12,
  floatsPerSlot = 4,
  writeCallCostBytes,
  maxUploadExpansionRatio,
} = {}) {
  const audit = createDevice();
  const table = new RendererObjectTable({
    device: audit.device,
    bindGroupLayout: {},
    label: 'object-table.test',
    floatsPerSlot,
    ...(writeCallCostBytes === undefined ? {} : { writeCallCostBytes }),
    ...(maxUploadExpansionRatio === undefined ? {} : { maxUploadExpansionRatio }),
  });
  for (let slot = 0; slot < slotCount; slot++) table.allocateSlot();
  audit.writes.length = 0;
  return { table, ...audit };
}

function changeSlots(table, slots) {
  for (const slot of slots) {
    table.data[slot * table.floatsPerSlot] += 1;
    table.writeSlot(slot);
  }
}

test('RendererObjectTable uploads consecutive dirty slots as one exact range', () => {
  const { table, writes } = createTable();
  changeSlots(table, [5, 3, 4]);

  const stats = { ...table.flushUploads() };

  assert.deepEqual(writes.map(({ offset, size }) => [offset, size]), [
    [3 * table.bytesPerSlot, 3 * table.bytesPerSlot],
  ]);
  assert.deepEqual(stats, {
    dirtySlotCount: 3,
    uploadRangeCount: 1,
    uploadedSlotCount: 3,
    wholeTableUpload: false,
  });
  table.destroy();
});

test('RendererObjectTable merges a cheap clean gap and splits an expensive one', () => {
  const { table, writes } = createTable({ slotCount: 202 });
  changeSlots(table, [200, 1, 3]);

  const stats = { ...table.flushUploads() };

  assert.deepEqual(writes.map(({ offset, size }) => [offset, size]), [
    [table.bytesPerSlot, 3 * table.bytesPerSlot],
    [200 * table.bytesPerSlot, table.bytesPerSlot],
  ]);
  assert.deepEqual(stats, {
    dirtySlotCount: 3,
    uploadRangeCount: 2,
    uploadedSlotCount: 4,
    wholeTableUpload: false,
  });
  table.destroy();
});

test('RendererObjectTable weighs clean gap bytes using the actual slot stride', () => {
  const narrow = createTable({
    slotCount: 100,
    floatsPerSlot: 4,
    maxUploadExpansionRatio: 100,
  });
  changeSlots(narrow.table, [0, 64]);
  const narrowStats = { ...narrow.table.flushUploads() };
  assert.equal(narrowStats.uploadRangeCount, 1);
  assert.equal(narrowStats.uploadedSlotCount, 65);

  const wide = createTable({
    slotCount: 100,
    floatsPerSlot: 8,
    maxUploadExpansionRatio: 100,
  });
  changeSlots(wide.table, [0, 64]);
  const wideStats = { ...wide.table.flushUploads() };
  assert.equal(wideStats.uploadRangeCount, 2);
  assert.equal(wideStats.uploadedSlotCount, 2);

  narrow.table.destroy();
  wide.table.destroy();
});

test('RendererObjectTable caps clean-slot overupload while retaining cheap local merges', () => {
  const { table } = createTable({
    slotCount: 100,
    maxUploadExpansionRatio: 2,
  });
  changeSlots(table, [0, 2, 64]);
  const stats = { ...table.flushUploads() };
  assert.equal(stats.uploadRangeCount, 2);
  assert.equal(stats.uploadedSlotCount, 4);
  assert.ok(stats.uploadedSlotCount <= stats.dirtySlotCount * 2);
  table.destroy();
});

test('RendererObjectTable promotes only a no-more-expensive complete used-table upload', () => {
  const complete = createTable({ slotCount: 10 });
  changeSlots(complete.table, [9, 0, 5, 1, 8, 2, 7, 3, 6, 4]);
  const completeStats = { ...complete.table.flushUploads() };
  assert.deepEqual(completeStats, {
    dirtySlotCount: 10,
    uploadRangeCount: 1,
    uploadedSlotCount: 10,
    wholeTableUpload: true,
  });

  const sparse = createTable({ slotCount: 10 });
  changeSlots(sparse.table, [1, 4]);
  const sparseStats = { ...sparse.table.flushUploads() };
  assert.equal(sparseStats.wholeTableUpload, false);
  assert.equal(sparseStats.uploadedSlotCount, 4);

  complete.table.destroy();
  sparse.table.destroy();
});

test('RendererObjectTable skips equal values and does not flush object data twice for two views', () => {
  const { table, writes } = createTable({ slotCount: 2 });
  table.data.set([1, 2, 3, 4], 0);
  table.writeSlot(0);
  table.flushUploads();
  assert.equal(writes.length, 1);

  table.beginUploads();
  table.data.set([1, 2, 3, 4], 0);
  table.writeSlot(0);
  assert.equal(table.dirtySlotCount, 0);
  table.flushUploads();
  assert.equal(writes.length, 1);

  table.data[1] = 9;
  table.writeSlot(0);
  table.flushUploads();
  assert.equal(writes.length, 2);

  table.beginUploads();
  table.writeSlot(0);
  table.flushUploads();
  assert.equal(writes.length, 2);
  table.destroy();
});

test('RendererObjectTable uses the visited-span shortcut only for contiguous fully dirty slots', () => {
  const { table, writes } = createTable({
    slotCount: 0,
    writeCallCostBytes: 0,
  });
  table.ensureCapacity(8);
  writes.length = 0;
  const frameA = {};
  table.beginUploads(frameA);
  changeSlots(table, [3, 4, 5]);

  const denseStats = { ...table.flushUploads() };
  assert.deepEqual(writes.map(({ offset, size }) => [offset, size]), [
    [3 * table.bytesPerSlot, 3 * table.bytesPerSlot],
  ]);
  assert.deepEqual(denseStats, {
    dirtySlotCount: 3,
    uploadRangeCount: 1,
    uploadedSlotCount: 3,
    wholeTableUpload: true,
  });

  table.beginUploads(frameA);
  for (const slot of [3, 4, 5]) table.writeSlot(slot);
  assert.equal(table.dirtySlotCount, 0);
  table.flushUploads();
  assert.equal(writes.length, 1, 'a second view must not upload unchanged object data');

  table.beginUploads({});
  table.data[1 * table.floatsPerSlot] += 1;
  table.writeSlot(1);
  table.data[4 * table.floatsPerSlot] += 1;
  table.writeSlot(4);
  table.data[7 * table.floatsPerSlot] += 1;
  table.writeSlot(7);
  const sparseStats = { ...table.flushUploads() };
  assert.deepEqual(writes.slice(-3).map(({ offset, size }) => [offset, size]), [
    [1 * table.bytesPerSlot, table.bytesPerSlot],
    [4 * table.bytesPerSlot, table.bytesPerSlot],
    [7 * table.bytesPerSlot, table.bytesPerSlot],
  ]);
  assert.deepEqual(sparseStats, {
    dirtySlotCount: 3,
    uploadRangeCount: 3,
    uploadedSlotCount: 3,
    wholeTableUpload: false,
  });
  table.destroy();
});

test('RendererObjectTable growth commits the replacement buffer and retires the previous buffer after submit', async () => {
  const { table, writes, device } = createTable({ slotCount: 2 });
  const previousBuffer = table.buffer;
  const afterSubmitCallbacks = [];
  table.beginUploads({
    afterSubmit(callback) {
      afterSubmitCallbacks.push(callback);
    },
  });

  table.data[0] = 42;
  table.writeSlot(0);
  assert.equal(table.dirtySlotCount, 1);
  const writesBeforeGrowth = writes.length;
  table.allocateSlot();
  assert.equal(writes.length, writesBeforeGrowth + 1);
  assert.equal(table.dirtySlotCount, 0);
  assert.equal(previousBuffer.destroyed, false);
  assert.equal(afterSubmitCallbacks.length, 1);

  table.writeSlot(0);
  table.flushUploads();
  assert.equal(writes.length, writesBeforeGrowth + 1);

  table.data[0] = 43;
  table.writeSlot(0);
  table.flushUploads();
  assert.equal(writes.length, writesBeforeGrowth + 2);

  afterSubmitCallbacks[0](device.queue);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(previousBuffer.destroyed, true);
  table.destroy();
});

test('RendererObjectTable keeps validating the legacy fixed-gap override', () => {
  const { device } = createDevice();
  assert.throws(() => new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'invalid.object-table',
    floatsPerSlot: 4,
    mergeGapSlots: -1,
  }), /mergeGapSlots/);
  assert.throws(() => new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'invalid.object-table',
    floatsPerSlot: 4,
    writeCallCostBytes: -1,
  }), /writeCallCostBytes/);
  assert.throws(() => new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'invalid.object-table',
    floatsPerSlot: 4,
    maxUploadExpansionRatio: 0.5,
  }), /maxUploadExpansionRatio/);
  assert.throws(() => new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'invalid.object-table',
    floatsPerSlot: 4,
    mergeGapSlots: 4,
    writeCallCostBytes: 1024,
  }), /mutually exclusive/);
});
