import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Mesh3D, PbrMaterial } from '@haiyue/engine';
import { toColorSRGB } from '@haiyue/engine/color';
import {
  applyGltfAnimationClip,
  disposeGltfModel,
  loadGltfModel,
  setGltfMaterialVariant,
} from '../dist/gltf.js';
import {
  createGltfAssetWorkerSource,
  GltfAssetWorkerClient,
  loadParsedGltfAsset,
  prepareGltfGeometryPayloads,
} from '../dist/experimental-gltf-worker.js';

class DeduplicatingAssetManager {
  records = new Map();
  textureCreates = 0;
  textureReleases = 0;

  async load(key, loader, dispose) {
    let record = this.records.get(key);
    if (!record) {
      record = { refs: 0, dispose, promise: Promise.resolve().then(() => loader()) };
      this.records.set(key, record);
    }
    record.refs++;
    let value;
    try {
      value = await record.promise;
    } catch (error) {
      record.refs--;
      if (record.refs === 0) this.records.delete(key);
      throw error;
    }
    let released = false;
    return {
      key,
      value,
      release: () => {
        if (released) return;
        released = true;
        record.refs--;
        if (record.refs !== 0) return;
        this.records.delete(key);
        record.dispose(value);
      },
    };
  }

  loadTexture(source, options = {}) {
    const compressed = typeof source === 'object' && source?.kind === 'compressed-texture';
    const key = compressed
      ? `texture:compressed:${options.cacheKey}`
      : `texture:${options.format}:${options.mipmaps}:${options.cacheKey}`;
    return this.load(key, async () => {
      this.textureCreates++;
      return { key, createView() { return {}; } };
    }, () => { this.textureReleases++; });
  }
}

function packAccessorData(arrays) {
  const bufferViews = [];
  let byteLength = 0;
  for (const array of arrays) {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: array.byteLength });
    byteLength += array.byteLength;
  }
  const bytes = new Uint8Array(byteLength);
  arrays.forEach((array, index) => bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), bufferViews[index].byteOffset));
  return { buffer: bytes.buffer, bufferViews };
}

function createMorphBoundsParsedAsset() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const target = new Float32Array([2, -1, 0, 2, -1, 0, 2, -1, 0]);
  const times = new Float32Array([0, 1]);
  const animatedWeights = new Float32Array([0.5, 2]);
  const packed = packAccessorData([positions, target, times, animatedWeights]);
  return {
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: packed.buffer.byteLength }],
      bufferViews: packed.bufferViews,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3', min: [2, -1, 0], max: [2, -1, 0] },
        { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0.5], max: [2] },
      ],
      meshes: [{ weights: [0.5], primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
      animations: [{
        samplers: [{ input: 2, output: 3 }],
        channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }],
      }],
    },
    binaryChunk: null,
    buffers: [packed.buffer],
    baseUrl: 'http://localhost/models/',
  };
}

function createSkinBoundsParsedAsset() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const joints = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const weights = new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]);
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([5, 0, 0, 10, 0, 0]);
  const packed = packAccessorData([positions, joints, weights, times, translations]);
  return {
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: packed.buffer.byteLength }],
      bufferViews: packed.bufferViews,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3', min: [5, 0, 0], max: [10, 0, 0] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
      nodes: [{ mesh: 0, skin: 0 }, { translation: [5, 0, 0] }],
      skins: [{ joints: [1] }],
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
      animations: [{
        samplers: [{ input: 3, output: 4 }],
        channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      }],
    },
    binaryChunk: null,
    buffers: [packed.buffer],
    baseUrl: 'http://localhost/models/',
  };
}

function assertBounds(actual, center, radius) {
  assert.ok(actual);
  assert.deepEqual(actual.center.map(value => Number(value.toFixed(6))), center);
  assert.ok(Math.abs(actual.radius - radius) < 1e-6, `${actual.radius} != ${radius}`);
}

function createSparsePositionsParsedAsset() {
  const indices = new Uint8Array([0, 1, 2, 0]);
  const values = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  const bytes = new Uint8Array(indices.byteLength + values.byteLength);
  bytes.set(indices, 0);
  bytes.set(new Uint8Array(values.buffer), indices.byteLength);
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ uri: 'buffer.bin', byteLength: bytes.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 3 },
      { buffer: 0, byteOffset: 4, byteLength: values.byteLength },
    ],
    accessors: [
      {
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        sparse: {
          count: 3,
          indices: { bufferView: 0, componentType: 5121 },
          values: { bufferView: 1 },
        },
      },
    ],
    meshes: [
      {
        name: 'SparseTriangle',
        primitives: [{ attributes: { POSITION: 0 } }],
      },
    ],
    nodes: [{ mesh: 0, name: 'Node' }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return { gltf, binaryChunk: null, buffers: [bytes.buffer], baseUrl: 'http://localhost/models/' };
}

function createTextureDedupParsedAsset() {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]);
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
  ]);
  const imageBytes = new Uint8Array([137, 80, 78, 71]);
  const packed = packAccessorData([positions, uvs, imageBytes]);
  return {
    gltf: {
      asset: { version: '2.0' },
      buffers: [{ byteLength: packed.buffer.byteLength }],
      bufferViews: packed.bufferViews,
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      ],
      images: [{ bufferView: 2, mimeType: 'image/png' }],
      samplers: [{ wrapS: 10497 }, { wrapS: 33071 }],
      textures: [{ source: 0, sampler: 0 }, { source: 0, sampler: 1 }],
      materials: [{
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        emissiveTexture: { index: 1 },
        normalTexture: { index: 1 },
      }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    binaryChunk: null,
    buffers: [packed.buffer],
    baseUrl: 'https://assets.example/models/',
  };
}

function createSparsePositionsGltfUrl() {
  const parsed = createSparsePositionsParsedAsset();
  const bytes = new Uint8Array(parsed.buffers[0]);
  const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
  parsed.gltf.buffers[0].uri = `data:application/octet-stream;base64,${btoa(binary)}`;
  return `data:model/gltf+json;base64,${btoa(JSON.stringify(parsed.gltf))}`;
}

