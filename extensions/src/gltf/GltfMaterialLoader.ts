import type { PbrMaterial } from '@haiyue/engine';
import {
  createMaterialFromDescriptor,
  getPbrTextureFormat,
  type MaterialDescriptorVariant,
  type MaterialTextureSource,
  type PbrTextureMappingOptions,
  type PbrTextureSlot,
} from '@haiyue/engine/material';
import type { AssetHandle, CompressedTextureSourceDescriptor } from '@haiyue/engine/assets';
import {
  collectGltfMaterialVariantReferences,
} from './GltfExtensionAdapter';
import {
  collectGltfMaterialTextureBindings,
  createGltfMaterialDescriptor,
} from './GltfMaterialDescriptor';
import { getGltfUvChannel, type GltfUvSemanticPlan } from './GltfUvSemanticPlanner';
import { gltfDataError, throwIfGltfLoadAborted } from './GltfLoaderErrors';
import type { GltfLoadContext, LoadGltfOptions } from './GltfLoaderContract';
import type {
  GltfAsset,
  GltfImage,
  GltfMaterial,
  GltfPrimitive,
  GltfTextureInfo,
} from './GltfSchema';

export async function createGltfMaterial(gltf: GltfAsset, buffers: ArrayBuffer[], primitive: GltfPrimitive, options: LoadGltfOptions, context: GltfLoadContext, uvPlan: GltfUvSemanticPlan): Promise<PbrMaterial> {
  throwIfGltfLoadAborted(options.signal);
  const materialIndex = primitive.material;
  const gltfMaterial = materialIndex === undefined ? null : gltf.materials?.[materialIndex] ?? null;
  const createDescriptor = (material: GltfMaterial | null, materialPath: string) => createGltfMaterialDescriptor({
    gltf,
    material,
    primitive,
    materialPath,
    ...(options.baseColorFactor === undefined ? {} : { defaultBaseColor: options.baseColorFactor }),
    adapters: context.extensionAdapters,
    resolveTexture: binding => ({
      source: createTextureSource(gltf, buffers, binding.textureInfo.index, binding.slot, context),
      mapping: resolveGltfTextureMapping(binding.textureInfo, primitive, binding.path, uvPlan),
      sampler: createSamplerDescriptor(gltf, binding.textureInfo.index),
    }),
  });
  const descriptor = createDescriptor(
    gltfMaterial,
    materialIndex === undefined ? 'gltf.defaultMaterial' : `gltf.materials[${materialIndex}]`,
  );
  const variants: MaterialDescriptorVariant[] = collectGltfMaterialVariantReferences(
    gltf,
    primitive,
    context.extensionAdapters,
  ).map(variant => ({
    name: variant.name,
    state: createDescriptor(
      gltf.materials?.[variant.materialIndex] ?? null,
      `gltf.materials[${variant.materialIndex}]`,
    ).state,
  }));
  return createMaterialFromDescriptor({ ...descriptor, variants });
}

function resolveGltfTextureMapping(
  textureInfo: GltfTextureInfo,
  primitive: GltfPrimitive,
  path: string,
  uvPlan: GltfUvSemanticPlan,
): PbrTextureMappingOptions {
  const transform = textureInfo.extensions?.KHR_texture_transform;
  const textureCoord = transform?.texCoord ?? textureInfo.texCoord ?? 0;
  const texCoordPath = transform?.texCoord === undefined
    ? `${path}.texCoord`
    : `${path}.extensions.KHR_texture_transform.texCoord`;
  const semantic = `TEXCOORD_${textureCoord}`;
  if (primitive.attributes[semantic] === undefined) {
    throw gltfDataError(
      `Texture references ${semantic}, but the mesh primitive does not provide that attribute.`,
      { texCoord: textureCoord, semantic },
      texCoordPath,
    );
  }
  const channel = getGltfUvChannel(uvPlan, textureCoord);
  if (channel === null) {
    throw gltfDataError(
      `${semantic} was not assigned to a physical PBR UV channel.`,
      { texCoord: textureCoord, semantic, capacity: uvPlan.capacity },
      texCoordPath,
    );
  }
  return {
    texCoord: channel,
    offset: transform?.offset ?? [0, 0],
    rotation: transform?.rotation ?? 0,
    scale: transform?.scale ?? [1, 1],
  };
}

function createSamplerDescriptor(gltf: GltfAsset, textureIndex: number): GPUSamplerDescriptor | null {
  const texture = gltf.textures?.[textureIndex];
  const sampler = texture?.sampler === undefined ? null : gltf.samplers?.[texture.sampler] ?? null;
  return {
    addressModeU: mapWrapMode(sampler?.wrapS),
    addressModeV: mapWrapMode(sampler?.wrapT),
    magFilter: mapMagFilter(sampler?.magFilter),
    minFilter: mapMinFilter(sampler?.minFilter),
    mipmapFilter: mapMipmapFilter(sampler?.minFilter),
  };
}

function mapWrapMode(mode: number | undefined): GPUAddressMode {
  switch (mode) {
    case 33071: return 'clamp-to-edge';
    case 33648: return 'mirror-repeat';
    case 10497:
    case undefined:
      return 'repeat';
    default:
      return 'repeat';
  }
}

function mapMagFilter(filter: number | undefined): GPUFilterMode {
  return filter === 9728 ? 'nearest' : 'linear';
}

