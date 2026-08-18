import type { Geometry3D } from '@haiyue/engine';
import type { GltfAccessor, GltfAsset, GltfPrimitive } from './GltfSchema';
import type { GltfUvSemanticPlan } from './GltfUvSemanticPlanner';

export type GltfCompatibilityStatus = 'compatible' | 'degraded';
export type GltfTextureMipmapSource = 'generated-full-chain' | 'source-provided' | 'unavailable';
export type GltfPrimitiveBoundsSupport = 'static' | 'accessor-conservative' | 'fail-open';

export interface GltfCompatibilityExtensionEntry {
  readonly extension: string;
  readonly required: boolean;
  readonly support: 'supported' | 'partial' | 'unsupported';
  readonly disposition: 'supported' | 'partial' | 'ignored';
  readonly note: string;
}

export interface GltfTextureCompatibilityEntry {
  readonly textureIndex: number;
  readonly imageIndex: number | null;
  readonly mipmapSource: GltfTextureMipmapSource;
  readonly path: string;
  readonly note: string;
}

export interface GltfPrimitiveBoundsCompatibilityEntry {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly support: GltfPrimitiveBoundsSupport;
  readonly path: string;
  readonly reason: string | null;
}

export interface GltfPrimitiveUvSemanticCompatibilityEntry {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly capacity: number;
  readonly availableSemantics: readonly string[];
  readonly referencedSemantics: readonly string[];
  readonly mappings: readonly Readonly<{ semantic: string; set: number; channel: 0 | 1 }>[];
  readonly path: string;
}

export interface GltfCompatibilityPerformanceSummary {
  /** Fetch, parse, decode, and entity/material instantiation on the loading thread. */
  readonly loadMs: number;
  /** Unique decoded geometry ArrayBuffer storage retained by the loaded model. */
  readonly decodedGeometryBytes: number;
}

