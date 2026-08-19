import { Mesh3D } from '@haiyue/engine/components';
import type { Entity, World } from '@haiyue/engine/ecs';
import type { Geometry3D } from '@haiyue/engine/geometry';
import { PbrMaterial, type PbrTextureSlot } from '@haiyue/engine/material';
import type { Scene } from '@haiyue/engine/scene';
import type { RayPackedAcceleration } from '../acceleration/index.js';
import { materialDiagnostic } from './diagnostics.js';
import type {
  RayMaterialDiagnostic,
  RayMaterialPackOptions,
  RayMaterialPackResult,
  RayPackedMaterialScene,
  RayPackedTextureAtlas,
  RayTexturePixels,
} from './types.js';

const MISSING = 0xffff_ffff;
const MATERIAL_STRIDE = 128 as const;
const SURFACE_STRIDE = 128 as const;
const TEXTURE_SLOTS = Object.freeze(['baseColor', 'metallicRoughness', 'normal', 'occlusion', 'emissive'] as const);
type SupportedTextureSlot = typeof TEXTURE_SLOTS[number];

interface TextureRecord {
  readonly key: string;
  readonly pixels: RayTexturePixels;
}

interface MaterialRecord {
  readonly identity: string;
  readonly material: PbrMaterial;
  readonly textureLayers: Readonly<Record<SupportedTextureSlot, number>>;
}