function mapMinFilter(filter: number | undefined): GPUFilterMode {
  switch (filter) {
    case 9728:
    case 9984:
    case 9986:
      return 'nearest';
    default:
      return 'linear';
  }
}

function mapMipmapFilter(filter: number | undefined): GPUMipmapFilterMode {
  switch (filter) {
    case 9984:
    case 9985:
      return 'nearest';
    case 9986:
    case 9987:
      return 'linear';
    default:
      return 'linear';
  }
}

interface GltfTextureReference {
  readonly source: string | CompressedTextureSourceDescriptor;
  readonly cacheKey: string;
  readonly requestKey: string;
  readonly format: 'rgba8unorm-srgb' | 'rgba8unorm';
}

export async function preloadGltfTextures(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  options: LoadGltfOptions,
  context: GltfLoadContext,
): Promise<void> {
  const assetManager = options.assetManager;
  if (!assetManager) return;
  const requests = new Map<string, GltfTextureReference>();
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const materialIndexes = new Set<number>();
      if (primitive.material !== undefined) materialIndexes.add(primitive.material);
      for (const variant of collectGltfMaterialVariantReferences(gltf, primitive, context.extensionAdapters)) {
        materialIndexes.add(variant.materialIndex);
      }
      for (const materialIndex of materialIndexes) {
        const material = gltf.materials?.[materialIndex] ?? null;
        for (const binding of collectGltfMaterialTextureBindings(
          gltf,
          material,
          primitive,
          `gltf.materials[${materialIndex}]`,
          context.extensionAdapters,
        )) {
          const reference = resolveTextureReference(gltf, buffers, binding.textureInfo.index, binding.slot, context);
          if (reference) requests.set(reference.requestKey, reference);
        }
      }
    }
  }
  const results = await Promise.allSettled([...requests.values()].map(async reference => ({
    reference,
    handle: await assetManager.loadTexture(reference.source, {
      cacheKey: reference.cacheKey,
      format: reference.format,
      mipmaps: 'generate',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  })));
  const loaded: Array<{ reference: GltfTextureReference; handle: AssetHandle<GPUTexture> }> = [];
  let firstError: unknown = null;
  for (const result of results) {
    if (result.status === 'fulfilled') loaded.push(result.value);
    else if (firstError === null) firstError = result.reason;
  }
  if (firstError !== null) {
    for (const { handle } of loaded) handle.release();
    throw firstError;
  }
  for (const { reference, handle } of loaded) {
    context.preloadedTextures.set(reference.requestKey, handle.value);
    context.assetHandles.push(handle);
  }
}

function createTextureSource(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  textureIndex: number,
  slot: PbrTextureSlot,
  context: GltfLoadContext,
): MaterialTextureSource {
  const reference = resolveTextureReference(gltf, buffers, textureIndex, slot, context);
  if (!reference) return null;
  return context.preloadedTextures.get(reference.requestKey) ?? reference.source;
}

function resolveTextureReference(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  textureIndex: number,
  slot: PbrTextureSlot,
  context: GltfLoadContext,
): GltfTextureReference | null {
  const texture = gltf.textures?.[textureIndex];
  const basisuSource = texture?.extensions?.KHR_texture_basisu?.source;
  const imageIndex = basisuSource ?? texture?.source;
  if (imageIndex === undefined) return null;
  const image = gltf.images?.[imageIndex] ?? null;
  if (!image) return null;
  const compressed = basisuSource !== undefined || image.mimeType === 'image/ktx2';
  const src = createImageUrl(gltf, buffers, imageIndex, image, context);
  if (!src) return null;
  const source: string | CompressedTextureSourceDescriptor = compressed
    ? { kind: 'compressed-texture', type: 'texture/ktx2', src }
    : src;
  const cacheKey = createImageCacheKey(imageIndex, image, context);
  const format = getPbrTextureFormat(slot);
  return {
    source,
    cacheKey,
    requestKey: compressed ? `compressed:${cacheKey}` : `${format}:${cacheKey}`,
    format,
  };
}

function createImageCacheKey(imageIndex: number, image: GltfImage, context: GltfLoadContext): string {
  if (image.uri) {
    const url = image.uri.startsWith('data:') || image.uri.startsWith('blob:')
      ? image.uri
      : new URL(image.uri, context.baseUrl).href;
    return `url:${url}`;
  }
  return `gltf:${context.assetIdentity}:image:${imageIndex}`;
}

function createImageUrl(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  imageIndex: number,
  image: GltfImage,
  context: GltfLoadContext,
): string | null {
  const cached = context.imageSources.get(imageIndex);
  if (typeof cached === 'string') return cached;
  if (image.uri) {
    const url = image.uri.startsWith('data:') || image.uri.startsWith('blob:')
      ? image.uri
      : new URL(image.uri, context.baseUrl).href;
    context.imageSources.set(imageIndex, url);
    return url;
  }
  if (image.bufferView === undefined) return null;
  const view = gltf.bufferViews?.[image.bufferView];
  if (!view) return null;
  const buffer = buffers[view.buffer];
  if (!buffer) throw gltfDataError(`Image bufferView references missing buffer ${view.buffer}.`);
  const bytes = new Uint8Array(buffer, view.byteOffset ?? 0, view.byteLength);
  const blob = new Blob([bytes.slice()], { type: image.mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  if (!context.sharedImageSources) context.objectUrls.push(url);
  context.imageSources.set(imageIndex, url);
  return url;
}

