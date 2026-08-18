import type { EnvironmentCubeTexture } from '../lighting/EnvironmentLight';
import type {
  MaterialTextureSource,
  SampleableTextureSource,
} from '../material/BasicMaterial';
import type {
  PbrMaterial,
  PbrTextureMapping,
  PbrTextureSlot,
} from '../material/PbrMaterial';

/** Resolves one logical PBR slot without coupling binding code to material storage. */
export function getPbrTextureSource(
  material: PbrMaterial,
  slot: PbrTextureSlot,
): MaterialTextureSource {
  switch (slot) {
    case 'baseColor': return material.baseColorTexture;
    case 'metallicRoughness': return material.metallicRoughnessTexture;
    case 'normal': return material.normalTexture;
    case 'occlusion': return material.occlusionTexture;
    case 'emissive': return material.emissiveTexture;
    case 'clearcoat': return material.clearcoatTexture;
    case 'clearcoatRoughness': return material.clearcoatRoughnessTexture;
    case 'clearcoatNormal': return material.clearcoatNormalTexture;
    case 'specular': return material.specularTexture;
    case 'specularColor': return material.specularColorTexture;
    case 'sheenColor': return material.sheenColorTexture;
    case 'sheenRoughness': return material.sheenRoughnessTexture;
    case 'transmission': return material.transmissionTexture;
    case 'thickness': return material.thicknessTexture;
  }
}

/** Writes the two affine UV rows consumed by the PBR shader. */
export function writePbrTextureMapping(
  target: Float32Array,
  offset: number,
  mapping: PbrTextureMapping,
): void {
  const cos = Math.cos(mapping.rotation);
  const sin = Math.sin(mapping.rotation);
  target[offset] = mapping.scale[0] * cos;
  target[offset + 1] = -mapping.scale[1] * sin;
  target[offset + 2] = mapping.offset[0];
  target[offset + 3] = mapping.texCoord;
  target[offset + 4] = mapping.scale[0] * sin;
  target[offset + 5] = mapping.scale[1] * cos;
  target[offset + 6] = mapping.offset[1];
  target[offset + 7] = 0;
}

export function unwrapPbrTexture(source: MaterialTextureSource): GPUTexture | null {
  if (!source || typeof source !== 'object') return null;
  if ('texture' in source && isGpuTextureLike((source as SampleableTextureSource).texture)) {
    return (source as SampleableTextureSource).texture;
  }
  return isGpuTextureLike(source) ? source : null;
}

export function unwrapEnvironmentCubeTexture(
  source: EnvironmentCubeTexture | GPUTexture | null,
): GPUTexture | null {
  if (!source) return null;
  if ('texture' in source && isGpuTextureLike(source.texture)) return source.texture;
  return isGpuTextureLike(source) ? source : null;
}

export function getEnvironmentCubeMipCount(
  source: EnvironmentCubeTexture | GPUTexture | null,
): number {
  if (source && 'texture' in source && typeof source.mipLevelCount === 'number') {
    return source.mipLevelCount;
  }
  return 1;
}

export function getEnvironmentCubeVersion(
  source: EnvironmentCubeTexture | GPUTexture | null,
): number {
  return source && 'texture' in source && typeof source.version === 'number' ? source.version : 0;
}

function isGpuTextureLike(value: unknown): value is GPUTexture {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { createView?: unknown }).createView === 'function';
}
