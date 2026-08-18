import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BasicMaterial,
  Geometry3D,
  PbrMaterial,
} from '../dist/index.js';
import { ClippingPlanes } from '../dist/components.js';
import {
  BlinnPhongMaterial,
  DepthMaterial,
  NormalMaterial,
} from '../dist/material.js';
import { Mesh3DRenderer } from '../dist/experimental.js';
import {
  ObjectTableSlotAllocator,
  BlinnPhongRenderer,
  DepthRenderer,
  NormalRenderer,
  PbrRenderer,
  RendererCacheMap,
  RendererObjectSlotCache,
  RendererObjectTable,
  RendererPipelineLayoutCache,
  RendererResourceCache,
  disposeSharedGeometry3DGPUCache,
  getSharedGeometry3DGPUCache,
} from '../dist/renderer.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    VERTEX: 1 << 0,
    INDEX: 1 << 1,
    COPY_DST: 1 << 2,
    STORAGE: 1 << 3,
  };
}

function createGeometryCacheDevice(log = []) {
  ensureGpuConstants();
  return {
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) {
        log.push(['writeBuffer', buffer.label ?? null, offset, dataOffset ?? 0, size ?? data.byteLength ?? data.length]);
      },
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
    createBuffer(descriptor) {
      const buffer = {
        label: descriptor.label,
        descriptor,
        destroyed: false,
        destroy() {
          if (!this.destroyed) log.push(['destroyBuffer', descriptor.usage, descriptor.size]);
          this.destroyed = true;
        },
      };
      log.push(['createBuffer', descriptor.usage, descriptor.size]);
      return buffer;
    },
    createPipelineLayout(descriptor) {
      const layout = { descriptor, id: log.filter(item => item[0] === 'createPipelineLayout').length + 1 };
      log.push(['createPipelineLayout', descriptor.bindGroupLayouts.length, layout.id]);
      return layout;
    },
    createBindGroup(descriptor) {
      const bindGroup = { descriptor, id: log.filter(item => item[0] === 'createBindGroup').length + 1 };
      log.push(['createBindGroup', descriptor.entries.length, bindGroup.id]);
      return bindGroup;
    },
  };
}

function attachObjectCore(renderer, stableTable, batchTable, createObject = modelSlot => ({ modelSlot })) {
  const objects = new RendererObjectSlotCache(() => stableTable, createObject);
  const core = {
    uploadsPrepared: false,
    destroyed: false,
    requireObjectTable: () => stableTable,
    requireBatchObjectTable: () => batchTable,
    requireObjects: () => objects,
    flushUploads() {
      stableTable.flushUploads?.();
      batchTable.flushUploads?.();
      this.uploadsPrepared = true;
    },
  };
  renderer.rendererCore = core;
  renderer._rendererCore = core;
  return core;
}

test('ObjectTableSlotAllocator reuses released slots and ignores duplicate release', () => {
  const allocator = new ObjectTableSlotAllocator();

  const a = allocator.allocate();
  const b = allocator.allocate();
  const c = allocator.allocate();
  assert.deepEqual([a, b, c], [0, 1, 2]);
  assert.equal(allocator.highWaterMark, 3);
  assert.equal(allocator.allocatedSlotCount, 3);

  allocator.release(b);
  allocator.release(b);
  assert.equal(allocator.freeSlotCount, 1);
  assert.equal(allocator.allocatedSlotCount, 2);

  assert.equal(allocator.allocate(), b);
  assert.equal(allocator.allocate(), 3);
  assert.equal(allocator.highWaterMark, 4);

  allocator.reset();
  assert.equal(allocator.allocate(), 0);
  assert.equal(allocator.highWaterMark, 1);
});

