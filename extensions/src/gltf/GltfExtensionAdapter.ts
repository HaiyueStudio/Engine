import type { PbrMaterialState, PbrTextureSlot } from '@haiyue/engine/material';
import type { GltfAsset, GltfMaterial, GltfPrimitive, GltfTextureInfo } from './GltfSchema';

export type GltfExtensionSupport = 'supported' | 'partial' | 'unsupported';

export interface GltfExtensionCapability {
  readonly support: GltfExtensionSupport;
  readonly note: string;
}

export interface GltfMaterialTextureBinding {
  readonly slot: PbrTextureSlot;
  readonly textureInfo: GltfTextureInfo;
  readonly path: string;
}

export interface GltfMaterialExtensionContext {
  readonly gltf: GltfAsset;
  readonly material: GltfMaterial;
  readonly primitive: GltfPrimitive;
  readonly materialPath: string;
  readonly extensionData: unknown;
}

export type GltfMaterialStatePatch = Readonly<Partial<Omit<PbrMaterialState,
  | 'baseColorTexture'
  | 'metallicRoughnessTexture'
  | 'normalTexture'
  | 'occlusionTexture'
  | 'emissiveTexture'
  | 'clearcoatTexture'
  | 'clearcoatRoughnessTexture'
  | 'clearcoatNormalTexture'
  | 'specularTexture'
  | 'specularColorTexture'
  | 'sheenColorTexture'
  | 'sheenRoughnessTexture'
  | 'transmissionTexture'
  | 'thicknessTexture'
  | 'textureMappings'
  | 'samplers'
  | 'sampler'
>>>;

export interface GltfMaterialExtensionPatch {
  /** Pure material parameters. Texture ownership must use `textures`. */
  readonly state?: GltfMaterialStatePatch;
  readonly textures?: readonly GltfMaterialTextureBinding[];
}

export interface GltfMaterialVariantReference {
  readonly name: string;
  readonly materialIndex: number;
}

export interface GltfPrimitiveExtensionContext {
  readonly gltf: GltfAsset;
  readonly primitive: GltfPrimitive;
  readonly rootExtensionData: unknown;
  readonly primitiveExtensionData: unknown;
}

/**
 * A stateless glTF extension adapter. Hooks return declarative patches and
 * references; resource ownership and concrete material creation stay in the
 * loader and engine respectively.
 */
export interface GltfExtensionAdapter {
  readonly extension: string;
  readonly capability: GltfExtensionCapability;
  readonly extendMaterial?: (context: GltfMaterialExtensionContext) => GltfMaterialExtensionPatch | null;
  readonly collectMaterialVariantNames?: (gltf: GltfAsset, rootExtensionData: unknown) => readonly string[];
  readonly collectMaterialVariants?: (context: GltfPrimitiveExtensionContext) => readonly GltfMaterialVariantReference[];
}

const clearcoatAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_clearcoat',
  capability: Object.freeze({ support: 'supported', note: 'Imported as a native layered PBR clearcoat lobe.' }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const clearcoat = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_clearcoat'];
    if (!clearcoat) return null;
    const basePath = `${context.materialPath}.extensions.KHR_materials_clearcoat`;
    const textures: GltfMaterialTextureBinding[] = [];
    if (clearcoat.clearcoatTexture) textures.push({
      slot: 'clearcoat',
      textureInfo: clearcoat.clearcoatTexture,
      path: `${basePath}.clearcoatTexture`,
    });
    if (clearcoat.clearcoatRoughnessTexture) textures.push({
      slot: 'clearcoatRoughness',
      textureInfo: clearcoat.clearcoatRoughnessTexture,
      path: `${basePath}.clearcoatRoughnessTexture`,
    });
    if (clearcoat.clearcoatNormalTexture) textures.push({
      slot: 'clearcoatNormal',
      textureInfo: clearcoat.clearcoatNormalTexture,
      path: `${basePath}.clearcoatNormalTexture`,
    });
    return {
      state: {
        clearcoatFactor: clearcoat.clearcoatFactor ?? 0,
        clearcoatRoughnessFactor: clearcoat.clearcoatRoughnessFactor ?? 0,
        clearcoatNormalScale: clearcoat.clearcoatNormalTexture?.scale ?? 1,
      },
      textures: Object.freeze(textures),
    };
  },
});

const iorAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_ior',
  capability: Object.freeze({ support: 'supported', note: 'Imported into the native dielectric Fresnel IOR parameter.' }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const ior = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_ior'];
    if (!ior) return null;
    return { state: { ior: ior.ior ?? 1.5 } };
  },
});

const specularAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_specular',
  capability: Object.freeze({ support: 'supported', note: 'Imported into the native dielectric specular BRDF.' }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const specular = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_specular'];
    if (!specular) return null;
    const basePath = `${context.materialPath}.extensions.KHR_materials_specular`;
    const textures: GltfMaterialTextureBinding[] = [];
    if (specular.specularTexture) textures.push({
      slot: 'specular',
      textureInfo: specular.specularTexture,
      path: `${basePath}.specularTexture`,
    });
    if (specular.specularColorTexture) textures.push({
      slot: 'specularColor',
      textureInfo: specular.specularColorTexture,
      path: `${basePath}.specularColorTexture`,
    });
    return {
      state: {
        specularFactor: specular.specularFactor ?? 1,
        specularColorFactor: specular.specularColorFactor ?? [1, 1, 1],
      },
      textures: Object.freeze(textures),
    };
  },
});

const sheenAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_sheen',
  capability: Object.freeze({ support: 'supported', note: 'Imported as a native Charlie sheen layer with direct-light and IBL energy compensation.' }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const sheen = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_sheen'];
    if (!sheen) return null;
    const basePath = `${context.materialPath}.extensions.KHR_materials_sheen`;
    const textures: GltfMaterialTextureBinding[] = [];
    if (sheen.sheenColorTexture) textures.push({
      slot: 'sheenColor',
      textureInfo: sheen.sheenColorTexture,
      path: `${basePath}.sheenColorTexture`,
    });
    if (sheen.sheenRoughnessTexture) textures.push({
      slot: 'sheenRoughness',
      textureInfo: sheen.sheenRoughnessTexture,
      path: `${basePath}.sheenRoughnessTexture`,
    });
    return {
      state: {
        sheenColorFactor: sheen.sheenColorFactor ?? [0, 0, 0],
        sheenRoughnessFactor: sheen.sheenRoughnessFactor ?? 0,
      },
      textures: Object.freeze(textures),
    };
  },
});

const transmissionAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_transmission',
  capability: Object.freeze({
    support: 'supported',
    note: 'Imported into the native screen-space scene-color path; combined Sheen keeps factor BRDF but omits Sheen texture sampling to stay within the WebGPU minimum binding budget.',
  }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const transmission = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_transmission'];
    if (!transmission) return null;
    const basePath = `${context.materialPath}.extensions.KHR_materials_transmission`;
    return {
      state: { transmissionFactor: transmission.transmissionFactor ?? 0 },
      textures: transmission.transmissionTexture ? Object.freeze([{
        slot: 'transmission' as const,
        textureInfo: transmission.transmissionTexture,
        path: `${basePath}.transmissionTexture`,
      }]) : Object.freeze([]),
    };
  },
});

const volumeAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_volume',
  capability: Object.freeze({ support: 'supported', note: 'Imported with thickness and Beer-Lambert attenuation in the native transmission path.' }),
  extendMaterial(context: GltfMaterialExtensionContext) {
    const volume = context.extensionData as NonNullable<GltfMaterial['extensions']>['KHR_materials_volume'];
    if (!volume) return null;
    const basePath = `${context.materialPath}.extensions.KHR_materials_volume`;
    return {
      state: {
        thicknessFactor: volume.thicknessFactor ?? 0,
        attenuationDistance: volume.attenuationDistance ?? Infinity,
        attenuationColor: volume.attenuationColor ?? [1, 1, 1],
      },
      textures: volume.thicknessTexture ? Object.freeze([{
        slot: 'thickness' as const,
        textureInfo: volume.thicknessTexture,
        path: `${basePath}.thicknessTexture`,
      }]) : Object.freeze([]),
    };
  },
});

const variantsAdapter: GltfExtensionAdapter = Object.freeze({
  extension: 'KHR_materials_variants',
  capability: Object.freeze({ support: 'supported', note: 'Imported as native PBR material variants.' }),
  collectMaterialVariantNames(gltf: GltfAsset, rootExtensionData: unknown) {
    void gltf;
    const definitions = (rootExtensionData as NonNullable<GltfAsset['extensions']>['KHR_materials_variants'])?.variants ?? [];
    return Object.freeze(definitions.map(variant => variant.name));
  },
  collectMaterialVariants(context: GltfPrimitiveExtensionContext) {
    const definitions = (context.rootExtensionData as NonNullable<GltfAsset['extensions']>['KHR_materials_variants'])?.variants ?? [];
    const mappings = (context.primitiveExtensionData as NonNullable<GltfPrimitive['extensions']>['KHR_materials_variants'])?.mappings ?? [];
    const result: GltfMaterialVariantReference[] = [];
    for (const mapping of mappings) {
      for (const variantIndex of mapping.variants) {
        const name = definitions[variantIndex]?.name;
        if (name) result.push(Object.freeze({ name, materialIndex: mapping.material }));
      }
    }
    return Object.freeze(result);
  },
});

