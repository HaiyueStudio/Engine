import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditGpuDevice } from '../../scripts/benchmark/real-renderer-audit-device.mjs';
import { importEngineSource } from './helpers/internal-source.mjs';
const { Geometry3D } = await importEngineSource('geometry/Geometry3D.ts');
const { setGeometryVertexColors, packGeometryUv1Color } = await importEngineSource('geometry/GeometryVertexColors.ts');
const { SharedGeometry3DGPUCache } = await importEngineSource('renderer/SharedGeometry3DGPUCache.ts');
const geometry = () => new Geometry3D({ positions: new Float32Array(9), textureCoordinates: [{ set: 0, data: new Float32Array([0, 1, 1, 1, 1, 0]) }] });

test('private RGBA port validates atomically, copies input, versions updates and restores white', () => {
  const g = geometry(), before = g.version, white = packGeometryUv1Color(g);
  for (const value of [new Float32Array(4), new Float32Array(12).fill(NaN), new Float32Array(12).fill(-1), new Float32Array(12).fill(1.01)]) {
    assert.throws(() => setGeometryVertexColors(g, value), RangeError);
    assert.equal(g.version, before);
  }
  const rgba = new Float32Array([1, 0, 0, .5, 0, 1, 0, 1, 0, 0, 1, 0]);
  setGeometryVertexColors(g, rgba); rgba.fill(0);
  assert.equal(g.version, before + 1);
  assert.deepEqual(Array.from(packGeometryUv1Color(g)), [0, 1, 1, 0, 0, .5, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0]);
  setGeometryVertexColors(g, null);
  assert.deepEqual(packGeometryUv1Color(g), white);
  setGeometryVertexColors(g, null);
  assert.equal(g.version, before + 2);
});

test('shared geometry color updates reach every owner and unchanged multi-view data does not upload', () => {
  const writes = [];
  const device = createAuditGpuDevice({ behaviors: { 'queue.writeBuffer': ({ args, defaultImplementation }) => {
    writes.push(args[0]); return defaultImplementation();
  } } });
  const cache = new SharedGeometry3DGPUCache(device), g = geometry(), a = {}, b = {};
  const data = cache.ensure(g, a), buffer = data.uv1Buf, count = writes.length;
  assert.equal(buffer.size, g.vertexCount * 24);
  assert.equal(cache.ensure(g, b), data);
  assert.equal(writes.length, count);
  setGeometryVertexColors(g, new Float32Array(12).fill(.25));
  assert.equal(cache.ensure(g, a), data);
  assert.notEqual(data.uv1Buf, buffer);
  const updated = writes.length;
  assert.equal(cache.ensure(g, b), data);
  assert.equal(writes.length, updated);
  cache.releaseOwner(a); assert.equal(data.uv1Buf.destroyed, false);
  cache.releaseOwner(b); assert.equal(data.uv1Buf.destroyed, true);
});

test('UV1 mapping and geometry resize are explicit; invalid color counts cannot destroy the cached buffers', () => {
  const g = new Geometry3D({ positions: new Float32Array(6), textureCoordinates: [{ set: 3, data: new Float32Array([.25, .5, .75, 1]) }], textureCoordinateLayout: [3] });
  assert.deepEqual(Array.from(packGeometryUv1Color(g)), [.25, .5, 1, 1, 1, 1, .75, 1, 1, 1, 1, 1]);
  setGeometryVertexColors(g, new Float32Array(8).fill(1));
  const cache = new SharedGeometry3DGPUCache(createAuditGpuDevice()), owner = {}, data = cache.ensure(g, owner);
  g.positions = new Float32Array(9); g.markDirty();
  assert.throws(() => cache.ensure(g, owner), /no longer matches/);
  assert.equal(data.uv1Buf.destroyed, false);
  setGeometryVertexColors(g, null); cache.ensure(g, owner); cache.dispose();
});