test('RendererObjectTable grows storage and reuses released slots', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const table = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'test.objectTable',
    floatsPerSlot: 4,
  });

  const a = table.allocateSlot();
  const b = table.allocateSlot();
  const c = table.allocateSlot();
  assert.deepEqual([a, b, c], [0, 1, 2]);
  assert.equal(table.capacity, 4);
  assert.equal(table.bindGroup.descriptor.entries[0].resource.buffer.label, 'test.objectTable');

  table.data.set([1, 2, 3, 4], a * table.floatsPerSlot);
  const writesBeforeSlot = log.filter(item => item[0] === 'writeBuffer').length;
  table.writeSlot(a);
  assert.equal(table.dirtySlotCount, 1);
  assert.equal(log.filter(item => item[0] === 'writeBuffer').length, writesBeforeSlot);
  table.flushUploads();
  assert.deepEqual(log.at(-1), ['writeBuffer', 'test.objectTable', 0, 0, table.bytesPerSlot]);

  const writesBeforeDeferredBatch = log.filter(item => item[0] === 'writeBuffer').length;
  table.beginUploads();
  table.data[a * table.floatsPerSlot] = 5;
  table.data[c * table.floatsPerSlot] = 7;
  table.writeSlot(a);
  table.writeSlot(c);
  assert.equal(log.filter(item => item[0] === 'writeBuffer').length, writesBeforeDeferredBatch);
  table.flushUploads();
  assert.deepEqual(log.at(-1), ['writeBuffer', 'test.objectTable', 0, 0, table.bytesPerSlot * 3]);

  table.releaseSlot(b);
  assert.equal(table.allocateSlot(), b);

  const d = table.allocateSlot();
  const e = table.allocateSlot();
  assert.deepEqual([d, e], [3, 4]);
  assert.equal(table.capacity, 8);
  assert.equal(log.filter(item => item[0] === 'createBuffer').length, 4);

  table.destroy();
  assert.equal(log.filter(item => item[0] === 'destroyBuffer').length, 4);
});

test('RendererObjectTable sorts sparse slots, merges contiguous ranges, and promotes high churn to a whole-table upload', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const table = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'ranges.objectTable',
    floatsPerSlot: 4,
    wholeTableUploadThreshold: 0.5,
    mergeGapSlots: 0,
  });
  for (let index = 0; index < 10; index++) table.allocateSlot();

  const sparseStart = log.length;
  for (const slot of [8, 3, 2, 6, 3]) {
    table.data[slot * table.floatsPerSlot] += 1;
    table.writeSlot(slot);
  }
  const sparseStats = { ...table.flushUploads() };
  const sparseWrites = log.slice(sparseStart).filter(item => item[0] === 'writeBuffer');
  assert.deepEqual(sparseWrites, [
    ['writeBuffer', 'ranges.objectTable', 2 * table.bytesPerSlot, 2 * table.bytesPerSlot, 2 * table.bytesPerSlot],
    ['writeBuffer', 'ranges.objectTable', 6 * table.bytesPerSlot, 6 * table.bytesPerSlot, table.bytesPerSlot],
    ['writeBuffer', 'ranges.objectTable', 8 * table.bytesPerSlot, 8 * table.bytesPerSlot, table.bytesPerSlot],
  ]);
  assert.deepEqual(sparseStats, {
    dirtySlotCount: 4,
    uploadRangeCount: 3,
    uploadedSlotCount: 4,
    wholeTableUpload: false,
  });

  const fullStart = log.length;
  for (const slot of [9, 7, 5, 3, 1, 8, 6, 4, 2, 0]) {
    table.data[slot * table.floatsPerSlot] += 100;
    table.writeSlot(slot);
  }
  const fullStats = { ...table.flushUploads() };
  assert.deepEqual(log.slice(fullStart).filter(item => item[0] === 'writeBuffer'), [
    ['writeBuffer', 'ranges.objectTable', 0, 0, 10 * table.bytesPerSlot],
  ]);
  assert.deepEqual(fullStats, {
    dirtySlotCount: 10,
    uploadRangeCount: 1,
    uploadedSlotCount: 10,
    wholeTableUpload: true,
  });
  table.destroy();
});

test('RendererObjectTable skips value-identical slot uploads across views', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const table = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'stable.objectTable',
    floatsPerSlot: 4,
  });
  const slot = table.allocateSlot();
  table.data.set([1, 2, 3, 4], slot * table.floatsPerSlot);
  table.writeSlot(slot);
  table.flushUploads();
  const writesAfterFirstView = log.filter(item => item[0] === 'writeBuffer').length;

  table.beginUploads();
  table.data.set([1, 2, 3, 4], slot * table.floatsPerSlot);
  table.writeSlot(slot);
  assert.equal(table.dirtySlotCount, 0);
  table.flushUploads();
  assert.equal(log.filter(item => item[0] === 'writeBuffer').length, writesAfterFirstView);

  table.data[slot * table.floatsPerSlot + 2] = 9;
  table.writeSlot(slot);
  table.flushUploads();
  assert.equal(log.filter(item => item[0] === 'writeBuffer').length, writesAfterFirstView + 1);
  table.destroy();
});

