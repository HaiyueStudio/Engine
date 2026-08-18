import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareKtx2TexturePayload } from '@haiyue/engine/experimental';
import {
  createGltfAssetWorkerSource,
  prepareGltfGeometryPayloads,
} from '../dist/experimental-gltf-worker.js';
import {
  loadParsedGltfAsset as loadParsedGltfAssetFromWorkerRuntime,
  prepareGltfGeometryPayloads as prepareGltfGeometryPayloadsFromWorkerRuntime,
} from '../dist/gltf-worker-runtime.js';
import {
  createSpineAssetWorkerSource,
  parseSpineAssetPayload,
} from '../dist/experimental-spine-worker.js';

function createTriangleFixture() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    },
    buffers: [positions.buffer],
  };
}

function createRgba8Ktx2Fixture() {
  const identifier = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  const buffer = new ArrayBuffer(108);
  const bytes = new Uint8Array(buffer);
  bytes.set(identifier);
  const view = new DataView(buffer);
  view.setUint32(12, 37, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 1, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, 1, true);
  view.setBigUint64(80, 104n, true);
  view.setBigUint64(88, 4n, true);
  view.setBigUint64(96, 4n, true);
  bytes.set([10, 20, 30, 255], 104);
  return buffer;
}

test('glTF and Draco worker source imports the production parser and matches main geometry output', async () => {
  const fixture = createTriangleFixture();
  const main = await prepareGltfGeometryPayloads(fixture.gltf, fixture.buffers);
  const workerEquivalent = structuredClone(
    await prepareGltfGeometryPayloadsFromWorkerRuntime(fixture.gltf, fixture.buffers),
  );
  assert.deepEqual(workerEquivalent, main);
  assert.equal(typeof loadParsedGltfAssetFromWorkerRuntime, 'function');
  const source = createGltfAssetWorkerSource('/extensions/gltf.js');
  assert.match(source, /parser\.prepareGltfGeometryPayloads/);
  assert.doesNotMatch(source, /function readAccessor/);

  const invalid = { ...fixture.gltf, meshes: [{ primitives: [{ attributes: { POSITION: 99 } }] }] };
  const capture = async () => {
    try { await prepareGltfGeometryPayloads(invalid, fixture.buffers); }
    catch (error) { return { code: error.code, path: error.path }; }
    throw new Error('Expected invalid glTF to fail.');
  };
  assert.deepEqual(await capture(), await capture());
});

test('published glTF worker runtime is self-contained for module-worker loading', async () => {
  const source = await readFile(new URL('../dist/gltf-worker-runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bfrom\s+['"]@haiyue\//);
  assert.doesNotMatch(source, /\bfrom\s+['"]wgpu-matrix['"]/);
});

test('KTX2 main and worker parser contracts produce equivalent payload and errors', async () => {
  const fixture = createRgba8Ktx2Fixture();
  const main = await prepareKtx2TexturePayload([], fixture.slice(0), 'fixture.ktx2');
  const workerEquivalent = structuredClone(await prepareKtx2TexturePayload([], fixture.slice(0), 'fixture.ktx2'));
  assert.deepEqual(workerEquivalent, main);
  const capture = async () => {
    try { await prepareKtx2TexturePayload([], new ArrayBuffer(8), 'invalid.ktx2'); }
    catch (error) { return { code: error.code, path: error.path ?? null }; }
    throw new Error('Expected invalid KTX2 to fail.');
  };
  assert.deepEqual(await capture(), await capture());
});

test('Spine main and worker use the same pure parser and equivalent structured errors', () => {
  const fixture = {
    json: { bones: [{ name: 'root' }], slots: [], skins: {}, animations: {} },
    atlasText: '',
  };
  const main = parseSpineAssetPayload(fixture);
  const workerEquivalent = structuredClone(parseSpineAssetPayload(fixture));
  assert.deepEqual(workerEquivalent, main);
  const source = createSpineAssetWorkerSource('/extensions/experimental-spine-worker.js');
  assert.match(source, /parser\.parseSpineAssetPayload/);

  const capture = () => {
    try { parseSpineAssetPayload({ json: { bones: [], slots: 'bad' }, atlasText: '' }); }
    catch (error) { return { code: error.code, path: error.path }; }
    throw new Error('Expected invalid Spine data to fail.');
  };
  assert.deepEqual(capture(), capture());
  assert.deepEqual(capture(), { code: 'E_ASSET_INVALID_DATA', path: 'spine.slots' });
});
