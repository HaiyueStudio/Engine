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
  renderer.engine = { device: { queue: { writeBuffer() {} } } };
  renderer.lightBuf = {};
  renderer.environmentBuf = {};

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
});