test('RendererObjectTable retires grown buffers only after frame submission completes', async () => {
  const device = createGeometryCacheDevice();
  const afterSubmitCallbacks = [];
  const context = { afterSubmit(callback) { afterSubmitCallbacks.push(callback); } };
  const table = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'retire.objectTable',
    floatsPerSlot: 4,
  });
  table.ensureCapacity(1);
  const previous = table.buffer;
  table.beginUploads(context);
  table.ensureCapacity(2);

  assert.equal(previous.destroyed, false);
  assert.equal(afterSubmitCallbacks.length, 1);
  afterSubmitCallbacks[0](device.queue);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(previous.destroyed, true);
  table.destroy();
});

test('RendererCacheMap owns keyed resource release and clear', () => {
  const destroyed = [];
  const cache = new RendererCacheMap(value => destroyed.push(value.label));

  assert.equal(cache.ensure(1, () => ({ label: 'a' })).label, 'a');
  assert.equal(cache.ensure(1, () => ({ label: 'a2' })).label, 'a');
  cache.set(2, { label: 'b' });
  cache.set(2, { label: 'b2' });
  assert.deepEqual(destroyed, ['b']);

  cache.releaseNotIn(new Set([1]));
  assert.deepEqual(destroyed, ['b', 'b2']);
  assert.equal(cache.size, 1);

  cache.clear();
  assert.deepEqual(destroyed, ['b', 'b2', 'a']);
  assert.equal(cache.size, 0);
});

test('RendererObjectSlotCache releases object table slots through cache lifecycle', () => {
  const device = createGeometryCacheDevice();
  const table = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'slot-cache.objectTable',
    floatsPerSlot: 4,
  });
  const cache = new RendererObjectSlotCache(() => table, modelSlot => ({
    modelSlot,
    snapshot: new Float32Array(16),
  }));

  const a = cache.ensure(10);
  const b = cache.ensure(20);
  assert.deepEqual([a.modelSlot, b.modelSlot], [0, 1]);
  assert.equal(cache.ensure(10), a);

  cache.release(10);
  assert.equal(cache.ensure(30).modelSlot, 0);

  cache.releaseNotIn(new Set([30]));
  assert.equal(cache.ensure(40).modelSlot, 1);

  cache.clear();
  assert.equal(cache.ensure(50).modelSlot, 1);
  table.destroy();
});

test('Mesh3DRenderer keeps frame batch slots out of the stable entity object table', () => {
  const renderer = new Mesh3DRenderer();
  const stableTable = { label: 'stable' };
  const batchTable = { label: 'batch' };
  attachObjectCore(renderer, stableTable, batchTable);
  renderer.sceneFrameBinding = { bindGroup: {} };

  const routedTables = [];
  const routedSlots = [];
  const boundTables = [];
  const firstInstances = [];
  renderer._ensureBatchMaterialData = () => ({ bindGroup: {} });
  renderer._ensureGeometryEntityResources = (_entityId, _geometry, _clippingPlanes, _worldMatrix, slot, table) => {
    routedSlots.push(slot);
    routedTables.push(table);
    return { geoData: { skinned: false }, entData: {} };
  };
  renderer._getOpaquePipeline = () => ({});
  renderer._bindGeometry = (_pass, _geometry, _entity, table) => boundTables.push(table);
  renderer._drawBatch = (_pass, _geometry, _batchBuffer, batchIndex) => firstInstances.push(batchIndex);

  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new BasicMaterial();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const pass = { setBindGroup() {}, setPipeline() {} };
  const sourceItems = [
    { entityId: 0, geometry: null, material: null, worldMatrix: null },
    { entityId: 0, geometry: null, material: null, worldMatrix: null },
    { entityId: 101, geometry, material, worldMatrix: identity },
    { entityId: 102, geometry, material, worldMatrix: identity },
  ];
  renderer.renderBatch(pass, sourceItems, 2, 2, { getObjectSlot: batchIndex => batchIndex + 10 });

  assert.deepEqual(routedTables, [batchTable, batchTable]);
  assert.deepEqual(boundTables, [batchTable, batchTable]);
  assert.equal(routedTables.includes(stableTable), false);
  assert.deepEqual(routedSlots, [12, 13]);
  assert.deepEqual(firstInstances, [2, 3]);
});

