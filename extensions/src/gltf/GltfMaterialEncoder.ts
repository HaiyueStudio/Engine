import type { MaterialTextureSource, PbrMaterial, PbrTextureSlot } from '@haiyue/engine/material';
import type { GltfMaterial, GltfTextureInfo, GltfTextureTransform } from './GltfSchema';

export interface EncodeGltfPbrMaterialOptions {
  readonly name?: string;
  /**
   * Resolves an engine texture source to the texture index already allocated
   * by the surrounding glTF/GLB exporter.
   */
  readonly resolveTextureIndex: (slot: PbrTextureSlot, source: MaterialTextureSource) => number;
}

export interface EncodedGltfPbrMaterial {
  readonly material: GltfMaterial;
  readonly extensionsUsed: readonly string[];
}

/**
 * Encodes the standard glTF material portion without taking ownership of image,
 * sampler, or buffer allocation. Scene exporters can share this codec instead
 * of duplicating KHR material semantics.
 */
export function encodeGltfPbrMaterial(
  material: PbrMaterial,
  options: EncodeGltfPbrMaterialOptions,
): EncodedGltfPbrMaterial {
  const extensionsUsed = new Set<string>();
  const texture = (slot: PbrTextureSlot, source: MaterialTextureSource): GltfTextureInfo | undefined => {
    if (!source) return undefined;
    const index = options.resolveTextureIndex(slot, source);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError(`glTF texture index for PBR slot "${slot}" must be a non-negative safe integer.`);
    }
    return encodeTextureInfo(material, slot, index, extensionsUsed);
  };

  const baseColor = new Float32Array(4);
  material.baseColor.writeLinear(baseColor);
  const baseColorTexture = texture('baseColor', material.baseColorTexture);
  const metallicRoughnessTexture = texture('metallicRoughness', material.metallicRoughnessTexture);
  const normalTexture = texture('normal', material.normalTexture);
  const occlusionTexture = texture('occlusion', material.occlusionTexture);
  const emissiveTexture = texture('emissive', material.emissiveTexture);
  const clearcoatTexture = texture('clearcoat', material.clearcoatTexture);
  const clearcoatRoughnessTexture = texture('clearcoatRoughness', material.clearcoatRoughnessTexture);
  const clearcoatNormalTexture = texture('clearcoatNormal', material.clearcoatNormalTexture);
  const specularTexture = texture('specular', material.specularTexture);
  const specularColorTexture = texture('specularColor', material.specularColorTexture);
  const sheenColorTexture = texture('sheenColor', material.sheenColorTexture);
  const sheenRoughnessTexture = texture('sheenRoughness', material.sheenRoughnessTexture);
  const transmissionTexture = texture('transmission', material.transmissionTexture);
  const thicknessTexture = texture('thickness', material.thicknessTexture);

  const extensions: NonNullable<GltfMaterial['extensions']> = {};
  if (
    material.clearcoatFactor !== 0
    || material.clearcoatRoughnessFactor !== 0
    || clearcoatTexture
    || clearcoatRoughnessTexture
    || clearcoatNormalTexture
  ) {
    extensions.KHR_materials_clearcoat = {
      clearcoatFactor: material.clearcoatFactor,
      ...(clearcoatTexture ? { clearcoatTexture } : {}),
      clearcoatRoughnessFactor: material.clearcoatRoughnessFactor,
      ...(clearcoatRoughnessTexture ? { clearcoatRoughnessTexture } : {}),
      ...(clearcoatNormalTexture ? {
        clearcoatNormalTexture: { ...clearcoatNormalTexture, scale: material.clearcoatNormalScale },
      } : {}),
    };
    extensionsUsed.add('KHR_materials_clearcoat');
  }
  if (material.ior !== 1.5) {
    extensions.KHR_materials_ior = { ior: material.ior };
    extensionsUsed.add('KHR_materials_ior');
  }
  if (
    material.specularFactor !== 1
    || material.specularColorFactor.some(channel => channel !== 1)
    || specularTexture
    || specularColorTexture
  ) {
    extensions.KHR_materials_specular = {
      specularFactor: material.specularFactor,
      ...(specularTexture ? { specularTexture } : {}),
      specularColorFactor: [...material.specularColorFactor],
      ...(specularColorTexture ? { specularColorTexture } : {}),
    };
    extensionsUsed.add('KHR_materials_specular');
  }
  if (
    material.sheenColorFactor.some(channel => channel !== 0)
    || material.sheenRoughnessFactor !== 0
    || sheenColorTexture
    || sheenRoughnessTexture
  ) {
    extensions.KHR_materials_sheen = {
      sheenColorFactor: [...material.sheenColorFactor],
      ...(sheenColorTexture ? { sheenColorTexture } : {}),
      sheenRoughnessFactor: material.sheenRoughnessFactor,
      ...(sheenRoughnessTexture ? { sheenRoughnessTexture } : {}),
    };
    extensionsUsed.add('KHR_materials_sheen');
  }
  if (material.transmissionFactor !== 0 || transmissionTexture) {
    extensions.KHR_materials_transmission = {
      transmissionFactor: material.transmissionFactor,
      ...(transmissionTexture ? { transmissionTexture } : {}),
    };
    extensionsUsed.add('KHR_materials_transmission');
  }
  if (
    material.thicknessFactor !== 0
    || thicknessTexture
    || material.attenuationDistance !== Infinity
    || material.attenuationColor.some(channel => channel !== 1)
  ) {
    extensions.KHR_materials_volume = {
      thicknessFactor: material.thicknessFactor,
      ...(thicknessTexture ? { thicknessTexture } : {}),
      ...(material.attenuationDistance === Infinity ? {} : { attenuationDistance: material.attenuationDistance }),
      attenuationColor: [...material.attenuationColor],
    };
    extensionsUsed.add('KHR_materials_volume');
    if (material.transmissionFactor === 0 && !transmissionTexture) {
      extensions.KHR_materials_transmission = { transmissionFactor: 0 };
      extensionsUsed.add('KHR_materials_transmission');
    }
  }

  const gltfMaterial: GltfMaterial = {
    ...(options.name ? { name: options.name } : {}),
    pbrMetallicRoughness: {
      baseColorFactor: [baseColor[0]!, baseColor[1]!, baseColor[2]!, baseColor[3]!],
      ...(baseColorTexture ? { baseColorTexture } : {}),
      ...(metallicRoughnessTexture ? { metallicRoughnessTexture } : {}),
      metallicFactor: material.metallic,
      roughnessFactor: material.roughness,
    },
    emissiveFactor: [...material.emissiveFactor],
    ...(emissiveTexture ? { emissiveTexture } : {}),
    ...(normalTexture ? { normalTexture: { ...normalTexture, scale: material.normalScale } } : {}),
    ...(occlusionTexture ? { occlusionTexture: { ...occlusionTexture, strength: material.occlusionStrength } } : {}),
    alphaMode: material.alphaMode === 'blend' ? 'BLEND' : material.alphaMode === 'mask' ? 'MASK' : 'OPAQUE',
    ...(material.alphaMode === 'mask' ? { alphaCutoff: material.alphaCutoff } : {}),
    doubleSided: material.doubleSided,
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
  return Object.freeze({
    material: gltfMaterial,
    extensionsUsed: Object.freeze([...extensionsUsed]),
  });
}

function encodeTextureInfo(
  material: PbrMaterial,
  slot: PbrTextureSlot,
  index: number,
  extensionsUsed: Set<string>,
): GltfTextureInfo {
  const mapping = material.getTextureMapping(slot);
  const transform: GltfTextureTransform = {};
  if (mapping.offset[0] !== 0 || mapping.offset[1] !== 0) transform.offset = [...mapping.offset];
  if (mapping.rotation !== 0) transform.rotation = mapping.rotation;
  if (mapping.scale[0] !== 1 || mapping.scale[1] !== 1) transform.scale = [...mapping.scale];
  const transformed = Object.keys(transform).length > 0;
  if (transformed) extensionsUsed.add('KHR_texture_transform');
  return {
    index,
    ...(mapping.texCoord !== 0 ? { texCoord: mapping.texCoord } : {}),
    ...(transformed ? { extensions: { KHR_texture_transform: transform } } : {}),
  };
}