export function packRayPbrMaterialScene(
  source: Scene | World,
  acceleration: RayPackedAcceleration,
  options: RayMaterialPackOptions = {},
): RayMaterialPackResult {
  const diagnostics: RayMaterialDiagnostic[] = [];
  const world = resolveWorld(source);
  if (world.destroyed) {
    diagnostics.push(materialDiagnostic('extract', 'error', 'RAY_MATERIAL_SOURCE_DESTROYED',
      'The source world is destroyed and cannot provide material facts.', { worldId: world.id }));
    return freezeResult(null, diagnostics);
  }
  const materialSources = new Map<string, PbrMaterial>();
  const materialSourcesById = new Map<string, PbrMaterial>();
  const geometrySources = new Map<string, Geometry3D>();
  for (const entity of [...world.entities.values()].sort((a, b) => a.id - b.id)) {
    if (entity.destroyed || isHierarchyDisabled(entity)) continue;
    const mesh = entity.getComponent(Mesh3D);
    if (!mesh || mesh.disabled || mesh.destroyed) continue;
    const identity = `material:${mesh.material.id}@${mesh.material.revision}:${mesh.material.type}`;
    if (mesh.material instanceof PbrMaterial) {
      materialSources.set(identity, mesh.material);
      materialSourcesById.set(`material:${mesh.material.id}`, mesh.material);
    }
    geometrySources.set(`geometry:${mesh.geometry.id}@${mesh.geometry.version}`, mesh.geometry);
  }

  const textureRecords: TextureRecord[] = [];
  const textureIndices = new Map<string, number>();
  const unsupported = new Set<string>();
  const records: MaterialRecord[] = [];
  for (const identity of acceleration.materialIdentities) {
    const material = materialSources.get(identity);
    if (!material) {
      const identityId = identity.slice(0, identity.indexOf('@'));
      const current = materialSourcesById.get(identityId);
      if (current) {
        diagnostics.push(materialDiagnostic('extract', 'error', 'RAY_MATERIAL_ACCELERATION_STALE',
          `Material ${identityId} changed after the acceleration material indirection was frozen.`,
          { materialIdentity: identity, currentRevision: current.revision }));
        continue;
      }
      const type = identity.slice(identity.lastIndexOf(':') + 1);
      const feature = `material-type:${type}`;
      unsupported.add(feature);
      diagnostics.push(materialDiagnostic('extract', 'error', 'RAY_MATERIAL_TYPE_UNSUPPORTED',
        `Material ${identity} is not a supported PbrMaterial source.`, { materialIdentity: identity, feature }));
      continue;
    }
    classifyUnsupported(material, identity, unsupported, diagnostics);
    const textureLayers = {} as Record<SupportedTextureSlot, number>;
    for (const slot of TEXTURE_SLOTS) {
      const sourceTexture = textureSource(material, slot);
      if (!sourceTexture) { textureLayers[slot] = MISSING; continue; }
      const mapping = material.getTextureMapping(slot);
      if (mapping.offset[0] !== 0 || mapping.offset[1] !== 0 || mapping.rotation !== 0
        || mapping.scale[0] !== 1 || mapping.scale[1] !== 1) {
        const feature = `texture-transform:${slot}`;
        unsupported.add(feature);
        diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_MATERIAL_FEATURE_UNSUPPORTED',
          `Texture transform for ${slot} is not supported by the first path-tracing material ABI.`,
          { materialIdentity: identity, feature }));
      }
      if (material.getTextureSampler(slot)) {
        const feature = `texture-sampler:${slot}`;
        unsupported.add(feature);
        diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_MATERIAL_FEATURE_UNSUPPORTED',
          `A custom sampler for ${slot} cannot be represented by the shared ray texture atlas.`,
          { materialIdentity: identity, feature }));
      }
      let pixels: RayTexturePixels | null = null;
      try { pixels = options.textureResolver?.(sourceTexture, slot, identity) ?? null; }
      catch (error) {
        diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_TEXTURE_RESOLVER_FAILED',
          error instanceof Error ? error.message : String(error), { materialIdentity: identity, slot }));
      }
      if (!pixels) {
        const feature = `texture-source:${slot}`;
        unsupported.add(feature);
        diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_TEXTURE_SOURCE_UNSUPPORTED',
          `Texture ${slot} requires a resolver that returns deterministic RGBA8 pixels.`,
          { materialIdentity: identity, feature }));
        textureLayers[slot] = MISSING;
        continue;
      }
      if (!validatePixels(pixels, identity, slot, diagnostics)) {
        textureLayers[slot] = MISSING;
        continue;
      }
      const key = `${pixels.identity}@${pixels.revision}`;
      let layer = textureIndices.get(key);
      if (layer === undefined) {
        layer = textureRecords.length;
        textureIndices.set(key, layer);
        textureRecords.push({ key, pixels });
      }
      textureLayers[slot] = layer;
    }
    records.push({ identity, material, textureLayers: Object.freeze(textureLayers) });
  }

  validateTextureCoordinates(acceleration, geometrySources, records, diagnostics);
  const maxLayers = options.maxTextureLayers ?? 256;
  if (textureRecords.length > maxLayers) diagnostics.push(materialDiagnostic('texture-pack', 'error',
    'RAY_TEXTURE_LAYER_LIMIT_UNSUPPORTED', 'Ray material texture count exceeds the configured atlas layer limit.',
    { required: textureRecords.length, limit: maxLayers }));
  if (diagnostics.some(entry => entry.severity === 'error')) return freezeResult(null, diagnostics);

  const materials = packMaterials(records);
  const surfaces = packSurfaces(acceleration, geometrySources, diagnostics);
  const textures = packTextures(textureRecords, options.maxTextureDimension ?? 4096, diagnostics);
  if (!surfaces || !textures || diagnostics.some(entry => entry.severity === 'error')) return freezeResult(null, diagnostics);
  const sceneFingerprint = fingerprint([
    'ray-material-scene-v1', acceleration.fingerprint,
    ...records.flatMap(record => [record.identity, String(record.material.baseColor.version), ...TEXTURE_SLOTS.map(slot => String(record.textureLayers[slot]))]),
    textures.fingerprint,
    bytesToken(new Uint8Array(materials.data)), bytesToken(new Uint8Array(surfaces.data)),
  ].join('|'));
  const packed: RayPackedMaterialScene = Object.freeze({
    schemaVersion: 1,
    accelerationFingerprint: acceleration.fingerprint,
    revision: `ray-material:${world.id}:${world.componentChangeRevision}:${sceneFingerprint}`,
    fingerprint: sceneFingerprint,
    materials,
    surfaces,
    textures,
    materialIdentities: Object.freeze([...acceleration.materialIdentities]),
    diagnostics: Object.freeze([...diagnostics]),
    unsupportedFeatures: Object.freeze([...unsupported].sort()),
  });
  return freezeResult(packed, diagnostics);
}