test('Mesh3DRenderer collapses contiguous portable batches into instanced draws', () => {
  const renderer = new Mesh3DRenderer();
  attachObjectCore(renderer, {}, { bindGroup: {} });
  renderer.sceneFrameBinding = { bindGroup: {} };
  renderer._ensureBatchMaterialData = () => ({ bindGroup: {} });
  renderer._ensureGeometryEntityResources = () => ({
    geoData: {
      skinned: false,
      indexBuf: {},
      indexFormat: 'uint16',
      indexCount: 3,
    },
    entData: {},
  });
  renderer._getOpaquePipeline = () => ({});
  renderer._bindGeometry = () => {};

  const draws = [];
  const pass = {
    setBindGroup() {},
    setPipeline() {},
    setIndexBuffer() {},
    drawIndexed(...args) { draws.push(args); },
  };
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new BasicMaterial();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const items = [1, 2, 3, 4].map(entityId => ({ entityId, geometry, material, worldMatrix: identity }));
  const slots = [10, 11, 15, 16];

  renderer.renderBatch(pass, items, 0, items.length, {
    gpuUploadEnabled: false,
    getObjectSlot: index => slots[index],
  });

  assert.deepEqual(draws, [
    [3, 2, 0, 0, 10],
    [3, 2, 0, 0, 15],
  ]);
});

test('Mesh3DRenderer batches additive transparent slots with the blend pipeline and global batch offset', () => {
  const renderer = new Mesh3DRenderer();
  attachObjectCore(renderer, {}, { bindGroup: {} });
  renderer.sceneFrameBinding = { bindGroup: {} };
  renderer._ensureBatchMaterialData = () => ({ bindGroup: {} });
  renderer._ensureGeometryEntityResources = () => ({
    geoData: {
      skinned: false,
      indexBuf: {},
      indexFormat: 'uint16',
      indexCount: 3,
    },
    entData: {},
  });
  renderer._getOpaquePipeline = () => {
    assert.fail('additive transparent batching must not use the opaque pipeline');
  };
  const blendPipelines = [];
  renderer._getBlendPipeline = (mode, geometry, material, depthWrite) => {
    blendPipelines.push([mode, geometry.id, material.id, depthWrite]);
    return { kind: 'additive' };
  };
  renderer._bindGeometry = () => {};

  const pipelines = [];
  const draws = [];
  const pass = {
    setBindGroup() {},
    setPipeline(pipeline) { pipelines.push(pipeline.kind); },
    setIndexBuffer() {},
    drawIndexed(...args) { draws.push(args); },
  };
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new BasicMaterial({ blending: 'additive', depthWrite: false });
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const items = [
    { entityId: 0, geometry: null, material: null, worldMatrix: null },
    { entityId: 1, geometry, material, worldMatrix: identity },
    { entityId: 2, geometry, material, worldMatrix: identity },
  ];
  const requestedBatchIndices = [];

  renderer.renderBatch(pass, items, 1, 2, {
    gpuUploadEnabled: false,
    getObjectSlot(batchIndex) {
      requestedBatchIndices.push(batchIndex);
      return 30 + batchIndex - 8;
    },
  }, false, 8);

  assert.deepEqual(requestedBatchIndices, [8, 9]);
  assert.deepEqual(blendPipelines, [
    ['additive', geometry.id, material.id, false],
  ]);
  assert.deepEqual(pipelines, ['additive']);
  assert.deepEqual(draws, [[3, 2, 0, 0, 30]]);
});

test('Mesh3DRenderer releases a texture result that arrives after renderer destruction', async () => {
  const renderer = new Mesh3DRenderer();
  const owner = { destroyed: false, signal: new AbortController().signal };
  renderer.rendererCore = owner;
  let resolveLoad;
  let releases = 0;
  let bindGroupWrites = 0;
  renderer._loadTexture = () => new Promise(resolve => { resolveLoad = resolve; });
  renderer._rebuildMatBindGroup = () => { bindGroupWrites++; };
  const source = 'late-texture.png';
  const data = { sourceTexture: source };

  const pending = renderer._loadTextureAsync(source, data, 'base');
  owner.destroyed = true;
  resolveLoad({ value: {}, release: () => { releases++; } });
  await pending;

  assert.equal(releases, 1);
  assert.equal(bindGroupWrites, 0);
  assert.equal(data.textureHandle, undefined);
});