function capabilityAdapter(
  extension: string,
  support: GltfExtensionSupport,
  note: string,
): GltfExtensionAdapter {
  return Object.freeze({ extension, capability: Object.freeze({ support, note }) });
}

export const DEFAULT_GLTF_EXTENSION_ADAPTERS: readonly GltfExtensionAdapter[] = Object.freeze([
  capabilityAdapter('KHR_draco_mesh_compression', 'supported', 'Decoded through the configured Draco decoder.'),
  variantsAdapter,
  clearcoatAdapter,
  iorAdapter,
  specularAdapter,
  sheenAdapter,
  transmissionAdapter,
  volumeAdapter,
  capabilityAdapter('KHR_materials_anisotropy', 'partial', 'The base PBR material is imported, but anisotropy shading is not rendered.'),
  capabilityAdapter('KHR_texture_basisu', 'supported', 'Imported through the KTX2/Basis texture path.'),
  capabilityAdapter('KHR_texture_transform', 'supported', 'Applied per PBR texture slot in the shader.'),
]);

/** Resolves an immutable per-load adapter set; user adapters replace defaults by extension id. */
export function resolveGltfExtensionAdapters(
  customAdapters: readonly GltfExtensionAdapter[] = [],
): readonly GltfExtensionAdapter[] {
  const adapters = new Map(DEFAULT_GLTF_EXTENSION_ADAPTERS.map(adapter => [adapter.extension, adapter]));
  for (const adapter of customAdapters) {
    const extension = adapter.extension.trim();
    if (!extension) throw new TypeError('GltfExtensionAdapter.extension must not be empty.');
    adapters.set(extension, Object.freeze({
      ...adapter,
      extension,
      capability: Object.freeze({ ...adapter.capability }),
    }));
  }
  return Object.freeze([...adapters.values()]);
}

export function createGltfExtensionCapabilities(
  adapters: readonly GltfExtensionAdapter[],
): Readonly<Record<string, GltfExtensionCapability>> {
  return Object.freeze(Object.fromEntries(adapters.map(adapter => [adapter.extension, adapter.capability])));
}

export function collectGltfMaterialExtensionPatches(
  gltf: GltfAsset,
  material: GltfMaterial | null,
  primitive: GltfPrimitive,
  materialPath: string,
  adapters: readonly GltfExtensionAdapter[],
): readonly GltfMaterialExtensionPatch[] {
  if (!material) return Object.freeze([]);
  const patches: GltfMaterialExtensionPatch[] = [];
  for (const adapter of adapters) {
    if (!adapter.extendMaterial) continue;
    const extensionData = material.extensions?.[adapter.extension];
    if (extensionData === undefined) continue;
    const patch = adapter.extendMaterial({ gltf, material, primitive, materialPath, extensionData });
    if (patch) patches.push(patch);
  }
  return Object.freeze(patches);
}

export function collectGltfMaterialVariantReferences(
  gltf: GltfAsset,
  primitive: GltfPrimitive,
  adapters: readonly GltfExtensionAdapter[],
): readonly GltfMaterialVariantReference[] {
  const result: GltfMaterialVariantReference[] = [];
  for (const adapter of adapters) {
    if (!adapter.collectMaterialVariants) continue;
    const rootExtensionData = gltf.extensions?.[adapter.extension];
    const primitiveExtensionData = primitive.extensions?.[adapter.extension];
    if (rootExtensionData === undefined && primitiveExtensionData === undefined) continue;
    result.push(...adapter.collectMaterialVariants({ gltf, primitive, rootExtensionData, primitiveExtensionData }));
  }
  return Object.freeze(result);
}

export function collectGltfMaterialVariantNames(
  gltf: GltfAsset,
  adapters: readonly GltfExtensionAdapter[],
): readonly string[] {
  const names = new Set<string>();
  for (const adapter of adapters) {
    if (!adapter.collectMaterialVariantNames) continue;
    const rootExtensionData = gltf.extensions?.[adapter.extension];
    if (rootExtensionData === undefined) continue;
    for (const name of adapter.collectMaterialVariantNames(gltf, rootExtensionData)) {
      if (name) names.add(name);
    }
  }
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      for (const variant of collectGltfMaterialVariantReferences(gltf, primitive, adapters)) names.add(variant.name);
    }
  }
  return Object.freeze([...names]);
}