function classifyUnsupported(
  material: PbrMaterial,
  identity: string,
  unsupported: Set<string>,
  diagnostics: RayMaterialDiagnostic[],
): void {
  const features: string[] = [];
  if (material.alphaMode !== 'opaque') features.push(`alpha-mode:${material.alphaMode}`);
  if (material.clearcoatFactor !== 0 || material.clearcoatTexture || material.clearcoatRoughnessFactor !== 0
    || material.clearcoatRoughnessTexture || material.clearcoatNormalTexture) features.push('clearcoat');
  if (material.sheenColorFactor.some(value => value !== 0) || material.sheenRoughnessFactor !== 0
    || material.sheenColorTexture || material.sheenRoughnessTexture) features.push('sheen');
  if (material.transmissionFactor !== 0 || material.transmissionTexture) features.push('transmission');
  if (material.thicknessFactor !== 0 || material.thicknessTexture || material.attenuationDistance !== Infinity
    || material.attenuationColor.some(value => value !== 1)) features.push('volume');
  if (material.specularTexture) features.push('specular-texture');
  if (material.specularColorTexture) features.push('specular-color-texture');
  for (const feature of features) {
    unsupported.add(feature);
    diagnostics.push(materialDiagnostic('material-pack', 'error', 'RAY_MATERIAL_FEATURE_UNSUPPORTED',
      `Material ${identity} uses unsupported feature ${feature}; it was not approximated.`,
      { materialIdentity: identity, feature }));
  }
}

function packMaterials(records: readonly MaterialRecord[]) {
  const data = new ArrayBuffer(records.length * MATERIAL_STRIDE);
  const view = new DataView(data);
  records.forEach((record, index) => {
    const offset = index * MATERIAL_STRIDE;
    const material = record.material;
    const baseColor = material.baseColor.writeLinear(new Float32Array(4));
    for (let item = 0; item < 4; item++) view.setFloat32(offset + item * 4, baseColor[item]!, true);
    for (let item = 0; item < 3; item++) view.setFloat32(offset + 16 + item * 4, material.emissiveFactor[item]!, true);
    view.setFloat32(offset + 28, material.metallic, true);
    view.setFloat32(offset + 32, material.roughness, true);
    view.setFloat32(offset + 36, material.ior, true);
    view.setFloat32(offset + 40, material.specularFactor, true);
    view.setFloat32(offset + 44, material.normalScale, true);
    for (let item = 0; item < 3; item++) view.setFloat32(offset + 48 + item * 4, material.specularColorFactor[item]!, true);
    view.setFloat32(offset + 60, material.occlusionStrength, true);
    TEXTURE_SLOTS.forEach((slot, slotIndex) => view.setUint32(offset + 64 + slotIndex * 4, record.textureLayers[slot], true));
    view.setUint32(offset + 84, material.doubleSided ? 1 : 0, true);
    TEXTURE_SLOTS.forEach((slot, slotIndex) => view.setUint32(offset + 88 + slotIndex * 4, material.getTextureMapping(slot).texCoord, true));
  });
  return Object.freeze({ stride: MATERIAL_STRIDE, count: records.length, data });
}