test('NormalRenderer merges sparse prepared object slots into one table upload', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const renderer = new NormalRenderer();
  const stableTable = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'normal.stable',
    floatsPerSlot: 32,
    auxiliary: { binding: 1, floatsPerSlot: 36, label: 'normal.stable.clipping' },
  });
  const batchTable = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'normal.batch',
    floatsPerSlot: 32,
    auxiliary: { binding: 1, floatsPerSlot: 36, label: 'normal.batch.clipping' },
  });
  attachObjectCore(renderer, stableTable, batchTable, modelSlot => ({
    modelSlot,
    modelSnapshot: new Float32Array(16),
    objectDirty: true,
    clippingKey: '',
  }));

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const [entityId, slot] of [[1, 10], [2, 11], [3, 13]]) {
    const object = renderer.entityCache.ensure(entityId);
    renderer._writeObjectTableEntry(object, null, identity, slot, renderer.batchObjectTable);
  }

  log.length = 0;
  renderer.flushUploads();
  const writes = log.filter(entry => entry[0] === 'writeBuffer');
  assert.deepEqual(writes, [
    ['writeBuffer', 'normal.batch', 10 * 128, 10 * 128, 4 * 128],
  ]);
});

test('NormalRenderer uploads clipping storage only for semantic plane changes and reuses it across views', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const renderer = new NormalRenderer();
  const stableTable = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'normal.stable',
    floatsPerSlot: 32,
    auxiliary: { binding: 1, floatsPerSlot: 36, label: 'normal.stable.clipping' },
  });
  const batchTable = new RendererObjectTable({
    device,
    bindGroupLayout: {},
    label: 'normal.batch',
    floatsPerSlot: 32,
    auxiliary: { binding: 1, floatsPerSlot: 36, label: 'normal.batch.clipping' },
  });
  attachObjectCore(renderer, stableTable, batchTable, modelSlot => ({
    modelSlot,
    modelSnapshot: new Float32Array(16),
    objectDirty: true,
    clippingKey: '',
  }));
  const object = renderer.entityCache.ensure(17);
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const clipping = new ClippingPlanes([{ normal: [1, 0, 0], constant: -0.5 }]);
  const clippingWrites = () => log.filter(
    entry => entry[0] === 'writeBuffer' && entry[1] === 'normal.stable.clipping',
  );

  log.length = 0;
  renderer._writeObjectTableEntry(object, clipping, identity, undefined, renderer.objectTable);
  renderer.objectTable.flushUploads();
  assert.equal(clippingWrites().length, 1);

  renderer._writeObjectTableEntry(object, clipping, identity, undefined, renderer.objectTable);
  renderer.objectTable.flushUploads();
  assert.equal(clippingWrites().length, 1, 'a second view must reuse unchanged clipping storage');

  clipping.setPlane(0, { normal: [2, 0, 0], constant: -1 });
  renderer._writeObjectTableEntry(object, clipping, identity, undefined, renderer.objectTable);
  renderer.objectTable.flushUploads();
  assert.equal(clippingWrites().length, 1, 'an equivalent normalized plane must not upload');

  clipping.setPlane(0, { normal: [1, 0, 0], constant: -0.25 });
  renderer._writeObjectTableEntry(object, clipping, identity, undefined, renderer.objectTable);
  renderer.objectTable.flushUploads();
  assert.equal(clippingWrites().length, 2, 'a semantic plane change must upload exactly once');
  assert.equal(
    log.filter(entry => entry[0] === 'writeBuffer' && entry[1] === 'normal.stable').length,
    1,
    'clipping-only changes must not re-upload the matrix table',
  );
});

test('NormalRenderer collapses contiguous portable object slots into an instanced draw', () => {
  const renderer = new NormalRenderer();
  attachObjectCore(renderer, {}, { bindGroup: {} });
  renderer.sceneFrameBinding = { bindGroup: {} };
  renderer._prepareObject = () => ({
    geoData: { indexBuf: {}, indexFormat: 'uint16', indexCount: 3 },
    matData: { paramsBindGroup: {} },
  });
  renderer._getPipeline = () => ({});

  const draws = [];
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed(...args) { draws.push(args); },
  };
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new NormalMaterial();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const items = [1, 2, 3].map(entityId => ({ entityId, geometry, material, worldMatrix: identity }));

  renderer.renderBatch(pass, items, 0, items.length, {
    gpuUploadEnabled: false,
    getObjectSlot: index => index + 7,
  });

  assert.deepEqual(draws, [[3, 3, 0, 0, 7]]);
});

