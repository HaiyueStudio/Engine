import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry3D } from '../dist/index.js';
import { VolumeMaterial } from '../dist/material.js';
import { VolumeRenderer } from '../dist/experimental.js';
import { ClippingPlanes } from '../dist/components.js';

function ensureGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    VERTEX: 1 << 0,
    INDEX: 1 << 1,
    COPY_DST: 1 << 2,
    STORAGE: 1 << 3,
    UNIFORM: 1 << 4,
  };
  globalThis.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1 << 0,
    COPY_DST: 1 << 1,
  };
  globalThis.GPUShaderStage ??= {
    VERTEX: 1 << 0,
    FRAGMENT: 1 << 1,
  };
}

function createVolumeRendererEngine(log) {
  ensureGpuConstants();
  let nextId = 0;
  const device = {
    limits: {
      minUniformBufferOffsetAlignment: 256,
      maxBufferSize: 256 * 1024 * 1024,
      maxUniformBufferBindingSize: 64 * 1024,
    },
    queue: {
      writeBuffer(buffer, offset, data, dataOffset, size) {
        log.push([
          'writeBuffer',
          buffer.label ?? '',
          offset,
          dataOffset ?? 0,
          size ?? data.byteLength ?? 0,
        ]);
      },
      writeTexture() {},
      onSubmittedWorkDone() { return Promise.resolve(); },
    },
    createBuffer(descriptor) {
      return {
        ...descriptor,
        id: ++nextId,
        destroyed: false,
        destroy() { this.destroyed = true; },
      };
    },
    createBindGroupLayout(descriptor) {
      return { descriptor, id: ++nextId };
    },
    createBindGroup(descriptor) {
      return { descriptor, id: ++nextId };
    },
    createPipelineLayout(descriptor) {
      return { descriptor, id: ++nextId };
    },
    createShaderModule(descriptor) {
      return { descriptor, id: ++nextId };
    },
    createRenderPipeline(descriptor) {
      return { descriptor, id: ++nextId };
    },
    createTexture(descriptor) {
      const texture = {
        ...descriptor,
        id: ++nextId,
        destroyed: false,
        createView(viewDescriptor = {}) {
          return { texture, descriptor: viewDescriptor, id: ++nextId };
        },
        destroy() { this.destroyed = true; },
      };
      return texture;
    },
    createSampler(descriptor = {}) {
      return { descriptor, id: ++nextId };
    },
  };
  return {
    device,
    format: 'bgra8unorm',
    getDepthFormat() { return 'depth24plus'; },
  };
}

function identityAt(x = 0) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ]);
}

function objectTableWrites(log, start = 0) {
  return log.slice(start).filter(entry =>
    entry[0] === 'writeBuffer' && entry[1] === 'VolumeRenderer.objectTable');
}

function clippingTableWrites(log, start = 0) {
  return log.slice(start).filter(entry =>
    entry[0] === 'writeBuffer' && entry[1] === 'VolumeRenderer.clippingTable');
}

test('VolumeRenderer stores objects in one storage table and skips unchanged multi-view uploads', () => {
  const log = [];
  const renderer = new VolumeRenderer();
  renderer.prepare(createVolumeRendererEngine(log));
  renderer.sceneFrameBinding = {
    bindGroup: { label: 'scene-frame' },
    upload() { return 0; },
    destroy() {},
  };

  assert.equal(
    renderer.objectBindGroupLayout.descriptor.entries[0].buffer.type,
    'read-only-storage',
  );

  const geometry = new Geometry3D({
    positions: new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      0, 1, 0,
    ]),
    indices: new Uint16Array([0, 1, 2]),
  });
  const material = new VolumeMaterial({
    densityScale: 1.25,
    opacityScale: 2.5,
    steps: 64,
    color: [0.25, 0.5, 0.75, 0.8],
  });
  const firstWorld = identityAt(0);
  const secondWorld = identityAt(2);
  const clipping = new ClippingPlanes([{ normal: [1, 0, 0], constant: 0.25 }]);
  const items = [
    { entityId: 101, geometry, material, clippingPlanes: clipping, worldMatrix: firstWorld },
    { entityId: 102, geometry, material, clippingPlanes: null, worldMatrix: secondWorld },
  ];

  renderer.objectTable.ensureCapacity(items.length);
  const firstEntity = renderer.ensureEntity(101);
  renderer.ensureEntity(102);
  const initialWrites = log.length;

  renderer.beginView({}, undefined);
  renderer.prepareObjects(items, 0, items.length, [0, 0, 4], 0, {
    gpuUploadEnabled: false,
    getObjectSlot() { return 99; },
  });
  renderer.flushUploads();
  assert.deepEqual(objectTableWrites(log, initialWrites).map(entry => entry[4]), [2 * renderer.objectTable.floatsPerSlot * 4]);
  assert.deepEqual(clippingTableWrites(log, initialWrites).map(entry => entry[4]), [36 * 4]);
  const clippingOffset = firstEntity.modelSlot * 36;
  assert.deepEqual(Array.from(renderer.objectTable.auxiliaryData.subarray(clippingOffset, clippingOffset + 5)), [1, 0, 0, 0.25, 0]);
  assert.equal(renderer.objectTable.auxiliaryData[clippingOffset + 32], 1);
  renderer.endView();

  clipping.setPlane(0, { normal: [0, 2, 0], constant: -1 });
  const clippingChangeStart = log.length;
  renderer.beginView({}, undefined);
  renderer.prepareObjects(items, 0, items.length, [2, 0, 4]);
  renderer.flushUploads();
  assert.deepEqual(objectTableWrites(log, clippingChangeStart), []);
  assert.deepEqual(clippingTableWrites(log, clippingChangeStart).map(entry => entry[4]), [36 * 4],
    'a clipping revision uploads only its independent clipping slot');
  renderer.endView();

  const secondViewStart = log.length;
  renderer.beginView({}, undefined);
  renderer.prepareObjects(items, 0, items.length, [2, 0, 4]);
  renderer.flushUploads();
  assert.deepEqual(objectTableWrites(log, secondViewStart), []);
  assert.deepEqual(clippingTableWrites(log, secondViewStart), []);
  renderer.endView();

  firstWorld[12] = 1;
  const changedViewStart = log.length;
  renderer.beginView({}, undefined);
  renderer.prepareObjects(items, 0, items.length, [2, 1, 4]);
  renderer.flushUploads();
  assert.deepEqual(
    objectTableWrites(log, changedViewStart).map(entry => entry[4]),
    [renderer.objectTable.floatsPerSlot * 4],
    'the table uploads only the changed slot when a whole-table write costs more',
  );
  assert.deepEqual(clippingTableWrites(log, changedViewStart), []);

  const draws = [];
  const pass = {
    setPipeline() {},
    setBindGroup(index, bindGroup) {
      if (index === 1) {
        assert.equal(
          bindGroup.descriptor.entries[0].resource.buffer.label,
          'VolumeRenderer.objectTable',
        );
        assert.equal(bindGroup.descriptor.entries[1].resource.buffer.label, 'VolumeRenderer.clippingTable');
      }
    },
    setVertexBuffer() {},
    setIndexBuffer() {},
    drawIndexed(...args) { draws.push(args); },
  };
  renderer.render(pass, 101, geometry, material, firstWorld, [2, 1, 4], {}, clipping);
  assert.deepEqual(draws, [[3, 1, 0, 0, firstEntity.modelSlot]]);
  renderer.endView();

  assert.equal(
    log.some(entry => entry[0] === 'writeBuffer' && entry[1].startsWith('VolumeRenderer.entity.')),
    false,
  );
  renderer.destroy();
});