function packSurfaces(
  acceleration: RayPackedAcceleration,
  geometries: ReadonlyMap<string, Geometry3D>,
  diagnostics: RayMaterialDiagnostic[],
) {
  const primitiveBuffer = acceleration.buffers.primitives;
  const data = new ArrayBuffer(primitiveBuffer.count * SURFACE_STRIDE);
  const source = new DataView(primitiveBuffer.data);
  const target = new DataView(data);
  for (let packedIndex = 0; packedIndex < primitiveBuffer.count; packedIndex++) {
    const primitiveOffset = packedIndex * primitiveBuffer.stride;
    const kind = source.getUint32(primitiveOffset + 48, true);
    if (kind !== 0) continue;
    const primitiveIndex = source.getUint32(primitiveOffset + 52, true);
    const geometryIndex = source.getUint32(primitiveOffset + 56, true);
    const identity = acceleration.geometryIdentities[geometryIndex];
    const geometry = identity ? geometries.get(identity) : null;
    if (!geometry) {
      diagnostics.push(materialDiagnostic('surface-pack', 'error', 'RAY_SURFACE_GEOMETRY_MISSING',
        'A packed primitive references geometry that is not present in the source world.',
        { packedPrimitiveIndex: packedIndex, geometryIdentity: identity ?? `invalid:${geometryIndex}` }));
      continue;
    }
    const indices = triangleIndices(geometry, primitiveIndex);
    if (!indices) {
      diagnostics.push(materialDiagnostic('surface-pack', 'error', 'RAY_SURFACE_PRIMITIVE_INVALID',
        'A packed triangle cannot be resolved to source vertices.', { packedPrimitiveIndex: packedIndex, primitiveIndex }));
      continue;
    }
    const offset = packedIndex * SURFACE_STRIDE;
    const normals = geometry.normals;
    if (normals) {
      writeVec3(target, offset, normals, indices[0]);
      writeVec3(target, offset + 16, normals, indices[1]);
      writeVec3(target, offset + 32, normals, indices[2]);
      target.setUint32(offset + 12, 1, true);
    }
    const uv0 = geometry.getTextureCoordinates(0);
    const uv1 = geometry.getTextureCoordinates(1);
    if (uv0) {
      writeVec2(target, offset + 48, uv0, indices[0]);
      writeVec2(target, offset + 56, uv0, indices[1]);
      writeVec2(target, offset + 64, uv0, indices[2]);
      target.setUint32(offset + 96, target.getUint32(offset + 96, true) | 1, true);
    }
    if (uv1) {
      writeVec2(target, offset + 72, uv1, indices[0]);
      writeVec2(target, offset + 80, uv1, indices[1]);
      writeVec2(target, offset + 88, uv1, indices[2]);
      target.setUint32(offset + 96, target.getUint32(offset + 96, true) | 2, true);
    }
  }
  return Object.freeze({ stride: SURFACE_STRIDE, count: primitiveBuffer.count, data });
}

function packTextures(records: readonly TextureRecord[], maxDimension: number, diagnostics: RayMaterialDiagnostic[]): RayPackedTextureAtlas | null {
  let width = 1; let height = 1;
  for (const record of records) { width = Math.max(width, record.pixels.width); height = Math.max(height, record.pixels.height); }
  if (width > maxDimension || height > maxDimension) {
    diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_TEXTURE_DIMENSION_LIMIT_UNSUPPORTED',
      'Ray texture atlas exceeds the configured dimension limit.', { width, height, limit: maxDimension }));
    return null;
  }
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const layerCount = Math.max(1, records.length);
  const data = new Uint8Array(bytesPerRow * height * layerCount);
  if (records.length === 0) data.set([255, 255, 255, 255]);
  records.forEach((record, layer) => resample(record.pixels, data, layer * bytesPerRow * height, width, height, bytesPerRow));
  const identities = records.length > 0 ? records.map(record => record.key) : ['__empty__'];
  return Object.freeze({
    width, height, layerCount, bytesPerRow, data,
    identities: Object.freeze(identities),
    fingerprint: fingerprint(`${width}x${height}x${layerCount}|${identities.join('|')}|${bytesToken(data)}`),
  });
}