export interface GltfCompatibilityIssue {
  readonly category: 'extension' | 'texture-mipmap' | 'bounds' | 'uv-semantic';
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface GltfCompatibilityReport {
  readonly status: GltfCompatibilityStatus;
  readonly extensions: readonly GltfCompatibilityExtensionEntry[];
  readonly textures: readonly GltfTextureCompatibilityEntry[];
  readonly bounds: readonly GltfPrimitiveBoundsCompatibilityEntry[];
  readonly uvSemantics: readonly GltfPrimitiveUvSemanticCompatibilityEntry[];
  readonly performance: GltfCompatibilityPerformanceSummary;
  readonly issues: readonly GltfCompatibilityIssue[];
}

export interface GltfPrimitiveCompatibilityInput {
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly primitive: GltfPrimitive;
  readonly geometry: Geometry3D;
  readonly skinRequested: boolean;
  readonly uvSemanticPlan: GltfUvSemanticPlan;
}

export function createGltfCompatibilityReport(
  gltf: GltfAsset,
  extensions: readonly GltfCompatibilityExtensionEntry[],
  primitives: readonly GltfPrimitiveCompatibilityInput[],
  performance: GltfCompatibilityPerformanceSummary,
): GltfCompatibilityReport {
  const extensionEntries = extensions.map(entry => Object.freeze({ ...entry }));
  const textures = createTextureEntries(gltf);
  const bounds = primitives.map(input => createBoundsEntry(gltf, input));
  const uvSemantics = primitives.map(input => Object.freeze({
    meshIndex: input.meshIndex,
    primitiveIndex: input.primitiveIndex,
    capacity: input.uvSemanticPlan.capacity,
    availableSemantics: Object.freeze([...input.uvSemanticPlan.availableSemantics]),
    referencedSemantics: Object.freeze([...input.uvSemanticPlan.referencedSemantics]),
    mappings: Object.freeze(input.uvSemanticPlan.mappings.map(mapping => Object.freeze({ ...mapping }))),
    path: input.uvSemanticPlan.path,
  }));
  const issues: GltfCompatibilityIssue[] = [];

  for (const entry of extensionEntries) {
    if (entry.support === 'supported') continue;
    issues.push(Object.freeze({
      category: 'extension',
      path: `gltf.extensionsUsed[${Math.max(0, (gltf.extensionsUsed ?? []).indexOf(entry.extension))}]`,
      code: entry.support === 'partial' ? 'GLTF_EXTENSION_PARTIAL' : 'GLTF_EXTENSION_UNSUPPORTED',
      message: entry.note,
    }));
  }
  for (const entry of textures) {
    if (entry.mipmapSource !== 'unavailable') continue;
    issues.push(Object.freeze({
      category: 'texture-mipmap',
      path: entry.path,
      code: 'GLTF_TEXTURE_MIPMAP_UNAVAILABLE',
      message: entry.note,
    }));
  }
  for (const entry of bounds) {
    if (entry.support !== 'fail-open') continue;
    issues.push(Object.freeze({
      category: 'bounds',
      path: entry.path,
      code: 'GLTF_BOUNDS_FAIL_OPEN',
      message: entry.reason ?? 'Dynamic bounds cannot be proven; frustum culling remains disabled.',
    }));
  }

  return Object.freeze({
    status: issues.length === 0 ? 'compatible' : 'degraded',
    extensions: Object.freeze(extensionEntries),
    textures: Object.freeze(textures),
    bounds: Object.freeze(bounds),
    uvSemantics: Object.freeze(uvSemantics),
    performance: Object.freeze({ ...performance }),
    issues: Object.freeze(issues),
  });
}

function createTextureEntries(gltf: GltfAsset): GltfTextureCompatibilityEntry[] {
  return (gltf.textures ?? []).map((texture, textureIndex) => {
    const basisuSource = texture.extensions?.KHR_texture_basisu?.source;
    const imageIndex = basisuSource ?? texture.source;
    const image = imageIndex === undefined ? undefined : gltf.images?.[imageIndex];
    const path = `gltf.textures[${textureIndex}]`;
    if (imageIndex === undefined || !image) {
      return Object.freeze({
        textureIndex,
        imageIndex: imageIndex ?? null,
        mipmapSource: 'unavailable' as const,
        path,
        note: 'Texture has no resolvable image source, so a mipmap contract cannot be established.',
      });
    }
    const compressed = basisuSource !== undefined || image.mimeType === 'image/ktx2';
    return Object.freeze({
      textureIndex,
      imageIndex,
      mipmapSource: compressed ? 'source-provided' as const : 'generated-full-chain' as const,
      path,
      note: compressed
        ? 'KTX2/Basis texture uses the source-provided mip chain.'
        : 'Ordinary image receives a generated full mip chain when loaded by PBR.',
    });
  });
}

function createBoundsEntry(
  gltf: GltfAsset,
  input: GltfPrimitiveCompatibilityInput,
): GltfPrimitiveBoundsCompatibilityEntry {
  const path = `gltf.meshes[${input.meshIndex}].primitives[${input.primitiveIndex}]`;
  const dynamic = input.skinRequested || (input.primitive.targets?.length ?? 0) > 0;
  if (!dynamic) {
    return Object.freeze({ meshIndex: input.meshIndex, primitiveIndex: input.primitiveIndex, support: 'static', path, reason: null });
  }
  const reason = getBoundsEvidenceFailure(gltf, input);
  if (reason) {
    return Object.freeze({ meshIndex: input.meshIndex, primitiveIndex: input.primitiveIndex, support: 'fail-open', path, reason });
  }
  return Object.freeze({
    meshIndex: input.meshIndex,
    primitiveIndex: input.primitiveIndex,
    support: 'accessor-conservative',
    path,
    reason: null,
  });
}

function getBoundsEvidenceFailure(gltf: GltfAsset, input: GltfPrimitiveCompatibilityInput): string | null {
  const positionIndex = input.primitive.attributes.POSITION;
  if (positionIndex === undefined || !hasVec3Bounds(gltf.accessors?.[positionIndex])) {
    return 'Base POSITION accessor is missing a valid finite min/max pair.';
  }
  for (const [targetIndex, target] of (input.primitive.targets ?? []).entries()) {
    if (target.POSITION === undefined) continue;
    if (!hasVec3Bounds(gltf.accessors?.[target.POSITION])) {
      return `Morph target ${targetIndex} POSITION accessor is missing a valid finite min/max pair.`;
    }
  }
  if (input.skinRequested && !input.geometry.skinning) {
    return 'Skin was requested but a runtime skin contract could not be created for this primitive.';
  }
  if (!input.geometry.localBounds) {
    return 'Dynamic local bounds are unavailable for the current morph/skin state.';
  }
  return null;
}

function hasVec3Bounds(accessor: GltfAccessor | undefined): boolean {
  if (!accessor || accessor.type !== 'VEC3' || accessor.min?.length !== 3 || accessor.max?.length !== 3) return false;
  const min = accessor.min;
  const max = accessor.max;
  return [...min, ...max].every(Number.isFinite)
    && min.every((value, axis) => {
      const maximum = max[axis];
      return maximum !== undefined && value <= maximum;
    });
}