test('loadGltfModel supports bufferless sparse accessors', async () => {
  globalThis.window ??= { location: { href: 'http://localhost/' } };
  const model = await loadGltfModel(createSparsePositionsGltfUrl());
  try {
    const node = model.root.children[0];
    const primitive = node.children[0];
    const mesh = primitive.getComponent(Mesh3D);
    assert.ok(mesh);
    assert.deepEqual(Array.from(mesh.geometry.positions), [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
    assert.deepEqual(Array.from(mesh.geometry.normals), [
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]);
  } finally {
    model.root.destroy();
  }
});

test('glTF accessor bounds conservatively track current GPU morph weights', async () => {
  const parsed = createMorphBoundsParsedAsset();
  const model = await loadGltfModel('worker://morph-bounds.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    const geometry = model.root.children[0].children[0].getComponent(Mesh3D).geometry;
    assert.equal(geometry.boundsMode, 'dynamic');
    assert.equal(model.compatibilityReport.status, 'compatible');
    assert.equal(model.compatibilityReport.bounds[0].support, 'accessor-conservative');
    assertBounds(geometry.localBounds, [1.5, 0, 0], Math.SQRT1_2);
    const geometryVersion = geometry.version;
    const boundsVersion = geometry.boundsVersion;
    applyGltfAnimationClip(model.animationClips[0], 0.5);
    assertBounds(geometry.localBounds, [3, -0.75, 0], Math.SQRT1_2);
    assert.equal(geometry.version, geometryVersion, 'bounds changes must not invalidate GPU vertex buffers');
    assert.ok(geometry.boundsVersion > boundsVersion);
  } finally {
    model.root.destroy();
  }
});

test('glTF skin bounds follow joint matrices and normalize weights before proving convexity', async () => {
  const parsed = createSkinBoundsParsedAsset();
  const model = await loadGltfModel('worker://skin-bounds.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    const geometry = model.root.children[0].children[0].getComponent(Mesh3D).geometry;
    assert.equal(geometry.boundsMode, 'dynamic');
    assert.deepEqual(Array.from(geometry.skinning.weights.slice(0, 4)), [1, 0, 0, 0]);
    assertBounds(geometry.localBounds, [5.5, 0.5, 0], Math.SQRT1_2);
    const geometryVersion = geometry.version;
    applyGltfAnimationClip(model.animationClips[0], 0.5);
    assertBounds(geometry.localBounds, [8, 0.5, 0], Math.SQRT1_2);
    assert.equal(geometry.version, geometryVersion, 'animated skin bounds must not re-upload geometry');
  } finally {
    model.root.destroy();
  }
});

test('glTF morph and skin bounds remain fail-open when accessor evidence is incomplete', async () => {
  const morph = createMorphBoundsParsedAsset();
  delete morph.gltf.accessors[1].min;
  delete morph.gltf.accessors[1].max;
  const skin = createSkinBoundsParsedAsset();
  delete skin.gltf.accessors[0].min;
  delete skin.gltf.accessors[0].max;
  const [morphModel, skinModel] = await Promise.all([
    loadGltfModel('worker://morph-bounds-missing.gltf', { assetWorker: { async loadParsedAsset() { return morph; } } }),
    loadGltfModel('worker://skin-bounds-missing.gltf', { assetWorker: { async loadParsedAsset() { return skin; } } }),
  ]);
  try {
    assert.equal(morphModel.root.children[0].children[0].getComponent(Mesh3D).geometry.localBounds, null);
    assert.equal(skinModel.root.children[0].children[0].getComponent(Mesh3D).geometry.localBounds, null);
    assert.equal(morphModel.compatibilityReport.status, 'degraded');
    assert.match(morphModel.compatibilityReport.bounds[0].reason, /Morph target 0 POSITION accessor/);
    assert.equal(morphModel.compatibilityReport.issues[0].code, 'GLTF_BOUNDS_FAIL_OPEN');
    assert.equal(skinModel.compatibilityReport.bounds[0].support, 'fail-open');
  } finally {
    morphModel.root.destroy();
    skinModel.root.destroy();
  }
});

test('loadGltfModel consumes parsed glTF assets from an asset worker', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const assetWorker = {
    calls: 0,
    async loadParsedAsset(src) {
      this.calls++;
      assert.equal(src, 'worker://sparse.gltf');
      return parsed;
    },
  };

  const model = await loadGltfModel('worker://sparse.gltf', { assetWorker });
  try {
    assert.equal(assetWorker.calls, 1);
    const node = model.root.children[0];
    const primitive = node.children[0];
    const mesh = primitive.getComponent(Mesh3D);
    assert.ok(mesh);
    assert.deepEqual(Array.from(mesh.geometry.positions), [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]);
  } finally {
    model.root.destroy();
  }
});

test('loadParsedGltfAsset fetches external buffers concurrently and preserves buffer order', async () => {
  const originalFetch = globalThis.fetch;
  const pendingBuffers = new Map();
  let activeBuffers = 0;
  let maxActiveBuffers = 0;
  globalThis.fetch = async url => {
    if (url === 'https://assets.example/model.gltf') {
      return new Response(JSON.stringify({
        asset: { version: '2.0' },
        buffers: [
          { uri: 'first.bin', byteLength: 1 },
          { uri: 'second.bin', byteLength: 1 },
        ],
      }), { status: 200 });
    }
    activeBuffers++;
    maxActiveBuffers = Math.max(maxActiveBuffers, activeBuffers);
    return new Promise(resolve => {
      pendingBuffers.set(String(url), value => {
        activeBuffers--;
        resolve(new Response(new Uint8Array([value]), { status: 200 }));
      });
    });
  };
  try {
    const parsedPromise = loadParsedGltfAsset('https://assets.example/model.gltf');
    for (let i = 0; i < 10 && pendingBuffers.size < 2; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(pendingBuffers.size, 2);
    assert.equal(maxActiveBuffers, 2);
    pendingBuffers.get('https://assets.example/second.bin')(2);
    pendingBuffers.get('https://assets.example/first.bin')(1);
    const parsed = await parsedPromise;
    assert.deepEqual(parsed.buffers.map(buffer => new Uint8Array(buffer)[0]), [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('loadGltfModel de-duplicates concurrent parsed assets through the shared AssetManager', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const assetManager = new DeduplicatingAssetManager();
  let workerCalls = 0;
  const assetWorker = {
    async loadParsedAsset() {
      workerCalls++;
      await new Promise(resolve => setImmediate(resolve));
      return parsed;
    },
  };
  const [first, second] = await Promise.all([
    loadGltfModel('worker://shared.gltf', { assetManager, assetWorker }),
    loadGltfModel('worker://shared.gltf', { assetManager, assetWorker }),
  ]);
  try {
    assert.equal(workerCalls, 1);
    assert.equal(assetManager.records.get('gltf:parsed:worker://shared.gltf').refs, 2);
  } finally {
    disposeGltfModel(first);
    disposeGltfModel(second);
  }
  assert.equal(assetManager.records.size, 0);
});

test('glTF textures share image uploads across samplers, materials, and concurrent model loads', async () => {
  const parsed = createTextureDedupParsedAsset();
  const assetManager = new DeduplicatingAssetManager();
  let workerCalls = 0;
  const assetWorker = {
    async loadParsedAsset() {
      workerCalls++;
      return parsed;
    },
  };
  const [first, second] = await Promise.all([
    loadGltfModel('worker://textures.gltf', { assetManager, assetWorker }),
    loadGltfModel('worker://textures.gltf', { assetManager, assetWorker }),
  ]);
  try {
    const firstMaterial = first.root.children[0].children[0].getComponent(Mesh3D).material;
    const secondMaterial = second.root.children[0].children[0].getComponent(Mesh3D).material;
    assert.ok(firstMaterial instanceof PbrMaterial);
    assert.ok(secondMaterial instanceof PbrMaterial);
    assert.equal(workerCalls, 1);
    assert.equal(assetManager.textureCreates, 2, 'sRGB and linear usages require separate GPU formats');
    assert.equal(first.objectUrls.length, 0, 'shared embedded URLs belong to the parsed asset record');
    assert.equal(second.objectUrls.length, 0);
    assert.equal(firstMaterial.baseColorTexture, firstMaterial.emissiveTexture);
    assert.notEqual(firstMaterial.baseColorTexture, firstMaterial.normalTexture);
    assert.equal(firstMaterial.baseColorTexture, secondMaterial.baseColorTexture);
    assert.equal(firstMaterial.normalTexture, secondMaterial.normalTexture);
  } finally {
    disposeGltfModel(first);
    assert.equal(assetManager.textureReleases, 0);
    disposeGltfModel(second);
  }
  assert.equal(assetManager.textureReleases, 2);
  assert.equal(assetManager.records.size, 0);
});

test('glTF metallic-roughness materials and KHR_materials_variants stay native PBR', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.gltf.extensionsUsed = ['KHR_materials_variants'];
  parsed.gltf.extensions = { KHR_materials_variants: { variants: [{ name: 'Moonlit' }] } };
  parsed.gltf.materials = [
    { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.3, 0.15, 1], metallicFactor: 0.2, roughnessFactor: 0.7 } },
    { pbrMetallicRoughness: { baseColorFactor: [0.1, 0.45, 0.9, 1], metallicFactor: 0.9, roughnessFactor: 0.18 } },
  ];
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.meshes[0].primitives[0].extensions = {
    KHR_materials_variants: { mappings: [{ material: 1, variants: [0] }] },
  };
  const model = await loadGltfModel('worker://pbr-variant.gltf', { assetWorker: { async loadParsedAsset() { return parsed; } } });
  try {
    const material = model.root.children[0].children[0].getComponent(Mesh3D).material;
    assert.ok(material instanceof PbrMaterial);
    assert.equal(material.metallic, 0.2);
    assert.equal(material.roughness, 0.7);
    assert.ok(Math.abs(toColorSRGB(material.baseColor).r - 0.9063) < 0.001);
    assert.deepEqual(model.materialVariants, ['Moonlit']);
    setGltfMaterialVariant(model, 'Moonlit');
    assert.equal(material.activeVariant, 'Moonlit');
    assert.equal(material.metallic, 0.9);
    setGltfMaterialVariant(model, null);
    assert.equal(material.metallic, 0.2);
  } finally {
    model.root.destroy();
  }
});

test('loadGltfModel rejects non-fully-supported required extensions with a structured path', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.gltf.extensionsUsed = ['VENDOR_runtime_magic'];
  parsed.gltf.extensionsRequired = ['VENDOR_runtime_magic'];

  await assert.rejects(
    () => loadGltfModel('worker://required-extension.gltf', {
      assetWorker: { async loadParsedAsset() { return parsed; } },
    }),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'gltf.extensionsRequired[0]'
      && error.context.extension === 'VENDOR_runtime_magic'
      && error.context.url === 'worker://required-extension.gltf',
  );

  parsed.gltf.extensionsUsed = ['KHR_materials_anisotropy'];
  parsed.gltf.extensionsRequired = ['KHR_materials_anisotropy'];
  await assert.rejects(
    () => loadGltfModel('worker://partial-required-extension.gltf', {
      assetWorker: { async loadParsedAsset() { return parsed; } },
    }),
    error => error.path === 'gltf.extensionsRequired[0]'
      && error.context.extension === 'KHR_materials_anisotropy'
      && error.context.support === 'partial',
  );
});

test('custom glTF Extension Adapter satisfies required capability and patches MaterialDescriptor', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.gltf.extensionsUsed = ['VENDOR_material_finish'];
  parsed.gltf.extensionsRequired = ['VENDOR_material_finish'];
  parsed.gltf.materials = [{
    pbrMetallicRoughness: { metallicFactor: 0.1, roughnessFactor: 0.9 },
    extensions: { VENDOR_material_finish: { metallic: 0.72, roughness: 0.16 } },
  }];
  parsed.gltf.meshes[0].primitives[0].material = 0;
  const adapter = {
    extension: 'VENDOR_material_finish',
    capability: { support: 'supported', note: 'Mapped to native PBR factors.' },
    extendMaterial({ extensionData }) {
      return { state: extensionData };
    },
  };

  const model = await loadGltfModel('worker://custom-material-extension.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
    extensionAdapters: [adapter],
  });
  try {
    const material = model.root.children[0].children[0].getComponent(Mesh3D).material;
    assert.ok(material instanceof PbrMaterial);
    assert.equal(material.metallic, 0.72);
    assert.equal(material.roughness, 0.16);
    assert.deepEqual(model.extensionReport.entries, [{
      extension: 'VENDOR_material_finish',
      required: true,
      support: 'supported',
      disposition: 'supported',
      note: 'Mapped to native PBR factors.',
    }]);
  } finally {
    model.root.destroy();
  }
});

