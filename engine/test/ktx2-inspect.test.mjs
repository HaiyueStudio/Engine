import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectKtx2Texture } from '../dist/experimental.js';

const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

function createKtx2Header({
  vkFormat,
  width = 64,
  height = 64,
  depth = 0,
  layers = 0,
  faces = 1,
  levels = 1,
  supercompression = 0,
}) {
  const buffer = new ArrayBuffer(80 + levels * 24);
  const bytes = new Uint8Array(buffer);
  bytes.set(KTX2_IDENTIFIER, 0);
  const view = new DataView(buffer);
  view.setUint32(12, vkFormat, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, depth, true);
  view.setUint32(32, layers, true);
  view.setUint32(36, faces, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, supercompression, true);
  return buffer;
}

test('inspectKtx2Texture reports GPU-native 2D, array, cubemap, and 3D shapes', () => {
  assert.deepEqual(
    inspectKtx2Texture(createKtx2Header({ vkFormat: 37 }), 'rgba8.ktx2'),
    {
      vkFormat: 37,
      width: 64,
      height: 64,
      depth: 0,
      layers: 1,
      faces: 1,
      levels: 1,
      dimension: '2d',
      supercompression: 'none',
      gpuFormat: 'rgba8unorm',
      requiredFeature: null,
      uploadPath: 'gpu-native',
      supportedByBuiltInLoader: true,
      unsupportedReason: undefined,
    },
  );

  assert.equal(inspectKtx2Texture(createKtx2Header({ vkFormat: 37, layers: 4 })).dimension, '2d-array');
  assert.equal(inspectKtx2Texture(createKtx2Header({ vkFormat: 37, faces: 6 })).dimension, 'cube');
  assert.equal(inspectKtx2Texture(createKtx2Header({ vkFormat: 109, depth: 8 })).dimension, '3d');
  assert.equal(inspectKtx2Texture(createKtx2Header({ vkFormat: 109, depth: 8 })).gpuFormat, 'rgba32float');
});

test('inspectKtx2Texture reports feature requirements for compressed GPU-native formats', () => {
  const bc7 = inspectKtx2Texture(createKtx2Header({ vkFormat: 145 }), 'bc7.ktx2');
  assert.equal(bc7.gpuFormat, 'bc7-rgba-unorm');
  assert.equal(bc7.requiredFeature, 'texture-compression-bc');
  assert.equal(bc7.supportedByBuiltInLoader, true);

  const astc = inspectKtx2Texture(createKtx2Header({ vkFormat: 157 }), 'astc.ktx2');
  assert.equal(astc.gpuFormat, 'astc-4x4-unorm');
  assert.equal(astc.requiredFeature, 'texture-compression-astc');
});

test('inspectKtx2Texture distinguishes BasisLZ, zstd, zlib, and unsupported formats', () => {
  const basis2d = inspectKtx2Texture(createKtx2Header({ vkFormat: 0, supercompression: 1 }), 'basis.ktx2');
  assert.equal(basis2d.supercompression, 'basisLz');
  assert.equal(basis2d.uploadPath, 'basis-transcode');
  assert.equal(basis2d.supportedByBuiltInLoader, true);

  const basisArray = inspectKtx2Texture(createKtx2Header({ vkFormat: 0, layers: 2, supercompression: 1 }), 'basis-array.ktx2');
  assert.equal(basisArray.uploadPath, 'basis-transcode');
  assert.equal(basisArray.supportedByBuiltInLoader, true);

  const basisCube = inspectKtx2Texture(createKtx2Header({ vkFormat: 0, faces: 6, supercompression: 1 }), 'basis-cube.ktx2');
  assert.equal(basisCube.dimension, 'cube');
  assert.equal(basisCube.uploadPath, 'basis-transcode');
  assert.equal(basisCube.supportedByBuiltInLoader, true);

  const basisVolume = inspectKtx2Texture(createKtx2Header({ vkFormat: 0, depth: 4, supercompression: 1 }), 'basis-volume.ktx2');
  assert.equal(basisVolume.dimension, '3d');
  assert.equal(basisVolume.uploadPath, 'basis-transcode');
  assert.equal(basisVolume.supportedByBuiltInLoader, true);

  const zlib = inspectKtx2Texture(createKtx2Header({ vkFormat: 37, supercompression: 3 }), 'zlib.ktx2');
  assert.equal(zlib.supercompression, 'zlib');
  assert.equal(zlib.supportedByBuiltInLoader, true);

  const zstd = inspectKtx2Texture(createKtx2Header({ vkFormat: 37, supercompression: 2 }), 'zstd.ktx2');
  assert.equal(zstd.supercompression, 'zstd');
  assert.equal(zstd.uploadPath, 'gpu-native');
  assert.equal(zstd.supportedByBuiltInLoader, false);
  assert.match(zstd.unsupportedReason, /custom decoder/);

  const unsupported = inspectKtx2Texture(createKtx2Header({ vkFormat: 999 }), 'bad.ktx2');
  assert.equal(unsupported.uploadPath, 'unsupported');
  assert.equal(unsupported.supportedByBuiltInLoader, false);
  assert.match(unsupported.unsupportedReason, /Unsupported KTX2 vkFormat/);
});
