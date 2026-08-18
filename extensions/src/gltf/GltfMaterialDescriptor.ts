import { ColorSRGB } from '@haiyue/engine';
import { type MaterialDescriptor, type MaterialTextureSource, type PbrMaterialState, type PbrTextureMappingOptions, type PbrTextureMappings, type PbrTextureSamplers, type PbrTextureSlot } from '@haiyue/engine/material';
import type { GltfAsset, GltfMaterial, GltfPrimitive, GltfTextureInfo } from './GltfSchema';
import {
  collectGltfMaterialExtensionPatches,
  type GltfExtensionAdapter,
  type GltfMaterialTextureBinding,
} from './GltfExtensionAdapter';

export interface ResolvedGltfMaterialTexture {
  readonly source: MaterialTextureSource;
  readonly mapping: PbrTextureMappingOptions;
  readonly sampler: GPUSamplerDescriptor | null;
}

export interface GltfMaterialDescriptorInput {
  readonly gltf: GltfAsset;
  readonly material: GltfMaterial | null;
  readonly primitive: GltfPrimitive;
  readonly materialPath: string;
  readonly defaultBaseColor?: readonly [number, number, number, number];
  readonly adapters: readonly GltfExtensionAdapter[];
  readonly resolveTexture: (binding: GltfMaterialTextureBinding) => ResolvedGltfMaterialTexture;
}

const textureStateKeys: Readonly<Record<PbrTextureSlot, keyof PbrMaterialState>> = Object.freeze({
  baseColor: 'baseColorTexture',
  metallicRoughness: 'metallicRoughnessTexture',
  normal: 'normalTexture',
  occlusion: 'occlusionTexture',
  emissive: 'emissiveTexture',
  clearcoat: 'clearcoatTexture',
  clearcoatRoughness: 'clearcoatRoughnessTexture',
  clearcoatNormal: 'clearcoatNormalTexture',
  specular: 'specularTexture',
  specularColor: 'specularColorTexture',
  sheenColor: 'sheenColorTexture',
  sheenRoughness: 'sheenRoughnessTexture',
  transmission: 'transmissionTexture',
  thickness: 'thicknessTexture',
});

/** Compiles glTF core material data and extension patches into one engine descriptor. */
export function createGltfMaterialDescriptor(
  input: GltfMaterialDescriptorInput,
): Extract<MaterialDescriptor, { shadingModel: 'pbr-metallic-roughness' }> {
  const { material } = input;
  const pbr = material?.pbrMetallicRoughness;
  const state: PbrMaterialState = {
    baseColor: pbr?.baseColorFactor
      ? linearBaseColorFactorToSrgb(pbr.baseColorFactor)
      : input.defaultBaseColor ?? [1, 1, 1, 1],
    metallic: pbr?.metallicFactor ?? 1,
    roughness: pbr?.roughnessFactor ?? 1,
    normalScale: material?.normalTexture?.scale ?? 1,
    occlusionStrength: material?.occlusionTexture?.strength ?? 1,
    emissiveFactor: material?.emissiveFactor ?? [0, 0, 0],
    alphaMode: material?.alphaMode === 'BLEND' ? 'blend' : material?.alphaMode === 'MASK' ? 'mask' : 'opaque',
    alphaCutoff: material?.alphaCutoff ?? 0.5,
    doubleSided: material?.doubleSided ?? false,
  };
  const patches = collectGltfMaterialExtensionPatches(
    input.gltf,
    material,
    input.primitive,
    input.materialPath,
    input.adapters,
  );
  const textureMappings: Partial<Record<PbrTextureSlot, PbrTextureMappingOptions>> = {};
  const samplers: Partial<Record<PbrTextureSlot, GPUSamplerDescriptor | null>> = {};
  for (const patch of patches) {
    Object.assign(state, patch.state);
  }
  for (const binding of collectGltfMaterialTextureBindings(
    input.gltf,
    material,
    input.primitive,
    input.materialPath,
    input.adapters,
  )) {
    const texture = input.resolveTexture(binding);
    state[textureStateKeys[binding.slot]] = texture.source as never;
    textureMappings[binding.slot] = texture.mapping;
    samplers[binding.slot] = texture.sampler;
  }
  if (Object.keys(textureMappings).length > 0) state.textureMappings = textureMappings as PbrTextureMappings;
  if (Object.keys(samplers).length > 0) state.samplers = samplers as PbrTextureSamplers;
  return Object.freeze({
    shadingModel: 'pbr-metallic-roughness',
    state: Object.freeze(state),
  });
}

/** Shared semantic source for preload, UV planning, and descriptor compilation. */
export function collectGltfMaterialTextureBindings(
  gltf: GltfAsset,
  material: GltfMaterial | null,
  primitive: GltfPrimitive,
  materialPath: string,
  adapters: readonly GltfExtensionAdapter[],
): readonly GltfMaterialTextureBinding[] {
  if (!material) return Object.freeze([]);
  const pbr = material.pbrMetallicRoughness;
  const bindings: GltfMaterialTextureBinding[] = [];
  addTexture(bindings, 'baseColor', pbr?.baseColorTexture, `${materialPath}.pbrMetallicRoughness.baseColorTexture`);
  addTexture(bindings, 'metallicRoughness', pbr?.metallicRoughnessTexture, `${materialPath}.pbrMetallicRoughness.metallicRoughnessTexture`);
  addTexture(bindings, 'normal', material.normalTexture, `${materialPath}.normalTexture`);
  addTexture(bindings, 'occlusion', material.occlusionTexture, `${materialPath}.occlusionTexture`);
  addTexture(bindings, 'emissive', material.emissiveTexture, `${materialPath}.emissiveTexture`);
  for (const patch of collectGltfMaterialExtensionPatches(gltf, material, primitive, materialPath, adapters)) {
    bindings.push(...patch.textures ?? []);
  }
  return Object.freeze(bindings);
}

function addTexture(
  bindings: GltfMaterialTextureBinding[],
  slot: PbrTextureSlot,
  textureInfo: GltfTextureInfo | undefined,
  path: string,
): void {
  if (textureInfo) bindings.push(Object.freeze({ slot, textureInfo, path }));
}

function linearBaseColorFactorToSrgb(
  value: readonly [number, number, number, number],
): [number, number, number, number] {
  return [
    ColorSRGB.linearToSRGB(value[0]),
    ColorSRGB.linearToSRGB(value[1]),
    ColorSRGB.linearToSRGB(value[2]),
    value[3],
  ];
}