test('custom material extension texture bindings participate in UV semantic planning', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.gltf.extensionsUsed = ['VENDOR_detail_texture'];
  parsed.gltf.materials = [{ extensions: { VENDOR_detail_texture: { texture: { index: 0, texCoord: 3 } } } }];
  parsed.gltf.meshes[0].primitives[0].material = 0;
  const adapter = {
    extension: 'VENDOR_detail_texture',
    capability: { support: 'supported', note: 'Maps a vendor detail texture to base color.' },
    extendMaterial({ extensionData, materialPath }) {
      return {
        textures: [{
          slot: 'baseColor',
          textureInfo: extensionData.texture,
          path: `${materialPath}.extensions.VENDOR_detail_texture.texture`,
        }],
      };
    },
  };

  await assert.rejects(
    () => loadGltfModel('worker://custom-extension-uv.gltf', {
      assetWorker: { async loadParsedAsset() { return parsed; } },
      extensionAdapters: [adapter],
    }),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'gltf.materials[0].extensions.VENDOR_detail_texture.texture.texCoord'
      && error.context.semantic === 'TEXCOORD_3',
  );
});

test('loadGltfModel exposes warnings for unsupported optional extensions', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.gltf.extensionsUsed = ['VENDOR_optional_metadata'];
  parsed.gltf.images = [{ uri: 'albedo.png' }, { uri: 'surface.ktx2', mimeType: 'image/ktx2' }];
  parsed.gltf.textures = [{ source: 0 }, { source: 1 }];
  const observed = [];
  const model = await loadGltfModel('worker://optional-extension.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
    onWarning: warning => observed.push(warning),
  });
  try {
    assert.equal(Object.isFrozen(model.warnings), true);
    assert.deepEqual(model.warnings, [{
      code: 'W_GLTF_UNSUPPORTED_OPTIONAL_EXTENSION',
      message: 'Optional glTF extension "VENDOR_optional_metadata" is not supported and was ignored.',
      extension: 'VENDOR_optional_metadata',
      path: 'gltf.extensionsUsed[0]',
    }]);
    assert.deepEqual(observed, model.warnings);
    assert.equal(model.extensionReport.fullySupported, false);
    assert.deepEqual(model.extensionReport.entries, [{
      extension: 'VENDOR_optional_metadata',
      required: false,
      support: 'unsupported',
      disposition: 'ignored',
      note: 'No loader capability is registered; optional extension data is ignored.',
    }]);
    assert.equal(Object.isFrozen(model.extensionReport.entries), true);
    assert.equal(model.compatibilityReport.status, 'degraded');
    assert.deepEqual(model.compatibilityReport.textures.map(entry => entry.mipmapSource), [
      'generated-full-chain',
      'source-provided',
    ]);
    assert.deepEqual(model.compatibilityReport.issues.map(issue => issue.code), ['GLTF_EXTENSION_UNSUPPORTED']);
    assert.equal(Object.isFrozen(model.compatibilityReport), true);
  } finally {
    model.root.destroy();
  }
});

