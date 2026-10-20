import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InstancedMaterial } from '../dist/material.js';
import { InstancedMesh3DRenderer } from '../dist/experimental.js';
import { EnvironmentLight } from '../dist/index.js';

test('InstancedMesh3DRenderer uploads only the active instance range', () => {
  const writes = [];
  const renderer = new InstancedMesh3DRenderer();
  renderer.engine = {
    device: {
      queue: {
        writeBuffer(buffer, bufferOffset, _data, dataOffset, size) {
          writes.push({ buffer, bufferOffset, dataOffset, size });
        },
      },
    },
  };
  const material = new InstancedMaterial(1024);
  material.setActiveInstanceCount(1);
  const transformBuf = { size: 64 };
  const colorBuf = { size: 16 };

  renderer._uploadDirtyInstanceData({ transformBuf, colorBuf }, material);

  assert.deepEqual(writes.map(write => [write.buffer, write.bufferOffset, write.size]), [
    [transformBuf, 0, 64],
    [colorBuf, 0, 16],
  ]);
  assert.equal(material.transformsDirty, false);
  assert.equal(material.colorsDirty, false);
});

test('InstancedMesh3DRenderer uploads only changed instance slots after the initial upload', () => {
  const writes = [];
  const renderer = new InstancedMesh3DRenderer();
  renderer.engine = {
    device: {
      queue: {
        writeBuffer(buffer, bufferOffset, _data, dataOffset, size) {
          writes.push({ buffer, bufferOffset, dataOffset, size });
        },
      },
    },
  };
  const material = new InstancedMaterial(16);
  material.setActiveInstanceCount(10);
  const transformBuf = { size: 16 * 64 };
  const colorBuf = { size: 16 * 16 };
  const matData = { transformBuf, colorBuf };
  renderer._uploadDirtyInstanceData(matData, material);
  writes.length = 0;

  const transform = new Float32Array(16);
  transform[0] = transform[5] = transform[10] = transform[15] = 1;
  transform[12] = 3;
  material.setTransform(7, transform);
  material.setColor(7, 0.2, 0.4, 0.6, 1);
  renderer._uploadDirtyInstanceData(matData, material);

  assert.deepEqual(writes.map(write => [write.buffer, write.bufferOffset, write.size]), [
    [transformBuf, 7 * 64, 64],
    [colorBuf, 7 * 16, 16],
  ]);
});

test('InstancedMesh3DRenderer preserves identity indices across incremental growth', () => {
  const uploads = [];
  const renderer = new InstancedMesh3DRenderer();
  renderer.engine = {
    device: {
      queue: {
        writeBuffer(_buffer, _bufferOffset, data, dataOffset, size) {
          uploads.push(Array.from(new Uint32Array(data, dataOffset, size / Uint32Array.BYTES_PER_ELEMENT)));
        },
      },
    },
  };
  const matData = {
    visibleIndexBuf: { size: 16 },
    identityIndexCapacity: 0,
    identityIndicesValid: false,
  };

  renderer._ensureIdentityIndices(matData, 1);
  renderer._ensureIdentityIndices(matData, 2);
  renderer._ensureIdentityIndices(matData, 3);
  renderer._ensureIdentityIndices(matData, 4);

  assert.deepEqual(uploads, [
    [0],
    [0, 1],
    [0, 1, 2],
    [0, 1, 2, 3],
  ]);
});

test('InstancedMesh3DRenderer shares the neutral PBR environment semantics', () => {
  const renderer = new InstancedMesh3DRenderer();
  renderer.prepare({ device: createAuditGpuDevice() });

  renderer.updateLighting([], null, 0);
  assert.deepEqual(Array.from(renderer._environmentData), [
    0, 0, 0, 1,
    0, 0, 0, 1,
    0, 0, 0, 0,
  ]);

  renderer.updateLighting([], new EnvironmentLight(), 1);
  assert.ok(Math.abs(renderer._environmentData[0] - renderer._environmentData[2]) < 1e-7);
  assert.ok(Math.abs(renderer._environmentData[4] - renderer._environmentData[6]) < 1e-7);
  assert.equal(renderer._environmentData[8], 1);
  renderer.destroy();
});

test('shared material revisions reach every entity and renderer without re-uploading unchanged views', () => {
  const device = createAuditGpuDevice();
  const first = new InstancedMesh3DRenderer(), second = new InstancedMesh3DRenderer();
  first.prepare({ device }); second.prepare({ device });
  const material = new InstancedMaterial(4);
  const consumers = [
    [first, first._ensureMaterialData(1, material, 4)],
    [first, first._ensureMaterialData(2, material, 4)],
    [second, second._ensureMaterialData(1, material, 4)],
  ];
  for (const [renderer, data] of consumers) renderer._uploadDirtyInstanceData(data, material);
  const writes = [];
  const original = device.queue.writeBuffer;
  device.queue.writeBuffer = (...args) => { writes.push(args); original(...args); };
  material.setColor(2, .2, .3, .4);
  const matrix = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]);
  material.setTransform(2, matrix);
  for (const [renderer, data] of consumers) {
    renderer._uploadDirtyInstanceData(data, material);
    assert.equal(writes.filter(w => w[0] === data.transformBuf).length, 1);
    assert.equal(writes.filter(w => w[0] === data.colorBuf).length, 1);
  }
  writes.length = 0;
  for (const [renderer, data] of consumers) renderer._uploadDirtyInstanceData(data, material);
  assert.equal(writes.length, 0);
  // Slow consumers beyond the bounded journal receive the full latest data.
  material.setColor(0, .9, .8, .7);
  for (let i = 0; i < 40; i++) material.setColor(3, i / 40, .4, .5);
  for (const [renderer, data] of consumers) {
    renderer._uploadDirtyInstanceData(data, material);
    const upload = writes.filter(w => w[0] === data.colorBuf);
    assert.equal(upload.length, 1);
    assert.equal(upload[0][1], 0);
    assert.equal(upload[0][4], 64);
  }
  first.destroy(); second.destroy();
});
