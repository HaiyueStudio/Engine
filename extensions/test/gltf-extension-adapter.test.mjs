import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GLTF_EXTENSION_ADAPTERS,
  collectGltfMaterialExtensionPatches,
  collectGltfMaterialVariantNames,
  collectGltfMaterialVariantReferences,
  resolveGltfExtensionAdapters,
} from '../dist/gltf.js';

test('default glTF extension adapters expose layered material and variants contracts', () => {
  const gltf = {
    asset: { version: '2.0' },
    extensions: { KHR_materials_variants: { variants: [{ name: 'Night' }] } },
  };
  const primitive = {
    attributes: { POSITION: 0 },
    extensions: { KHR_materials_variants: { mappings: [{ material: 4, variants: [0] }] } },
  };
  const material = {
    extensions: {
      KHR_materials_clearcoat: {
        clearcoatFactor: 0.8,
        clearcoatRoughnessFactor: 0.2,
        clearcoatNormalTexture: { index: 7, scale: 0.5 },
      },
    },
  };

  const patches = collectGltfMaterialExtensionPatches(
    gltf,
    material,
    primitive,
    'gltf.materials[2]',
    DEFAULT_GLTF_EXTENSION_ADAPTERS,
  );
  assert.deepEqual(patches, [{
    state: { clearcoatFactor: 0.8, clearcoatRoughnessFactor: 0.2, clearcoatNormalScale: 0.5 },
    textures: [{
      slot: 'clearcoatNormal',
      textureInfo: { index: 7, scale: 0.5 },
      path: 'gltf.materials[2].extensions.KHR_materials_clearcoat.clearcoatNormalTexture',
    }],
  }]);
  assert.deepEqual(
    collectGltfMaterialVariantReferences(gltf, primitive, DEFAULT_GLTF_EXTENSION_ADAPTERS),
    [{ name: 'Night', materialIndex: 4 }],
  );
  assert.deepEqual(
    collectGltfMaterialVariantNames(gltf, DEFAULT_GLTF_EXTENSION_ADAPTERS),
    ['Night'],
  );
  assert.equal(
    DEFAULT_GLTF_EXTENSION_ADAPTERS.find(adapter => adapter.extension === 'KHR_materials_ior').capability.support,
    'supported',
  );
  assert.equal(
    DEFAULT_GLTF_EXTENSION_ADAPTERS.find(adapter => adapter.extension === 'KHR_materials_specular').capability.support,
    'supported',
  );
  assert.equal(
    DEFAULT_GLTF_EXTENSION_ADAPTERS.find(adapter => adapter.extension === 'KHR_materials_sheen').capability.support,
    'supported',
  );
  assert.equal(
    DEFAULT_GLTF_EXTENSION_ADAPTERS.find(adapter => adapter.extension === 'KHR_materials_transmission').capability.support,
    'supported',
  );
  assert.equal(
    DEFAULT_GLTF_EXTENSION_ADAPTERS.find(adapter => adapter.extension === 'KHR_materials_volume').capability.support,
    'supported',
  );
});

test('per-load adapter resolution is immutable and replaces defaults by extension id', () => {
  const replacement = {
    extension: 'KHR_materials_clearcoat',
    capability: { support: 'unsupported', note: 'Disabled for this product.' },
  };
  const resolved = resolveGltfExtensionAdapters([replacement]);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.find(adapter => adapter.extension === replacement.extension)), true);
  assert.equal(Object.isFrozen(resolved.find(adapter => adapter.extension === replacement.extension).capability), true);
  assert.equal(resolved.filter(adapter => adapter.extension === replacement.extension).length, 1);
  assert.equal(resolved.find(adapter => adapter.extension === replacement.extension).capability.support, 'unsupported');
  assert.throws(
    () => resolveGltfExtensionAdapters([{ extension: '  ', capability: replacement.capability }]),
    /must not be empty/,
  );
});

test('transmission and volume adapters preserve factors, attenuation, and texture channels', () => {
  const gltf = { asset: { version: '2.0' } };
  const primitive = { attributes: { POSITION: 0 } };
  const material = {
    extensions: {
      KHR_materials_transmission: {
        transmissionFactor: 0.7,
        transmissionTexture: { index: 2, texCoord: 1 },
      },
      KHR_materials_volume: {
        thicknessFactor: 0.4,
        thicknessTexture: { index: 3 },
        attenuationDistance: 2.5,
        attenuationColor: [0.9, 0.6, 0.3],
      },
    },
  };
  const patches = collectGltfMaterialExtensionPatches(
    gltf,
    material,
    primitive,
    'gltf.materials[0]',
    DEFAULT_GLTF_EXTENSION_ADAPTERS,
  );
  assert.deepEqual(patches, [
    {
      state: { transmissionFactor: 0.7 },
      textures: [{
        slot: 'transmission',
        textureInfo: { index: 2, texCoord: 1 },
        path: 'gltf.materials[0].extensions.KHR_materials_transmission.transmissionTexture',
      }],
    },
    {
      state: {
        thicknessFactor: 0.4,
        attenuationDistance: 2.5,
        attenuationColor: [0.9, 0.6, 0.3],
      },
      textures: [{
        slot: 'thickness',
        textureInfo: { index: 3 },
        path: 'gltf.materials[0].extensions.KHR_materials_volume.thicknessTexture',
      }],
    },
  ]);
});