test('glTF imports required KHR_materials_clearcoat with dynamic UV transforms and per-slot samplers', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
  const uv1 = new Float32Array([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]);
  parsed.geometryPayloads = [[{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [{ set: 0, data: uv0 }, { set: 1, data: uv1 }],
    positionTargets: [],
    normalTargets: [],
  }]];
  parsed.gltf.extensionsUsed = ['KHR_texture_transform', 'KHR_materials_clearcoat'];
  parsed.gltf.extensionsRequired = ['KHR_materials_clearcoat'];
  parsed.gltf.samplers = [
    { wrapS: 33071, minFilter: 9728 },
    { wrapS: 33648, minFilter: 9729 },
  ];
  parsed.gltf.textures = [
    { sampler: 0 }, { sampler: 1 }, { sampler: 0 }, { sampler: 1 }, { sampler: 0 },
    { sampler: 1 }, { sampler: 0 }, { sampler: 1 },
  ];
  parsed.gltf.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_1: 2 };
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.materials = [{
    pbrMetallicRoughness: {
      baseColorTexture: {
        index: 0,
        texCoord: 0,
        extensions: { KHR_texture_transform: { offset: [0.1, 0.2], rotation: 0.5, scale: [2, 3] } },
      },
      metallicRoughnessTexture: { index: 1, texCoord: 1 },
    },
    normalTexture: {
      index: 2,
      texCoord: 0,
      extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.3, 0.4] } },
    },
    occlusionTexture: { index: 3, texCoord: 1 },
    emissiveTexture: { index: 4, texCoord: 0 },
    extensions: {
      KHR_materials_clearcoat: {
        clearcoatFactor: 0.85,
        clearcoatTexture: { index: 5, texCoord: 1 },
        clearcoatRoughnessFactor: 0.24,
        clearcoatRoughnessTexture: { index: 6, texCoord: 0 },
        clearcoatNormalTexture: {
          index: 7,
          texCoord: 0,
          scale: 0.65,
          extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.15, 0.25] } },
        },
      },
    },
  }];

  const model = await loadGltfModel('worker://texture-coordinates.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
    assert.deepEqual(Array.from(mesh.geometry.getTextureCoordinates(0)), Array.from(uv0));
    assert.deepEqual(Array.from(mesh.geometry.getTextureCoordinates(1)), Array.from(uv1));
    assert.deepEqual(mesh.material.getTextureMapping('baseColor'), {
      texCoord: 0,
      offset: [0.1, 0.2],
      rotation: 0.5,
      scale: [2, 3],
    });
    assert.equal(mesh.material.getTextureMapping('metallicRoughness').texCoord, 1);
    assert.deepEqual(mesh.material.getTextureMapping('normal'), {
      texCoord: 1,
      offset: [0.3, 0.4],
      rotation: 0,
      scale: [1, 1],
    });
    assert.equal(mesh.material.getTextureMapping('occlusion').texCoord, 1);
    assert.equal(mesh.material.getTextureMapping('emissive').texCoord, 0);
    assert.equal(mesh.material.clearcoatFactor, 0.85);
    assert.equal(mesh.material.clearcoatRoughnessFactor, 0.24);
    assert.equal(mesh.material.clearcoatNormalScale, 0.65);
    assert.equal(mesh.material.getTextureMapping('clearcoat').texCoord, 1);
    assert.equal(mesh.material.getTextureMapping('clearcoatRoughness').texCoord, 0);
    assert.deepEqual(mesh.material.getTextureMapping('clearcoatNormal'), {
      texCoord: 1,
      offset: [0.15, 0.25],
      rotation: 0,
      scale: [1, 1],
    });
    assert.deepEqual(model.compatibilityReport.uvSemantics[0], {
      meshIndex: 0,
      primitiveIndex: 0,
      capacity: 2,
      availableSemantics: ['TEXCOORD_0', 'TEXCOORD_1'],
      referencedSemantics: ['TEXCOORD_0', 'TEXCOORD_1'],
      mappings: [
        { semantic: 'TEXCOORD_0', set: 0, channel: 0 },
        { semantic: 'TEXCOORD_1', set: 1, channel: 1 },
      ],
      path: 'gltf.meshes[0].primitives[0]',
    });
    assert.equal(mesh.material.getTextureSampler('baseColor').addressModeU, 'clamp-to-edge');
    assert.equal(mesh.material.getTextureSampler('metallicRoughness').addressModeU, 'mirror-repeat');
    assert.equal(mesh.material.getTextureSampler('normal').minFilter, 'nearest');
    assert.equal(mesh.material.getTextureSampler('clearcoat').addressModeU, 'mirror-repeat');
    assert.equal(mesh.material.getTextureSampler('clearcoatRoughness').addressModeU, 'clamp-to-edge');
    assert.equal(mesh.material.getTextureSampler('clearcoatNormal').addressModeU, 'mirror-repeat');
    assert.equal(model.extensionReport.fullySupported, true);
    assert.deepEqual(model.extensionReport.entries.map(entry => [entry.extension, entry.required, entry.disposition]), [
      ['KHR_texture_transform', false, 'supported'],
      ['KHR_materials_clearcoat', true, 'supported'],
    ]);
  } finally {
    model.root.destroy();
  }
});

