export type GltfComponentType = 5120 | 5121 | 5122 | 5123 | 5125 | 5126;
export type GltfAccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4';
export type GltfAnimationInterpolation = 'LINEAR' | 'STEP' | 'CUBICSPLINE';

export interface GltfBuffer { uri?: string; byteLength?: number }
export interface GltfBufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }
export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: GltfComponentType;
  count: number;
  type: GltfAccessorType;
  normalized?: boolean;
  min?: number[];
  max?: number[];
  sparse?: GltfAccessorSparse;
}
export interface GltfAccessorSparse {
  count: number;
  indices: {
    bufferView: number;
    byteOffset?: number;
    componentType: 5121 | 5123 | 5125;
  };
  values: {
    bufferView: number;
    byteOffset?: number;
  };
}

export interface GltfDracoMeshCompression {
  bufferView: number;
  attributes: Record<string, number>;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Array<Record<string, number>>;
  extensions?: {
    [extension: string]: unknown;
    KHR_draco_mesh_compression?: GltfDracoMeshCompression;
    KHR_materials_variants?: {
      mappings: Array<{ material: number; variants: number[] }>;
    };
  };
}
export interface GltfMesh { name?: string; primitives: GltfPrimitive[]; weights?: number[] }
export interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}
export interface GltfScene { nodes?: number[] }
export interface GltfSkin {
  inverseBindMatrices?: number;
  joints: number[];
  skeleton?: number;
  name?: string;
}
export interface GltfMaterial {
  name?: string;
  doubleSided?: boolean;
  pbrMetallicRoughness?: {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: GltfTextureInfo;
    metallicRoughnessTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
  };
  emissiveFactor?: [number, number, number];
  emissiveTexture?: GltfTextureInfo;
  normalTexture?: GltfTextureInfo & { scale?: number };
  occlusionTexture?: GltfTextureInfo & { strength?: number };
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  extensions?: {
    [extension: string]: unknown;
    KHR_materials_clearcoat?: {
      clearcoatFactor?: number;
      clearcoatTexture?: GltfTextureInfo;
      clearcoatRoughnessFactor?: number;
      clearcoatRoughnessTexture?: GltfTextureInfo;
      clearcoatNormalTexture?: GltfTextureInfo & { scale?: number };
    };
    KHR_materials_anisotropy?: {
      anisotropyStrength?: number;
      anisotropyRotation?: number;
      anisotropyTexture?: GltfTextureInfo;
    };
    KHR_materials_ior?: {
      ior?: number;
    };
    KHR_materials_specular?: {
      specularFactor?: number;
      specularTexture?: GltfTextureInfo;
      specularColorFactor?: [number, number, number];
      specularColorTexture?: GltfTextureInfo;
    };
    KHR_materials_sheen?: {
      sheenColorFactor?: [number, number, number];
      sheenColorTexture?: GltfTextureInfo;
      sheenRoughnessFactor?: number;
      sheenRoughnessTexture?: GltfTextureInfo;
    };
    KHR_materials_transmission?: {
      transmissionFactor?: number;
      transmissionTexture?: GltfTextureInfo;
    };
    KHR_materials_volume?: {
      thicknessFactor?: number;
      thicknessTexture?: GltfTextureInfo;
      attenuationDistance?: number;
      attenuationColor?: [number, number, number];
    };
  };
}
export interface GltfTextureInfo {
  index: number;
  texCoord?: number;
  extensions?: { [extension: string]: unknown; KHR_texture_transform?: GltfTextureTransform };
}
export interface GltfTextureTransform {
  offset?: [number, number];
  rotation?: number;
  scale?: [number, number];
  texCoord?: number;
}
export interface GltfImage { uri?: string; bufferView?: number; mimeType?: string }
export interface GltfTexture {
  sampler?: number;
  source?: number;
  extensions?: { [extension: string]: unknown; KHR_texture_basisu?: { source: number } };
}
export interface GltfSampler {
  magFilter?: number;
  minFilter?: number;
  wrapS?: number;
  wrapT?: number;
}
export interface GltfAnimation {
  name?: string;
  channels?: Array<{
    sampler: number;
    target: { node?: number; path?: string };
  }>;
  samplers?: Array<{ input: number; output: number; interpolation?: GltfAnimationInterpolation }>;
}

export interface GltfAsset {
  asset: { version: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  buffers?: GltfBuffer[];
  bufferViews?: GltfBufferView[];
  accessors?: GltfAccessor[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: GltfScene[];
  scene?: number;
  skins?: GltfSkin[];
  materials?: GltfMaterial[];
  images?: GltfImage[];
  textures?: GltfTexture[];
  samplers?: GltfSampler[];
  animations?: GltfAnimation[];
  extensions?: {
    [extension: string]: unknown;
    KHR_materials_variants?: { variants: Array<{ name: string }> };
  };
}

/** Validates the untrusted JSON envelope before the loader follows references. */
export function isGltfAsset(value: unknown): value is GltfAsset {
  if (!isRecord(value)) return false;
  if (!isRecord(value.asset) || typeof value.asset.version !== 'string' || !value.asset.version.startsWith('2')) return false;
  const arrayFields = [
    'buffers', 'bufferViews', 'accessors', 'meshes', 'nodes', 'scenes', 'skins',
    'materials', 'images', 'textures', 'samplers', 'animations',
  ] as const;
  if (arrayFields.some(field => value[field] !== undefined && !Array.isArray(value[field]))) return false;
  if (value.scene !== undefined && !isNonNegativeInteger(value.scene)) return false;
  if (value.extensionsUsed !== undefined && (!Array.isArray(value.extensionsUsed) || !value.extensionsUsed.every(item => typeof item === 'string'))) return false;
  if (value.extensionsRequired !== undefined && (!Array.isArray(value.extensionsRequired) || !value.extensionsRequired.every(item => typeof item === 'string'))) return false;
  if (!((value.buffers as unknown[] | undefined) ?? []).every(buffer => isRecord(buffer)
    && (buffer.uri === undefined || typeof buffer.uri === 'string')
    && (buffer.byteLength === undefined || isNonNegativeInteger(buffer.byteLength)))) return false;
  if (!((value.bufferViews as unknown[] | undefined) ?? []).every(view => isRecord(view)
    && isNonNegativeInteger(view.buffer)
    && isNonNegativeInteger(view.byteLength)
    && (view.byteOffset === undefined || isNonNegativeInteger(view.byteOffset)))) return false;
  if (!((value.accessors as unknown[] | undefined) ?? []).every(accessor => isRecord(accessor)
    && isNonNegativeInteger(accessor.count)
    && typeof accessor.type === 'string'
    && isNonNegativeInteger(accessor.componentType)
    && isOptionalFiniteNumberArray(accessor.min)
    && isOptionalFiniteNumberArray(accessor.max)
    && (accessor.bufferView === undefined || isNonNegativeInteger(accessor.bufferView)))) return false;
  if (!((value.meshes as unknown[] | undefined) ?? []).every(mesh => isRecord(mesh)
    && Array.isArray(mesh.primitives)
    && mesh.primitives.every(primitive => isRecord(primitive) && isNumericRecord(primitive.attributes)))) return false;
  if (!((value.nodes as unknown[] | undefined) ?? []).every(isRecord)) return false;
  if (!((value.scenes as unknown[] | undefined) ?? []).every(scene => isRecord(scene)
    && (scene.nodes === undefined || (Array.isArray(scene.nodes) && scene.nodes.every(isNonNegativeInteger))))) return false;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNumericRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isNonNegativeInteger);
}

function isOptionalFiniteNumberArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item)));
}