test('DepthRenderer batches shared deformation bindings and falls back for incompatible geometry', () => {
  const renderer = new DepthRenderer();
  attachObjectCore(renderer, {}, { bindGroup: {} });
  renderer.sceneFrameBinding = { bindGroup: {} };
  renderer._prepareObject = (_entityId, geometry) => ({
    geoData: { indexBuf: {}, indexFormat: 'uint16', indexCount: 3 },
    matData: { paramsBindGroup: {} },
    deformation: {
      skinBindGroup: { geometryId: geometry.id },
      morphBuffers: [{}, {}, {}, {}],
    },
  });
  renderer._getPipeline = () => ({});

  const draws = [];
  const pass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed(...args) { draws.push(args); },
  };
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const staticGeometry = new Geometry3D({ positions, indices });
  const morphGeometry = new Geometry3D({
    positions,
    indices,
    morphTargets: [{ positions: new Float32Array(positions.length) }],
    morphWeights: [0.5],
  });
  const otherMorphGeometry = new Geometry3D({
    positions,
    indices,
    morphTargets: [{ positions: new Float32Array(positions.length) }],
    morphWeights: [0.75],
  });
  const material = new DepthMaterial();
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const items = [
    { entityId: 1, geometry: staticGeometry, material, worldMatrix: identity },
    { entityId: 2, geometry: staticGeometry, material, worldMatrix: identity },
    { entityId: 3, geometry: morphGeometry, material, worldMatrix: identity },
    { entityId: 4, geometry: morphGeometry, material, worldMatrix: identity },
    { entityId: 5, geometry: otherMorphGeometry, material, worldMatrix: identity },
  ];
  const slots = [4, 5, 20, 21, 22];

  renderer.renderBatch(pass, items, 0, items.length, {
    gpuUploadEnabled: false,
    getObjectSlot: index => slots[index],
  });

  assert.deepEqual(draws, [
    [3, 2, 0, 0, 4],
    [3, 2, 0, 0, 20],
    [3, 1, 0, 0, 22],
  ]);
});

test('PBR and Blinn batch renderers consume source ranges and derive indirect offsets from source indices', () => {
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  });
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const batchBuffer = {};
  const verifyRenderer = (renderer, material) => {
    const calls = [];
    renderer._renderItem = (_pass, entityId, itemGeometry, itemMaterial, _clippingPlanes, worldMatrix, buffer, batchIndex) => {
      calls.push([entityId, itemGeometry, itemMaterial, worldMatrix, buffer, batchIndex]);
    };
    const sourceItems = [
      { entityId: 0, geometry: null, material: null, worldMatrix: null },
      { entityId: 41, geometry, material, worldMatrix: identity },
      { entityId: 42, geometry, material, worldMatrix: identity },
    ];
    renderer.renderBatch({}, sourceItems, 1, 2, batchBuffer);
    assert.deepEqual(calls, [
      [41, geometry, material, identity, batchBuffer, 1],
      [42, geometry, material, identity, batchBuffer, 2],
    ]);
  };

  verifyRenderer(new PbrRenderer(), new PbrMaterial());
  verifyRenderer(new BlinnPhongRenderer(), new BlinnPhongMaterial());
});

test('SharedGeometry3DGPUCache releases buffers only after the last owner leaves', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const cache = getSharedGeometry3DGPUCache(device);
  const ownerA = {};
  const ownerB = {};
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint16Array([0, 1, 2]),
  });

  cache.ensure(geometry, ownerA);
  cache.ensure(geometry, ownerB);
  assert.equal(cache.size, 1);
  assert.equal(cache.getOwnerGeometryCount(ownerA), 1);
  assert.equal(cache.getOwnerGeometryCount(ownerB), 1);
  assert.equal(cache.hasGeometry(geometry.id), true);

  cache.releaseOwner(ownerA);
  assert.equal(cache.size, 1);
  assert.equal(cache.getOwnerGeometryCount(ownerA), 0);
  assert.equal(cache.getOwnerGeometryCount(ownerB), 1);
  assert.equal(log.filter(item => item[0] === 'destroyBuffer').length, 0);

  cache.releaseUnused(ownerB, new Set());
  assert.equal(cache.size, 0);
  assert.equal(cache.getOwnerGeometryCount(ownerB), 0);
  assert.equal(cache.hasGeometry(geometry.id), false);
  assert.equal(log.filter(item => item[0] === 'destroyBuffer').length, 4);

  disposeSharedGeometry3DGPUCache(device);
});