test('glTF imports required IOR, Specular, Sheen, Transmission, and Volume extensions', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.geometryPayloads = [[{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [
      { set: 0, data: new Float32Array([0, 0, 1, 0, 0, 1]) },
      { set: 1, data: new Float32Array([0.25, 0.25, 0.75, 0.25, 0.25, 0.75]) },
    ],
    positionTargets: [],
    normalTargets: [],
  }]];
  parsed.gltf.extensionsUsed = [
    'KHR_texture_transform',
    'KHR_materials_ior',
    'KHR_materials_specular',
    'KHR_materials_sheen',
    'KHR_materials_transmission',
    'KHR_materials_volume',
  ];
  parsed.gltf.extensionsRequired = [
    'KHR_materials_ior',
    'KHR_materials_specular',
    'KHR_materials_sheen',
    'KHR_materials_transmission',
    'KHR_materials_volume',
  ];
  parsed.gltf.textures = [{ sampler: 0 }, { sampler: 1 }];
  parsed.gltf.samplers = [
    { wrapS: 33071, minFilter: 9728 },
    { wrapS: 33648, minFilter: 9729 },
  ];
  parsed.gltf.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_1: 2 };
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.materials = [{
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0, texCoord: 0 },
    },
    extensions: {
      KHR_materials_ior: { ior: 1.33 },
      KHR_materials_specular: {
        specularFactor: 0.65,
        specularTexture: { index: 0, texCoord: 1 },
        specularColorFactor: [1.2, 0.8, 0.6],
        specularColorTexture: {
          index: 1,
          texCoord: 0,
          extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.2, 0.3] } },
        },
      },
      KHR_materials_sheen: {
        sheenColorFactor: [0.8, 0.25, 0.45],
        sheenColorTexture: { index: 1, texCoord: 1 },
        sheenRoughnessFactor: 0.36,
        sheenRoughnessTexture: {
          index: 0,
          texCoord: 0,
          extensions: { KHR_texture_transform: { texCoord: 1, scale: [2, 3] } },
        },
      },
      KHR_materials_transmission: {
        transmissionFactor: 0.72,
        transmissionTexture: { index: 1, texCoord: 1 },
      },
      KHR_materials_volume: {
        thicknessFactor: 0.45,
        thicknessTexture: {
          index: 0,
          texCoord: 0,
          extensions: { KHR_texture_transform: { texCoord: 1, offset: [0.1, 0.2] } },
        },
        attenuationDistance: 2.5,
        attenuationColor: [0.9, 0.65, 0.4],
      },
    },
  }];

  const model = await loadGltfModel('worker://ior-specular.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
    assert.equal(mesh.material.ior, 1.33);
    assert.equal(mesh.material.specularFactor, 0.65);
    assert.deepEqual(mesh.material.specularColorFactor, [1.2, 0.8, 0.6]);
    assert.deepEqual(mesh.material.sheenColorFactor, [0.8, 0.25, 0.45]);
    assert.equal(mesh.material.sheenRoughnessFactor, 0.36);
    assert.equal(mesh.material.getTextureMapping('specular').texCoord, 1);
    assert.deepEqual(mesh.material.getTextureMapping('specularColor'), {
      texCoord: 1,
      offset: [0.2, 0.3],
      rotation: 0,
      scale: [1, 1],
    });
    assert.equal(mesh.material.getTextureSampler('specular').addressModeU, 'clamp-to-edge');
    assert.equal(mesh.material.getTextureSampler('specularColor').addressModeU, 'mirror-repeat');
    assert.equal(mesh.material.getTextureMapping('sheenColor').texCoord, 1);
    assert.deepEqual(mesh.material.getTextureMapping('sheenRoughness'), {
      texCoord: 1,
      offset: [0, 0],
      rotation: 0,
      scale: [2, 3],
    });
    assert.equal(mesh.material.getTextureSampler('sheenColor').addressModeU, 'mirror-repeat');
    assert.equal(mesh.material.getTextureSampler('sheenRoughness').addressModeU, 'clamp-to-edge');
    assert.equal(mesh.material.transmissionFactor, 0.72);
    assert.equal(mesh.material.thicknessFactor, 0.45);
    assert.equal(mesh.material.attenuationDistance, 2.5);
    assert.deepEqual(mesh.material.attenuationColor, [0.9, 0.65, 0.4]);
    assert.equal(mesh.material.getTextureMapping('transmission').texCoord, 1);
    assert.deepEqual(mesh.material.getTextureMapping('thickness'), {
      texCoord: 1,
      offset: [0.1, 0.2],
      rotation: 0,
      scale: [1, 1],
    });
    assert.equal(model.extensionReport.fullySupported, true);
    assert.deepEqual(model.extensionReport.entries.map(entry => [entry.extension, entry.required, entry.disposition]), [
      ['KHR_texture_transform', false, 'supported'],
      ['KHR_materials_ior', true, 'supported'],
      ['KHR_materials_specular', true, 'supported'],
      ['KHR_materials_sheen', true, 'supported'],
      ['KHR_materials_transmission', true, 'supported'],
      ['KHR_materials_volume', true, 'supported'],
    ]);
  } finally {
    model.root.destroy();
  }
});