function validateTextureCoordinates(
  acceleration: RayPackedAcceleration,
  geometries: ReadonlyMap<string, Geometry3D>,
  records: readonly MaterialRecord[],
  diagnostics: RayMaterialDiagnostic[],
): void {
  const instances = new DataView(acceleration.buffers.instances.data);
  for (let index = 0; index < acceleration.buffers.instances.count; index++) {
    const offset = index * acceleration.buffers.instances.stride;
    const geometryIndex = instances.getUint32(offset + 128, true);
    const materialIndex = instances.getUint32(offset + 132, true);
    const record = records[materialIndex];
    const geometryIdentity = acceleration.geometryIdentities[geometryIndex];
    const geometry = geometryIdentity ? geometries.get(geometryIdentity) : null;
    if (!record || !geometry) continue;
    for (const slot of TEXTURE_SLOTS) {
      if (record.textureLayers[slot] === MISSING) continue;
      const texCoord = record.material.getTextureMapping(slot).texCoord;
      if (!geometry.getTextureCoordinates(texCoord)) diagnostics.push(materialDiagnostic('surface-pack', 'error',
        'RAY_SURFACE_UV_MISSING', `Geometry ${geometryIdentity} has no TEXCOORD_${texCoord} required by ${slot}.`,
        { geometryIdentity: geometryIdentity!, materialIdentity: record.identity, slot, texCoord }));
    }
  }
}

function validatePixels(pixels: RayTexturePixels, identity: string, slot: string, diagnostics: RayMaterialDiagnostic[]): boolean {
  const valid = Boolean(pixels.identity) && Number.isInteger(pixels.revision) && pixels.revision >= 0
    && Number.isInteger(pixels.width) && pixels.width > 0 && Number.isInteger(pixels.height) && pixels.height > 0
    && pixels.data.byteLength === pixels.width * pixels.height * 4;
  if (!valid) diagnostics.push(materialDiagnostic('texture-pack', 'error', 'RAY_TEXTURE_PIXELS_INVALID',
    'Resolved ray texture must contain identity, non-negative revision, dimensions, and tightly packed RGBA8 data.',
    { materialIdentity: identity, slot }));
  return valid;
}

function textureSource(material: PbrMaterial, slot: SupportedTextureSlot) {
  if (slot === 'baseColor') return material.baseColorTexture;
  if (slot === 'metallicRoughness') return material.metallicRoughnessTexture;
  if (slot === 'normal') return material.normalTexture;
  if (slot === 'occlusion') return material.occlusionTexture;
  return material.emissiveTexture;
}
function triangleIndices(geometry: Geometry3D, primitiveIndex: number): readonly [number, number, number] | null {
  const base = primitiveIndex * 3;
  const a = geometry.indices?.[base] ?? base;
  const b = geometry.indices?.[base + 1] ?? base + 1;
  const c = geometry.indices?.[base + 2] ?? base + 2;
  return a < geometry.vertexCount && b < geometry.vertexCount && c < geometry.vertexCount ? [a, b, c] : null;
}
function writeVec3(view: DataView, offset: number, values: Float32Array, index: number): void {
  view.setFloat32(offset, values[index * 3]!, true); view.setFloat32(offset + 4, values[index * 3 + 1]!, true); view.setFloat32(offset + 8, values[index * 3 + 2]!, true);
}
function writeVec2(view: DataView, offset: number, values: Float32Array, index: number): void {
  view.setFloat32(offset, values[index * 2]!, true); view.setFloat32(offset + 4, values[index * 2 + 1]!, true);
}
function resample(source: RayTexturePixels, target: Uint8Array, targetOffset: number, width: number, height: number, bytesPerRow: number): void {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(source.width - 1, Math.floor((x + 0.5) * source.width / width));
    const sy = Math.min(source.height - 1, Math.floor((y + 0.5) * source.height / height));
    const sourceOffset = (sy * source.width + sx) * 4;
    const outputOffset = targetOffset + y * bytesPerRow + x * 4;
    target.set(source.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
  }
}
function resolveWorld(source: Scene | World): World { return 'world' in source ? source.world : source; }
function isHierarchyDisabled(entity: Entity): boolean {
  let current: Entity | null = entity;
  while (current) { if (current.disabled || current.destroyed) return true; current = current.parent; }
  return false;
}
function freezeResult(packed: RayPackedMaterialScene | null, diagnostics: RayMaterialDiagnostic[]): RayMaterialPackResult {
  return Object.freeze({ packed, diagnostics: Object.freeze([...diagnostics]) });
}
function bytesToken(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function fingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}