test('SharedGeometry3DGPUCache represents empty geometry without zero-byte GPU buffers', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const cache = getSharedGeometry3DGPUCache(device);
  const owner = {};
  const geometry = new Geometry3D({
    positions: new Float32Array(0),
    indices: new Uint16Array(0),
  });

  const data = cache.ensure(geometry, owner);
  assert.equal(data.vertexCount, 0);
  assert.equal(data.indexCount, 0);
  assert.equal(data.indexBuf, null);
  assert.deepEqual(log.filter(item => item[0] === 'createBuffer').map(item => item[2]), [4, 4, 4]);
  assert.equal(log.filter(item => item[0] === 'writeBuffer').length, 0);

  cache.releaseOwner(owner);
  disposeSharedGeometry3DGPUCache(device);
});

test('SharedGeometry3DGPUCache uploads dynamic UV semantics in physical layout order', () => {
  ensureGpuConstants();
  const uploads = [];
  const device = {
    queue: {
      writeBuffer(_buffer, _offset, source, sourceOffset = 0, size = source.byteLength) {
        uploads.push(Array.from(new Float32Array(source, sourceOffset, size / 4)));
      },
    },
    createBuffer(descriptor) {
      return { descriptor, destroy() {} };
    },
  };
  const uv2 = new Float32Array([0, 0, 1, 0, 1, 1]);
  const uv5 = new Float32Array([0.2, 0.2, 0.8, 0.2, 0.8, 0.8]);
  const geometry = new Geometry3D({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    textureCoordinates: [{ set: 2, data: uv2 }, { set: 5, data: uv5 }],
    textureCoordinateLayout: [5, 2],
  });
  const owner = {};
  const cache = getSharedGeometry3DGPUCache(device);
  const data = cache.ensure(geometry, owner);

  assert.equal(geometry.textureCoordinateLayoutKey, '0=TEXCOORD_5|1=TEXCOORD_2');
  assert.deepEqual(uploads[2], Array.from(uv5));
  assert.deepEqual(uploads[3], Array.from(uv2));
  assert.ok(data.uv1Buf);

  cache.releaseOwner(owner);
  disposeSharedGeometry3DGPUCache(device);
});

test('RendererResourceCache evicts shared resources with LRU and clears device caches', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  const createResource = label => ({
    label,
    destroy() {
      log.push(['destroyResource', label]);
    },
  });

  RendererResourceCache.configure(device, { maxResources: 2, maxPipelineLayouts: 2 });
  const a = RendererResourceCache.get(device, 'a', () => createResource('a'));
  RendererResourceCache.get(device, 'b', () => createResource('b'));
  assert.equal(RendererResourceCache.get(device, 'a', () => createResource('a2')), a);
  RendererResourceCache.get(device, 'c', () => createResource('c'));

  assert.deepEqual(log.filter(item => item[0] === 'destroyResource').map(item => item[1]), ['b']);
  assert.equal(RendererResourceCache.getStats(device).resources, 2);

  RendererResourceCache.clear(device);
  assert.deepEqual(log.filter(item => item[0] === 'destroyResource').map(item => item[1]).sort(), ['a', 'b', 'c']);
  assert.equal(RendererResourceCache.getStats(device).resources, 0);
});

test('RendererPipelineLayoutCache has bounded device-scoped storage', () => {
  const log = [];
  const device = createGeometryCacheDevice(log);
  RendererResourceCache.configure(device, { maxPipelineLayouts: 2 });
  const layouts = [{}, {}, {}];

  const first = RendererPipelineLayoutCache.get(device, 'a', [layouts[0]]);
  RendererPipelineLayoutCache.get(device, 'b', [layouts[1]]);
  assert.equal(RendererPipelineLayoutCache.get(device, 'a', [layouts[0]]), first);
  RendererPipelineLayoutCache.get(device, 'c', [layouts[2]]);

  assert.equal(RendererResourceCache.getStats(device).pipelineLayouts, 2);
  assert.deepEqual(log.filter(item => item[0] === 'createPipelineLayout').map(item => item[2]), [1, 2, 3]);
  RendererResourceCache.clear(device);
});