test('glTF dynamically maps TEXCOORD_2 to a physical PBR UV channel', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const uv2 = new Float32Array([0.2, 0.2, 0.8, 0.2, 0.2, 0.8]);
  parsed.geometryPayloads = [[{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [{ set: 2, data: uv2 }],
    positionTargets: [],
    normalTargets: [],
  }]];
  parsed.gltf.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_2: 1 };
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 2 } } }];

  const model = await loadGltfModel('worker://dynamic-texcoord.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
    assert.deepEqual(Array.from(mesh.geometry.getTextureCoordinates(2)), Array.from(uv2));
    assert.deepEqual(mesh.geometry.textureCoordinateLayout, [2]);
    assert.equal(mesh.geometry.textureCoordinateLayoutKey, '0=TEXCOORD_2');
    assert.equal(mesh.material.getTextureMapping('baseColor').texCoord, 0);
    assert.deepEqual(model.compatibilityReport.uvSemantics[0].mappings, [
      { semantic: 'TEXCOORD_2', set: 2, channel: 0 },
    ]);
  } finally {
    model.root.destroy();
  }
});

test('checked-in real asset preserves dynamic UV semantics in direct and worker payload paths', async () => {
  const source = await readFile(new URL('../../scripts/webgpu-gate/assets/stage11-dynamic-uv-character.gltf', import.meta.url), 'utf8');
  const url = `data:model/gltf+json,${encodeURIComponent(source)}`;
  const direct = await loadGltfModel(url);
  const parsed = await loadParsedGltfAsset(url);
  parsed.geometryPayloads = await prepareGltfGeometryPayloads(parsed.gltf, parsed.buffers);
  const worker = await loadGltfModel('worker://stage11-real-asset.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    for (const model of [direct, worker]) {
      const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
      assert.deepEqual(mesh.geometry.textureCoordinateLayout, [2, 5]);
      assert.deepEqual([...mesh.geometry.textureCoordinates.keys()], [2, 5]);
      assert.equal(mesh.material.getTextureMapping('baseColor').texCoord, 0);
      assert.equal(mesh.material.getTextureMapping('normal').texCoord, 1);
      assert.deepEqual(model.compatibilityReport.uvSemantics[0].referencedSemantics, ['TEXCOORD_2', 'TEXCOORD_5']);
    }
    assert.deepEqual(
      direct.compatibilityReport.uvSemantics[0].mappings,
      worker.compatibilityReport.uvSemantics[0].mappings,
    );
  } finally {
    direct.root.destroy();
    worker.root.destroy();
  }
});

