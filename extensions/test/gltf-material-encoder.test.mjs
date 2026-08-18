import assert from 'node:assert/strict';
import test from 'node:test';
import { PbrMaterial } from '@haiyue/engine';
import { encodeGltfPbrMaterial } from '../dist/gltf.js';

test('glTF PBR material encoder emits IOR, Specular, Sheen, Transmission, Volume, texture channels, and transforms', () => {
  const material = new PbrMaterial({
    baseColor: [0.5, 0.25, 0.75, 1],
    metallic: 0.2,
    roughness: 0.45,
    ior: 1.33,
    specularFactor: 0.65,
    specularColorFactor: [1.2, 0.8, 0.6],
    specularTexture: 'specular.png',
    specularColorTexture: 'specular-color.png',
    sheenColorFactor: [0.8, 0.25, 0.45],
    sheenRoughnessFactor: 0.36,
    sheenColorTexture: 'sheen-color.png',
    sheenRoughnessTexture: 'sheen-roughness.png',
    transmissionFactor: 0.72,
    transmissionTexture: 'transmission.png',
    thicknessFactor: 0.45,
    thicknessTexture: 'thickness.png',
    attenuationDistance: 2.5,
    attenuationColor: [0.9, 0.65, 0.4],
    textureMappings: {
      specular: { texCoord: 1 },
      specularColor: { texCoord: 1, offset: [0.2, 0.3], rotation: 0.4, scale: [2, 3] },
      sheenColor: { texCoord: 1, offset: [0.1, 0.15] },
      sheenRoughness: { texCoord: 1 },
      transmission: { texCoord: 1 },
      thickness: { texCoord: 1, scale: [0.5, 0.5] },
    },
  });
  const indices = new Map([
    ['specular.png', 7],
    ['specular-color.png', 8],
    ['sheen-color.png', 9],
    ['sheen-roughness.png', 10],
    ['transmission.png', 11],
    ['thickness.png', 12],
  ]);
  const encoded = encodeGltfPbrMaterial(material, {
    name: 'Dielectric',
    resolveTextureIndex: (_slot, source) => indices.get(source),
  });

  assert.equal(encoded.material.name, 'Dielectric');
  assert.equal(encoded.material.pbrMetallicRoughness.metallicFactor, 0.2);
  assert.equal(encoded.material.pbrMetallicRoughness.roughnessFactor, 0.45);
  assert.deepEqual(encoded.material.extensions.KHR_materials_ior, { ior: 1.33 });
  assert.deepEqual(encoded.material.extensions.KHR_materials_specular, {
    specularFactor: 0.65,
    specularTexture: { index: 7, texCoord: 1 },
    specularColorFactor: [1.2, 0.8, 0.6],
    specularColorTexture: {
      index: 8,
      texCoord: 1,
      extensions: {
        KHR_texture_transform: {
          offset: [0.2, 0.3],
          rotation: 0.4,
          scale: [2, 3],
        },
      },
    },
  });
  assert.deepEqual(encoded.material.extensions.KHR_materials_sheen, {
    sheenColorFactor: [0.8, 0.25, 0.45],
    sheenColorTexture: {
      index: 9,
      texCoord: 1,
      extensions: { KHR_texture_transform: { offset: [0.1, 0.15] } },
    },
    sheenRoughnessFactor: 0.36,
    sheenRoughnessTexture: { index: 10, texCoord: 1 },
  });
  assert.deepEqual(encoded.material.extensions.KHR_materials_transmission, {
    transmissionFactor: 0.72,
    transmissionTexture: { index: 11, texCoord: 1 },
  });
  assert.deepEqual(encoded.material.extensions.KHR_materials_volume, {
    thicknessFactor: 0.45,
    thicknessTexture: {
      index: 12,
      texCoord: 1,
      extensions: { KHR_texture_transform: { scale: [0.5, 0.5] } },
    },
    attenuationDistance: 2.5,
    attenuationColor: [0.9, 0.65, 0.4],
  });
  assert.deepEqual(encoded.extensionsUsed, [
    'KHR_texture_transform',
    'KHR_materials_ior',
    'KHR_materials_specular',
    'KHR_materials_sheen',
    'KHR_materials_transmission',
    'KHR_materials_volume',
  ]);
});

test('glTF PBR material encoder omits default advanced material extensions', () => {
  const encoded = encodeGltfPbrMaterial(new PbrMaterial(), {
    resolveTextureIndex() {
      throw new Error('default material has no textures');
    },
  });
  assert.equal(encoded.material.extensions, undefined);
  assert.deepEqual(encoded.extensionsUsed, []);
});
