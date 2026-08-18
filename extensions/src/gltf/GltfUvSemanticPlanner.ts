import { PBR_COMPATIBILITY_CONTRACT } from '@haiyue/engine/material';
import type { GltfAsset, GltfMaterial, GltfPrimitive } from './GltfSchema';
import {
  DEFAULT_GLTF_EXTENSION_ADAPTERS,
  collectGltfMaterialVariantReferences,
  type GltfExtensionAdapter,
} from './GltfExtensionAdapter';
import { collectGltfMaterialTextureBindings } from './GltfMaterialDescriptor';

export const GLTF_UV_CHANNEL_CAPACITY = PBR_COMPATIBILITY_CONTRACT.uvChannelCapacity;

export interface GltfUvSemanticMapping {
  readonly semantic: string;
  readonly set: number;
  readonly channel: 0 | 1;
}

export interface GltfUvSemanticPlan {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly path: string;
  readonly capacity: typeof GLTF_UV_CHANNEL_CAPACITY;
  readonly availableSemantics: readonly string[];
  readonly referencedSemantics: readonly string[];
  readonly mappings: readonly GltfUvSemanticMapping[];
}

export interface GltfUvSemanticPlanFailure {
  readonly code: 'GLTF_UV_SEMANTIC_MISSING' | 'GLTF_UV_CHANNEL_CAPACITY_EXCEEDED';
  readonly message: string;
  readonly path: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export type GltfUvSemanticPlanResult =
  | { readonly ok: true; readonly plan: GltfUvSemanticPlan }
  | { readonly ok: false; readonly failure: GltfUvSemanticPlanFailure };

interface TextureCoordinateReference {
  readonly set: number;
  readonly semantic: string;
  readonly path: string;
}

export function planGltfUvSemantics(
  gltf: GltfAsset,
  primitive: GltfPrimitive,
  meshIndex: number,
  primitiveIndex: number,
  adapters: readonly GltfExtensionAdapter[] = DEFAULT_GLTF_EXTENSION_ADAPTERS,
): GltfUvSemanticPlanResult {
  const primitivePath = `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`;
  const availableSets = Object.keys(primitive.attributes)
    .map(parseTextureCoordinateSemantic)
    .filter((set): set is number => set !== null)
    .sort((a, b) => a - b);
  const availableSetLookup = new Set(availableSets);
  const references = collectTextureCoordinateReferences(gltf, primitive, adapters);

  for (const reference of references) {
    if (availableSetLookup.has(reference.set)) continue;
    return {
      ok: false,
      failure: Object.freeze({
        code: 'GLTF_UV_SEMANTIC_MISSING',
        message: `Texture references ${reference.semantic}, but the mesh primitive does not provide that attribute.`,
        path: reference.path,
        context: Object.freeze({ texCoord: reference.set, semantic: reference.semantic, meshIndex, primitiveIndex }),
      }),
    };
  }

  const referencedSets = [...new Set(references.map(reference => reference.set))].sort((a, b) => a - b);
  if (referencedSets.length > GLTF_UV_CHANNEL_CAPACITY) {
    const referencedSemantics = referencedSets.map(toTextureCoordinateSemantic);
    return {
      ok: false,
      failure: Object.freeze({
        code: 'GLTF_UV_CHANNEL_CAPACITY_EXCEEDED',
        message: `Primitive references ${referencedSets.length} texture-coordinate sets (${referencedSemantics.join(', ')}), exceeding the ${GLTF_UV_CHANNEL_CAPACITY}-channel PBR contract.`,
        path: `${primitivePath}.attributes`,
        context: Object.freeze({
          meshIndex,
          primitiveIndex,
          capacity: GLTF_UV_CHANNEL_CAPACITY,
          referencedSemantics: Object.freeze(referencedSemantics),
        }),
      }),
    };
  }

  const mappings = referencedSets.map((set, channel) => Object.freeze({
    semantic: toTextureCoordinateSemantic(set),
    set,
    channel: channel as 0 | 1,
  }));
  return {
    ok: true,
    plan: Object.freeze({
      meshIndex,
      primitiveIndex,
      path: primitivePath,
      capacity: GLTF_UV_CHANNEL_CAPACITY,
      availableSemantics: Object.freeze(availableSets.map(toTextureCoordinateSemantic)),
      referencedSemantics: Object.freeze(referencedSets.map(toTextureCoordinateSemantic)),
      mappings: Object.freeze(mappings),
    }),
  };
}

export function getGltfUvChannel(plan: GltfUvSemanticPlan, semanticSet: number): 0 | 1 | null {
  return plan.mappings.find(mapping => mapping.set === semanticSet)?.channel ?? null;
}

export function parseTextureCoordinateSemantic(semantic: string): number | null {
  const match = /^TEXCOORD_(0|[1-9]\d*)$/.exec(semantic);
  if (!match) return null;
  const set = Number(match[1]);
  return Number.isSafeInteger(set) ? set : null;
}

function toTextureCoordinateSemantic(set: number): string {
  return `TEXCOORD_${set}`;
}

function collectTextureCoordinateReferences(
  gltf: GltfAsset,
  primitive: GltfPrimitive,
  adapters: readonly GltfExtensionAdapter[],
): TextureCoordinateReference[] {
  const materials = new Map<number | null, { material: GltfMaterial | null; path: string }>();
  const baseIndex = primitive.material;
  materials.set(baseIndex ?? null, {
    material: baseIndex === undefined ? null : gltf.materials?.[baseIndex] ?? null,
    path: baseIndex === undefined ? 'gltf.defaultMaterial' : `gltf.materials[${baseIndex}]`,
  });
  for (const variant of collectGltfMaterialVariantReferences(gltf, primitive, adapters)) {
    if (materials.has(variant.materialIndex)) continue;
    materials.set(variant.materialIndex, {
      material: gltf.materials?.[variant.materialIndex] ?? null,
      path: `gltf.materials[${variant.materialIndex}]`,
    });
  }

  const references: TextureCoordinateReference[] = [];
  for (const { material, path } of materials.values()) {
    for (const { textureInfo, path: texturePath } of collectGltfMaterialTextureBindings(
      gltf,
      material,
      primitive,
      path,
      adapters,
    )) {
      const transform = textureInfo.extensions?.KHR_texture_transform;
      const set = transform?.texCoord ?? textureInfo.texCoord ?? 0;
      references.push(Object.freeze({
        set,
        semantic: toTextureCoordinateSemantic(set),
        path: transform?.texCoord === undefined
          ? `${texturePath}.texCoord`
          : `${texturePath}.extensions.KHR_texture_transform.texCoord`,
      }));
    }
  }
  return references;
}