test('Draco decode and worker transfer preserve the same dynamic UV semantic layout', async () => {
  const parsed = {
    gltf: {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_draco_mesh_compression'],
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
      meshes: [{ primitives: [{
        attributes: { POSITION: 0, TEXCOORD_3: 1, TEXCOORD_7: 2 },
        material: 0,
        extensions: {
          KHR_draco_mesh_compression: {
            bufferView: 0,
            attributes: { POSITION: 10, TEXCOORD_3: 11, TEXCOORD_7: 12 },
          },
        },
      }] }],
      materials: [{
        pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 3 } },
        normalTexture: { index: 1, texCoord: 7 },
      }],
      textures: [{}, {}],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
    binaryChunk: null,
    buffers: [new ArrayBuffer(4)],
    baseUrl: 'http://localhost/models/',
  };
  const dracoDecoder = createFakeDynamicUvDracoDecoder();
  const main = await loadGltfModel('worker://draco-main.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
    dracoDecoder,
  });
  const workerPayloads = await prepareGltfGeometryPayloads(parsed.gltf, parsed.buffers, { dracoDecoder });
  const worker = await loadGltfModel('worker://draco-worker.gltf', {
    assetWorker: { async loadParsedAsset() { return { ...parsed, geometryPayloads: workerPayloads }; } },
  });
  try {
    for (const model of [main, worker]) {
      const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
      assert.deepEqual(mesh.geometry.textureCoordinateLayout, [3, 7]);
      assert.deepEqual([...mesh.geometry.textureCoordinates.keys()], [3, 7]);
      assert.deepEqual(model.compatibilityReport.uvSemantics[0].mappings, [
        { semantic: 'TEXCOORD_3', set: 3, channel: 0 },
        { semantic: 'TEXCOORD_7', set: 7, channel: 1 },
      ]);
    }
  } finally {
    main.root.destroy();
    worker.root.destroy();
  }
});

function createFakeDynamicUvDracoDecoder() {
  class Values {
    values = [];
    GetValue(index) { return this.values[index] ?? 0; }
    size() { return this.values.length; }
  }
  const attributes = new Map([
    [10, [0, 0, 0, 1, 0, 0, 0, 1, 0]],
    [11, [0, 0, 1, 0, 0, 1]],
    [12, [0.2, 0.2, 0.8, 0.2, 0.2, 0.8]],
  ]);
  return {
    Decoder: class {
      DecodeBufferToMesh() { return { ok: () => true, error_msg: () => '' }; }
      GetAttributeByUniqueId(_mesh, id) { return { id, size: () => attributes.get(id)?.length ?? 0 }; }
      GetAttributeFloatForAllPoints(_mesh, attribute, out) {
        out.values = attributes.get(attribute.id) ?? [];
        return true;
      }
      GetFaceFromMesh(_mesh, _faceIndex, out) {
        out.values = [0, 1, 2];
        return true;
      }
    },
    DecoderBuffer: class { Init() {} },
    Mesh: class { num_faces() { return 1; } num_points() { return 3; } },
    DracoFloat32Array: Values,
    DracoInt32Array: Values,
    destroy() {},
  };
}

test('glTF rejects primitives whose referenced UV semantics exceed physical channel capacity', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.geometryPayloads = [[{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [0, 2, 4].map(set => ({ set, data: new Float32Array(6) })),
    positionTargets: [],
    normalTargets: [],
  }]];
  parsed.gltf.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_2: 2, TEXCOORD_4: 3 };
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.materials = [{
    pbrMetallicRoughness: {
      baseColorTexture: { index: 0, texCoord: 0 },
      metallicRoughnessTexture: { index: 1, texCoord: 2 },
    },
    normalTexture: { index: 2, texCoord: 4 },
  }];

  await assert.rejects(
    () => loadGltfModel('worker://uv-capacity.gltf', {
      assetWorker: { async loadParsedAsset() { return parsed; } },
    }),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'gltf.meshes[0].primitives[0].attributes'
      && error.context.capacity === 2
      && error.context.referencedSemantics.length === 3,
  );
});

test('glTF rejects a texture mapping when the primitive omits its UV set', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.geometryPayloads = [[{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    textureCoordinates: [{ set: 0, data: new Float32Array([0, 0, 1, 0, 0, 1]) }],
    positionTargets: [],
    normalTargets: [],
  }]];
  parsed.gltf.meshes[0].primitives[0].attributes = { POSITION: 0, TEXCOORD_0: 1 };
  parsed.gltf.meshes[0].primitives[0].material = 0;
  parsed.gltf.materials = [{ normalTexture: { index: 0, texCoord: 1 } }];

  await assert.rejects(
    () => loadGltfModel('worker://missing-texcoord.gltf', {
      assetWorker: { async loadParsedAsset() { return parsed; } },
    }),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'gltf.materials[0].normalTexture.texCoord'
      && error.context.semantic === 'TEXCOORD_1',
  );
});

test('loadGltfModel bypasses asset workers for inline data URLs', async () => {
  const assetWorker = {
    async loadParsedAsset() {
      throw new Error('asset worker should not be used for data URLs');
    },
  };

  const model = await loadGltfModel(createSparsePositionsGltfUrl(), { assetWorker });
  try {
    const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
    assert.ok(mesh);
    assert.equal(mesh.geometry.vertexCount, 3);
  } finally {
    model.root.destroy();
  }
});

test('loadGltfModel resolves inline assets from a srcdoc document base', async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'about:srcdoc' },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { baseURI: 'https://editor.example/player/' },
  });

  try {
    const model = await loadGltfModel(createSparsePositionsGltfUrl());
    model.root.destroy();
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor);
    else delete globalThis.location;
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
  }
});

test('loadGltfModel consumes worker geometry payloads before reading accessors on the main thread', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const workerPositions = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 2, 0,
  ]);
  const workerNormals = new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]);
  const assetWorker = {
    async loadParsedAsset() {
      return {
        ...parsed,
        buffers: [new ArrayBuffer(0)],
        geometryPayloads: [[{
          positions: workerPositions,
          normals: workerNormals,
          textureCoordinates: [],
          positionTargets: [],
          normalTargets: [],
        }]],
      };
    },
  };

  const model = await loadGltfModel('worker://payload.gltf', { assetWorker });
  try {
    const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
    assert.ok(mesh);
    assert.deepEqual(Array.from(mesh.geometry.positions), Array.from(workerPositions));
    assert.deepEqual(Array.from(mesh.geometry.normals), Array.from(workerNormals));
  } finally {
    model.root.destroy();
  }
});

test('loadGltfModel exposes worker transfer, decode, instantiation, and texture phase metrics', async () => {
  const parsed = createSparsePositionsParsedAsset();
  parsed.geometryPayloads = await prepareGltfGeometryPayloads(parsed.gltf, parsed.buffers);
  parsed.metrics = {
    fetchMs: 3,
    parseMs: 2,
    workerParseMs: 4,
    dracoDecodeMs: 1,
    geometryPreparationMs: 3,
    sourceBytes: 128,
    workerTransferBytes: 256,
    workerTransferBufferCount: 3,
  };
  const model = await loadGltfModel('worker://metrics.gltf', {
    assetWorker: { async loadParsedAsset() { return parsed; } },
  });
  try {
    assert.equal(model.loadMetrics.timings.fetchMs, 3);
    assert.equal(model.loadMetrics.timings.workerParseMs, 4);
    assert.equal(model.loadMetrics.timings.dracoDecodeMs, 1);
    assert.ok(model.loadMetrics.timings.instantiateMs >= 0);
    assert.ok(model.loadMetrics.timings.textureDecodeTranscodeUploadMs >= 0);
    assert.ok(model.loadMetrics.timings.totalMs >= 0);
    assert.equal(model.loadMetrics.sourceBytes, 128);
    assert.equal(model.loadMetrics.workerTransferBytes, 256);
    assert.equal(model.loadMetrics.workerTransferBufferCount, 3);
    assert.ok(model.loadMetrics.decodedGeometryBytes > 0);
  } finally {
    disposeGltfModel(model);
  }
});

test('GltfAssetWorkerClient forwards cloneable Draco decoder config to worker requests', async () => {
  class FakeWorker {
    listeners = new Set();
    messages = [];

    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => {
        for (const listener of this.listeners) {
          listener({ data: { version: 1, id: message.id, ok: true, value: createSparsePositionsParsedAsset() } });
        }
      });
    }

    addEventListener(type, listener) {
      if (type === 'message') this.listeners.add(listener);
    }

    removeEventListener(type, listener) {
      if (type === 'message') this.listeners.delete(listener);
    }
  }

  const worker = new FakeWorker();
  const client = new GltfAssetWorkerClient(worker);
  const wasmBinary = new Uint8Array([1, 2, 3, 4]);
  const parsed = await client.loadParsedAsset('worker://draco.gltf', {
    dracoDecoderConfig: {
      scriptUrl: '/draco/draco_decoder_gltf.js',
      wasmBinary,
      locateFile: () => 'ignored-in-worker-message',
    },
  });
  assert.equal(parsed.gltf.asset.version, '2.0');
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].dracoDecoderConfig.scriptUrl, '/draco/draco_decoder_gltf.js');
  assert.deepEqual(Array.from(worker.messages[0].dracoDecoderConfig.wasmBinary), [1, 2, 3, 4]);
  assert.equal('locateFile' in worker.messages[0].dracoDecoderConfig, false);
  client.dispose({ terminate: false });
});

test('production glTF worker records transfer bytes and discards runtime-unneeded source buffers', () => {
  const source = createGltfAssetWorkerSource('https://assets.example/components-gltf.js');
  assert.match(source, /workerTransferBytes/);
  assert.match(source, /workerTransferBufferCount/);
  assert.match(source, /requiresRuntimeSourceBuffers/);
  assert.match(source, /value\.buffers = \[\]/);
  assert.match(source, /gltf\.animations/);
  assert.match(source, /image\.bufferView/);
  assert.match(source, /skin\.inverseBindMatrices/);
});

test('GltfAssetWorkerClient restores structured errors and rejects malformed payloads', async () => {
  class FakeWorker {
    listeners = new Set();
    mode = 'error';

    postMessage(message) {
      queueMicrotask(() => {
        const data = this.mode === 'error'
            ? {
              version: 1,
              id: message.id,
              ok: false,
              error: {
                name: 'EngineError',
                domain: 'component',
                code: 'E_ASSET_INVALID_DATA',
                message: 'Missing accessor 3.',
                recoverable: false,
                recovery: 'release-resource',
                context: { url: message.src, resourceType: 'model/gltf', accessor: 3 },
                path: 'gltf.accessors[3]',
              },
            }
          : { version: 1, id: message.id, ok: true, value: { gltf: null } };
        for (const listener of this.listeners) listener({ data });
      });
    }

    addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
    removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
  }

  const worker = new FakeWorker();
  const client = new GltfAssetWorkerClient(worker);
  await assert.rejects(
    () => client.loadParsedAsset('worker://broken.gltf'),
    error => error.code === 'E_ASSET_INVALID_DATA'
      && error.path === 'gltf.accessors[3]'
      && error.context.accessor === 3
      && error.recovery === 'release-resource',
  );
  worker.mode = 'malformed';
  await assert.rejects(
    () => client.loadParsedAsset('worker://malformed.gltf'),
    error => error.code === 'E_WORKER_PROTOCOL_INVALID'
      && error.path === 'gltf.worker.response.value'
      && error.recovery === 'terminate-runtime',
  );
  client.dispose({ terminate: false });
});

test('loadGltfModel accepts absolute blob buffer URIs without depending on baseUrl', async () => {
  const parsed = createSparsePositionsParsedAsset();
  const bytes = new Uint8Array(parsed.buffers[0]);
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const gltf = {
    ...parsed.gltf,
    buffers: [{ uri: blobUrl, byteLength: bytes.byteLength }],
  };
  const gltfUrl = `data:model/gltf+json;base64,${btoa(JSON.stringify(gltf))}`;

  try {
    const model = await loadGltfModel(gltfUrl);
    try {
      const mesh = model.root.children[0].children[0].getComponent(Mesh3D);
      assert.ok(mesh);
      assert.deepEqual(Array.from(mesh.geometry.positions), [
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
      ]);
    } finally {
      model.root.destroy();
    }
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
});
