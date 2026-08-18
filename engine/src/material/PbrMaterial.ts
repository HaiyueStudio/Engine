import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { GEOMETRY3D_UV_CHANNEL_CAPACITY } from '../geometry/Geometry3D';
import type { MaterialTextureSource } from './BasicMaterial';
import { Material, type MaterialShaderContract } from './Material';
import {
  booleanValue,
  clampedNumber,
  enumValue,
  finiteNumber,
  finiteVec3,
  materialColor,
  nonNegativeNumber,
  sameMaterialColor,
  sameSamplerDescriptor,
  sameVec3,
  samplerDescriptor,
} from './materialValidation';

export type PbrAlphaMode = 'opaque' | 'mask' | 'blend';
export type PbrTextureSlot =
  | 'baseColor'
  | 'metallicRoughness'
  | 'normal'
  | 'occlusion'
  | 'emissive'
  | 'clearcoat'
  | 'clearcoatRoughness'
  | 'clearcoatNormal'
  | 'specular'
  | 'specularColor'
  | 'sheenColor'
  | 'sheenRoughness'
  | 'transmission'
  | 'thickness';
export type PbrTextureColorSpace = 'srgb' | 'linear';
export type PbrTextureSamplers = Readonly<Partial<Record<PbrTextureSlot, GPUSamplerDescriptor | null>>>;

export interface PbrCompatibilityContract {
  /** Physical shader channels; imported semantic indices are mapped dynamically. */
  readonly supportedUvSets: readonly [0, 1];
  readonly uvSemanticMapping: 'dynamic-per-primitive';
  readonly uvChannelCapacity: typeof GEOMETRY3D_UV_CHANNEL_CAPACITY;
  readonly samplerScope: 'per-texture-slot';
  readonly runtimeImageMipmaps: 'generated-full-chain';
  readonly compressedTextureMipmaps: 'source-provided';
  readonly textureSlots: Readonly<Record<PbrTextureSlot, Readonly<{
    colorSpace: PbrTextureColorSpace;
    format: 'rgba8unorm-srgb' | 'rgba8unorm';
  }>>>;
}

export const PBR_TEXTURE_SLOTS: readonly PbrTextureSlot[] = Object.freeze([
  'baseColor', 'metallicRoughness', 'normal', 'occlusion', 'emissive',
  'clearcoat', 'clearcoatRoughness', 'clearcoatNormal',
  'specular', 'specularColor',
  'sheenColor', 'sheenRoughness',
  'transmission', 'thickness',
]);

/** Asset semantics supported by the metallic-roughness pipeline. */
export const PBR_COMPATIBILITY_CONTRACT: PbrCompatibilityContract = Object.freeze({
  supportedUvSets: Object.freeze([0, 1] as [0, 1]),
  uvSemanticMapping: 'dynamic-per-primitive',
  uvChannelCapacity: GEOMETRY3D_UV_CHANNEL_CAPACITY,
  samplerScope: 'per-texture-slot',
  runtimeImageMipmaps: 'generated-full-chain',
  compressedTextureMipmaps: 'source-provided',
  textureSlots: Object.freeze({
    baseColor: Object.freeze({ colorSpace: 'srgb', format: 'rgba8unorm-srgb' }),
    metallicRoughness: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    normal: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    occlusion: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    emissive: Object.freeze({ colorSpace: 'srgb', format: 'rgba8unorm-srgb' }),
    clearcoat: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    clearcoatRoughness: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    clearcoatNormal: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    specular: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    specularColor: Object.freeze({ colorSpace: 'srgb', format: 'rgba8unorm-srgb' }),
    sheenColor: Object.freeze({ colorSpace: 'srgb', format: 'rgba8unorm-srgb' }),
    sheenRoughness: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    transmission: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
    thickness: Object.freeze({ colorSpace: 'linear', format: 'rgba8unorm' }),
  }),
});

export function getPbrTextureFormat(slot: PbrTextureSlot): 'rgba8unorm-srgb' | 'rgba8unorm' {
  return PBR_COMPATIBILITY_CONTRACT.textureSlots[slot].format;
}

export interface PbrTextureMappingOptions {
  texCoord?: 0 | 1;
  offset?: readonly [number, number];
  rotation?: number;
  scale?: readonly [number, number];
}

export interface PbrTextureMapping {
  readonly texCoord: 0 | 1;
  readonly offset: readonly [number, number];
  readonly rotation: number;
  readonly scale: readonly [number, number];
}

export type PbrTextureMappings = Readonly<Partial<Record<PbrTextureSlot, PbrTextureMappingOptions>>>;

export interface PbrMaterialState {
  baseColor?: ColorLike;
  metallic?: number;
  roughness?: number;
  baseColorTexture?: MaterialTextureSource;
  metallicRoughnessTexture?: MaterialTextureSource;
  normalTexture?: MaterialTextureSource;
  normalScale?: number;
  occlusionTexture?: MaterialTextureSource;
  occlusionStrength?: number;
  emissiveTexture?: MaterialTextureSource;
  emissiveFactor?: readonly [number, number, number];
  clearcoatFactor?: number;
  clearcoatTexture?: MaterialTextureSource;
  clearcoatRoughnessFactor?: number;
  clearcoatRoughnessTexture?: MaterialTextureSource;
  clearcoatNormalTexture?: MaterialTextureSource;
  clearcoatNormalScale?: number;
  /** Index of refraction used by the dielectric Fresnel term. glTF default: 1.5. */
  ior?: number;
  /** Dielectric specular reflection weight. */
  specularFactor?: number;
  /** Linear RGB multiplier for dielectric F0. Values above 1 are valid. */
  specularColorFactor?: readonly [number, number, number];
  /** KHR_materials_specular strength texture; the alpha channel is sampled. */
  specularTexture?: MaterialTextureSource;
  /** KHR_materials_specular color texture; RGB is decoded from sRGB. */
  specularColorTexture?: MaterialTextureSource;
  /** Linear RGB sheen color factor. */
  sheenColorFactor?: readonly [number, number, number];
  /** Perceptual sheen roughness. */
  sheenRoughnessFactor?: number;
  /** KHR_materials_sheen color texture; RGB is decoded from sRGB. */
  sheenColorTexture?: MaterialTextureSource;
  /** KHR_materials_sheen roughness texture; the alpha channel is sampled. */
  sheenRoughnessTexture?: MaterialTextureSource;
  /** Fraction of non-metallic light transmitted through the surface. */
  transmissionFactor?: number;
  /** KHR_materials_transmission texture; the red channel is sampled. */
  transmissionTexture?: MaterialTextureSource;
  /** Maximum volume thickness in mesh-space units. */
  thicknessFactor?: number;
  /** KHR_materials_volume thickness texture; the green channel is sampled. */
  thicknessTexture?: MaterialTextureSource;
  /** Distance at which attenuationColor is reached. Infinity disables attenuation. */
  attenuationDistance?: number;
  /** Linear RGB volume attenuation color. */
  attenuationColor?: readonly [number, number, number];
  /** UV set and KHR_texture_transform mapping for each texture slot. */
  textureMappings?: PbrTextureMappings;
  /** Per-slot sampling state. */
  samplers?: PbrTextureSamplers;
  alphaMode?: PbrAlphaMode;
  alphaCutoff?: number;
  doubleSided?: boolean;
}

export interface PbrMaterialVariant {
  readonly name: string;
  readonly state: Readonly<PbrMaterialState>;
}

export interface PbrMaterialOptions extends PbrMaterialState {
  variants?: readonly PbrMaterialVariant[];
}

interface ResolvedPbrMaterialState {
  readonly baseColor: ColorValue;
  readonly metallic: number;
  readonly roughness: number;
  readonly baseColorTexture: MaterialTextureSource;
  readonly metallicRoughnessTexture: MaterialTextureSource;
  readonly normalTexture: MaterialTextureSource;
  readonly normalScale: number;
  readonly occlusionTexture: MaterialTextureSource;
  readonly occlusionStrength: number;
  readonly emissiveTexture: MaterialTextureSource;
  readonly emissiveFactor: readonly [number, number, number];
  readonly clearcoatFactor: number;
  readonly clearcoatTexture: MaterialTextureSource;
  readonly clearcoatRoughnessFactor: number;
  readonly clearcoatRoughnessTexture: MaterialTextureSource;
  readonly clearcoatNormalTexture: MaterialTextureSource;
  readonly clearcoatNormalScale: number;
  readonly ior: number;
  readonly specularFactor: number;
  readonly specularColorFactor: readonly [number, number, number];
  readonly specularTexture: MaterialTextureSource;
  readonly specularColorTexture: MaterialTextureSource;
  readonly sheenColorFactor: readonly [number, number, number];
  readonly sheenRoughnessFactor: number;
  readonly sheenColorTexture: MaterialTextureSource;
  readonly sheenRoughnessTexture: MaterialTextureSource;
  readonly transmissionFactor: number;
  readonly transmissionTexture: MaterialTextureSource;
  readonly thicknessFactor: number;
  readonly thicknessTexture: MaterialTextureSource;
  readonly attenuationDistance: number;
  readonly attenuationColor: readonly [number, number, number];
  readonly textureMappings: Readonly<Record<PbrTextureSlot, PbrTextureMapping>>;
  readonly samplers: PbrTextureSamplers;
  readonly alphaMode: PbrAlphaMode;
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
}

export const PBR_SHADER_CONTRACT: MaterialShaderContract = Object.freeze({
  id: 'haiyue.material.metallic-roughness',
  version: 8,
  shadingModel: 'metallic-roughness',
  vertexSemantics: Object.freeze(['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'] as const),
  features: Object.freeze([
    'base-color',
    'metallic-roughness',
    'normal-map',
    'occlusion',
    'emissive',
    'directional-shadow',
    'environment-ibl',
    'material-variants',
    'clearcoat',
    'ior',
    'specular',
    'sheen',
    'transmission',
    'volume',
    'gpu-morph',
    'skinning',
  ]),
});

export class PbrMaterial extends Material {
  readonly type = 'pbr-metallic-roughness';

  private _baseColor: ColorValue;
  private _metallic: number;
  private _roughness: number;
  private _baseColorTexture: MaterialTextureSource;
  private _metallicRoughnessTexture: MaterialTextureSource;
  private _normalTexture: MaterialTextureSource;
  private _normalScale: number;
  private _occlusionTexture: MaterialTextureSource;
  private _occlusionStrength: number;
  private _emissiveTexture: MaterialTextureSource;
  private _emissiveFactor: readonly [number, number, number];
  private _clearcoatFactor: number;
  private _clearcoatTexture: MaterialTextureSource;
  private _clearcoatRoughnessFactor: number;
  private _clearcoatRoughnessTexture: MaterialTextureSource;
  private _clearcoatNormalTexture: MaterialTextureSource;
  private _clearcoatNormalScale: number;
  private _ior: number;
  private _specularFactor: number;
  private _specularColorFactor: readonly [number, number, number];
  private _specularTexture: MaterialTextureSource;
  private _specularColorTexture: MaterialTextureSource;
  private _sheenColorFactor: readonly [number, number, number];
  private _sheenRoughnessFactor: number;
  private _sheenColorTexture: MaterialTextureSource;
  private _sheenRoughnessTexture: MaterialTextureSource;
  private _transmissionFactor: number;
  private _transmissionTexture: MaterialTextureSource;
  private _thicknessFactor: number;
  private _thicknessTexture: MaterialTextureSource;
  private _attenuationDistance: number;
  private _attenuationColor: readonly [number, number, number];
  private _textureMappings: Readonly<Record<PbrTextureSlot, PbrTextureMapping>>;
  private _alphaMode: PbrAlphaMode;
  private _alphaCutoff: number;
  private _doubleSided: boolean;
  private _samplers: PbrTextureSamplers;

  private readonly _baseState: Readonly<PbrMaterialState>;
  private readonly _baseResolvedState: ResolvedPbrMaterialState;
  private readonly _variants = new Map<string, Readonly<PbrMaterialState>>();
  private readonly _resolvedVariants = new Map<string, ResolvedPbrMaterialState>();
  private readonly _variantNames: readonly string[];
  private _activeVariant: string | null = null;
  private _activeVariantRevision = 0;

  constructor(options: PbrMaterialOptions = {}) {
    super();
    this._baseColor = materialColor(options.baseColor ?? [1, 1, 1, 1], 'PbrMaterial.baseColor');
    this._metallic = clampedNumber(options.metallic ?? 1, 0, 1, 'PbrMaterial.metallic');
    this._roughness = clampedNumber(options.roughness ?? 1, 0.04, 1, 'PbrMaterial.roughness');
    this._baseColorTexture = options.baseColorTexture ?? null;
    this._metallicRoughnessTexture = options.metallicRoughnessTexture ?? null;
    this._normalTexture = options.normalTexture ?? null;
    this._normalScale = nonNegativeNumber(options.normalScale ?? 1, 'PbrMaterial.normalScale');
    this._occlusionTexture = options.occlusionTexture ?? null;
    this._occlusionStrength = clampedNumber(options.occlusionStrength ?? 1, 0, 1, 'PbrMaterial.occlusionStrength');
    this._emissiveTexture = options.emissiveTexture ?? null;
    this._emissiveFactor = finiteVec3(options.emissiveFactor ?? [0, 0, 0], 'PbrMaterial.emissiveFactor', 0);
    this._clearcoatFactor = clampedNumber(options.clearcoatFactor ?? 0, 0, 1, 'PbrMaterial.clearcoatFactor');
    this._clearcoatTexture = options.clearcoatTexture ?? null;
    this._clearcoatRoughnessFactor = clampedNumber(options.clearcoatRoughnessFactor ?? 0, 0, 1, 'PbrMaterial.clearcoatRoughnessFactor');
    this._clearcoatRoughnessTexture = options.clearcoatRoughnessTexture ?? null;
    this._clearcoatNormalTexture = options.clearcoatNormalTexture ?? null;
    this._clearcoatNormalScale = nonNegativeNumber(options.clearcoatNormalScale ?? 1, 'PbrMaterial.clearcoatNormalScale');
    this._ior = nonNegativeNumber(options.ior ?? 1.5, 'PbrMaterial.ior');
    this._specularFactor = clampedNumber(options.specularFactor ?? 1, 0, 1, 'PbrMaterial.specularFactor');
    this._specularColorFactor = finiteVec3(options.specularColorFactor ?? [1, 1, 1], 'PbrMaterial.specularColorFactor', 0);
    this._specularTexture = options.specularTexture ?? null;
    this._specularColorTexture = options.specularColorTexture ?? null;
    this._sheenColorFactor = unitVec3(options.sheenColorFactor ?? [0, 0, 0], 'PbrMaterial.sheenColorFactor');
    this._sheenRoughnessFactor = clampedNumber(options.sheenRoughnessFactor ?? 0, 0, 1, 'PbrMaterial.sheenRoughnessFactor');
    this._sheenColorTexture = options.sheenColorTexture ?? null;
    this._sheenRoughnessTexture = options.sheenRoughnessTexture ?? null;
    this._transmissionFactor = clampedNumber(options.transmissionFactor ?? 0, 0, 1, 'PbrMaterial.transmissionFactor');
    this._transmissionTexture = options.transmissionTexture ?? null;
    this._thicknessFactor = nonNegativeNumber(options.thicknessFactor ?? 0, 'PbrMaterial.thicknessFactor');
    this._thicknessTexture = options.thicknessTexture ?? null;
    this._attenuationDistance = positiveDistance(options.attenuationDistance ?? Infinity, 'PbrMaterial.attenuationDistance');
    this._attenuationColor = unitVec3(options.attenuationColor ?? [1, 1, 1], 'PbrMaterial.attenuationColor');
    this._textureMappings = resolveTextureMappings(options.textureMappings);
    this._alphaMode = enumValue(options.alphaMode ?? 'opaque', ['opaque', 'mask', 'blend'], 'PbrMaterial.alphaMode');
    this._alphaCutoff = clampedNumber(options.alphaCutoff ?? 0.5, 0, 1, 'PbrMaterial.alphaCutoff');
    this._doubleSided = booleanValue(options.doubleSided ?? false, 'PbrMaterial.doubleSided');
    this._samplers = resolveTextureSamplers(options.samplers);
    this._baseState = Object.freeze(this.snapshot());
    this._baseResolvedState = this._captureResolvedState();
    for (const variant of options.variants ?? []) {
      if (!variant.name.trim()) continue;
      this._variants.set(variant.name, Object.freeze({ ...this._baseState, ...variant.state }));
    }
    this._variantNames = Object.freeze([...this._variants.keys()]);
  }

  get baseColor(): ColorValue { return this._baseColor; }
  set baseColor(value: ColorLike) {
    const next = materialColor(value, 'PbrMaterial.baseColor');
    if (sameMaterialColor(this._baseColor, next)) return;
    this._baseColor = next;
    this._stateChanged();
  }
  get metallic(): number { return this._metallic; }
  set metallic(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.metallic');
    if (this._metallic === next) return;
    this._metallic = next;
    this._stateChanged();
  }
  get roughness(): number { return this._roughness; }
  set roughness(value: number) {
    const next = clampedNumber(value, 0.04, 1, 'PbrMaterial.roughness');
    if (this._roughness === next) return;
    this._roughness = next;
    this._stateChanged();
  }
  get baseColorTexture(): MaterialTextureSource { return this._baseColorTexture; }
  set baseColorTexture(value: MaterialTextureSource) {
    if (this._baseColorTexture === value) return;
    this._baseColorTexture = value;
    this._stateChanged();
  }
  get metallicRoughnessTexture(): MaterialTextureSource { return this._metallicRoughnessTexture; }
  set metallicRoughnessTexture(value: MaterialTextureSource) {
    if (this._metallicRoughnessTexture === value) return;
    this._metallicRoughnessTexture = value;
    this._stateChanged();
  }
  get normalTexture(): MaterialTextureSource { return this._normalTexture; }
  set normalTexture(value: MaterialTextureSource) {
    if (this._normalTexture === value) return;
    this._normalTexture = value;
    this._stateChanged();
  }
  get normalScale(): number { return this._normalScale; }
  set normalScale(value: number) {
    const next = nonNegativeNumber(value, 'PbrMaterial.normalScale');
    if (this._normalScale === next) return;
    this._normalScale = next;
    this._stateChanged();
  }
  get occlusionTexture(): MaterialTextureSource { return this._occlusionTexture; }
  set occlusionTexture(value: MaterialTextureSource) {
    if (this._occlusionTexture === value) return;
    this._occlusionTexture = value;
    this._stateChanged();
  }
  get occlusionStrength(): number { return this._occlusionStrength; }
  set occlusionStrength(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.occlusionStrength');
    if (this._occlusionStrength === next) return;
    this._occlusionStrength = next;
    this._stateChanged();
  }
  get emissiveTexture(): MaterialTextureSource { return this._emissiveTexture; }
  set emissiveTexture(value: MaterialTextureSource) {
    if (this._emissiveTexture === value) return;
    this._emissiveTexture = value;
    this._stateChanged();
  }
  get emissiveFactor(): readonly [number, number, number] { return this._emissiveFactor; }
  set emissiveFactor(value: readonly [number, number, number]) {
    const next = finiteVec3(value, 'PbrMaterial.emissiveFactor', 0);
    if (sameVec3(this._emissiveFactor, next)) return;
    this._emissiveFactor = next;
    this._stateChanged();
  }
  get clearcoatFactor(): number { return this._clearcoatFactor; }
  set clearcoatFactor(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.clearcoatFactor');
    if (this._clearcoatFactor === next) return;
    this._clearcoatFactor = next;
    this._stateChanged();
  }
  get clearcoatTexture(): MaterialTextureSource { return this._clearcoatTexture; }
  set clearcoatTexture(value: MaterialTextureSource) {
    if (this._clearcoatTexture === value) return;
    this._clearcoatTexture = value;
    this._stateChanged();
  }
  get clearcoatRoughnessFactor(): number { return this._clearcoatRoughnessFactor; }
  set clearcoatRoughnessFactor(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.clearcoatRoughnessFactor');
    if (this._clearcoatRoughnessFactor === next) return;
    this._clearcoatRoughnessFactor = next;
    this._stateChanged();
  }
  get clearcoatRoughnessTexture(): MaterialTextureSource { return this._clearcoatRoughnessTexture; }
  set clearcoatRoughnessTexture(value: MaterialTextureSource) {
    if (this._clearcoatRoughnessTexture === value) return;
    this._clearcoatRoughnessTexture = value;
    this._stateChanged();
  }
  get clearcoatNormalTexture(): MaterialTextureSource { return this._clearcoatNormalTexture; }
  set clearcoatNormalTexture(value: MaterialTextureSource) {
    if (this._clearcoatNormalTexture === value) return;
    this._clearcoatNormalTexture = value;
    this._stateChanged();
  }
  get clearcoatNormalScale(): number { return this._clearcoatNormalScale; }
  set clearcoatNormalScale(value: number) {
    const next = nonNegativeNumber(value, 'PbrMaterial.clearcoatNormalScale');
    if (this._clearcoatNormalScale === next) return;
    this._clearcoatNormalScale = next;
    this._stateChanged();
  }
  get ior(): number { return this._ior; }
  set ior(value: number) {
    const next = nonNegativeNumber(value, 'PbrMaterial.ior');
    if (this._ior === next) return;
    this._ior = next;
    this._stateChanged();
  }
  get specularFactor(): number { return this._specularFactor; }
  set specularFactor(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.specularFactor');
    if (this._specularFactor === next) return;
    this._specularFactor = next;
    this._stateChanged();
  }
  get specularColorFactor(): readonly [number, number, number] { return this._specularColorFactor; }
  set specularColorFactor(value: readonly [number, number, number]) {
    const next = finiteVec3(value, 'PbrMaterial.specularColorFactor', 0);
    if (sameVec3(this._specularColorFactor, next)) return;
    this._specularColorFactor = next;
    this._stateChanged();
  }
  get specularTexture(): MaterialTextureSource { return this._specularTexture; }
  set specularTexture(value: MaterialTextureSource) {
    if (this._specularTexture === value) return;
    this._specularTexture = value;
    this._stateChanged();
  }
  get specularColorTexture(): MaterialTextureSource { return this._specularColorTexture; }
  set specularColorTexture(value: MaterialTextureSource) {
    if (this._specularColorTexture === value) return;
    this._specularColorTexture = value;
    this._stateChanged();
  }
  get sheenColorFactor(): readonly [number, number, number] { return this._sheenColorFactor; }
  set sheenColorFactor(value: readonly [number, number, number]) {
    const next = unitVec3(value, 'PbrMaterial.sheenColorFactor');
    if (sameVec3(this._sheenColorFactor, next)) return;
    this._sheenColorFactor = next;
    this._stateChanged();
  }
  get sheenRoughnessFactor(): number { return this._sheenRoughnessFactor; }
  set sheenRoughnessFactor(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.sheenRoughnessFactor');
    if (this._sheenRoughnessFactor === next) return;
    this._sheenRoughnessFactor = next;
    this._stateChanged();
  }
  get sheenColorTexture(): MaterialTextureSource { return this._sheenColorTexture; }
  set sheenColorTexture(value: MaterialTextureSource) {
    if (this._sheenColorTexture === value) return;
    this._sheenColorTexture = value;
    this._stateChanged();
  }
  get sheenRoughnessTexture(): MaterialTextureSource { return this._sheenRoughnessTexture; }
  set sheenRoughnessTexture(value: MaterialTextureSource) {
    if (this._sheenRoughnessTexture === value) return;
    this._sheenRoughnessTexture = value;
    this._stateChanged();
  }
  get transmissionFactor(): number { return this._transmissionFactor; }
  set transmissionFactor(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.transmissionFactor');
    if (this._transmissionFactor === next) return;
    this._transmissionFactor = next;
    this._stateChanged();
  }
  get transmissionTexture(): MaterialTextureSource { return this._transmissionTexture; }
  set transmissionTexture(value: MaterialTextureSource) {
    if (this._transmissionTexture === value) return;
    this._transmissionTexture = value;
    this._stateChanged();
  }
  get thicknessFactor(): number { return this._thicknessFactor; }
  set thicknessFactor(value: number) {
    const next = nonNegativeNumber(value, 'PbrMaterial.thicknessFactor');
    if (this._thicknessFactor === next) return;
    this._thicknessFactor = next;
    this._stateChanged();
  }
  get thicknessTexture(): MaterialTextureSource { return this._thicknessTexture; }
  set thicknessTexture(value: MaterialTextureSource) {
    if (this._thicknessTexture === value) return;
    this._thicknessTexture = value;
    this._stateChanged();
  }
  get attenuationDistance(): number { return this._attenuationDistance; }
  set attenuationDistance(value: number) {
    const next = positiveDistance(value, 'PbrMaterial.attenuationDistance');
    if (this._attenuationDistance === next) return;
    this._attenuationDistance = next;
    this._stateChanged();
  }
  get attenuationColor(): readonly [number, number, number] { return this._attenuationColor; }
  set attenuationColor(value: readonly [number, number, number]) {
    const next = unitVec3(value, 'PbrMaterial.attenuationColor');
    if (sameVec3(this._attenuationColor, next)) return;
    this._attenuationColor = next;
    this._stateChanged();
  }
  get alphaMode(): PbrAlphaMode { return this._alphaMode; }
  set alphaMode(value: PbrAlphaMode) {
    const next = enumValue(value, ['opaque', 'mask', 'blend'], 'PbrMaterial.alphaMode');
    if (this._alphaMode === next) return;
    this._alphaMode = next;
    this._stateChanged();
  }
  get alphaCutoff(): number { return this._alphaCutoff; }
  set alphaCutoff(value: number) {
    const next = clampedNumber(value, 0, 1, 'PbrMaterial.alphaCutoff');
    if (this._alphaCutoff === next) return;
    this._alphaCutoff = next;
    this._stateChanged();
  }
  get doubleSided(): boolean { return this._doubleSided; }
  set doubleSided(value: boolean) {
    const next = booleanValue(value, 'PbrMaterial.doubleSided');
    if (this._doubleSided === next) return;
    this._doubleSided = next;
    this._stateChanged();
  }
  get samplers(): PbrTextureSamplers { return this._samplers; }
  set samplers(value: PbrTextureSamplers) {
    const next = resolveTextureSamplers(value);
    if (sameTextureSamplers(this._samplers, next)) return;
    this._samplers = next;
    this._stateChanged();
  }

  get activeVariant(): string | null { return this._activeVariant; }
  get variantNames(): readonly string[] { return this._variantNames; }
  get textureMappings(): Readonly<Record<PbrTextureSlot, PbrTextureMapping>> { return this._textureMappings; }
  getBaseState(): Readonly<PbrMaterialState> { return this._baseState; }
  getVariantState(name: string): Readonly<PbrMaterialState> | null { return this._variants.get(name) ?? null; }
  getTextureMapping(slot: PbrTextureSlot): PbrTextureMapping {
    validateTextureSlot(slot);
    return this.textureMappings[slot];
  }
  getTextureSampler(slot: PbrTextureSlot): GPUSamplerDescriptor | null {
    validateTextureSlot(slot);
    return this.samplers[slot] ?? null;
  }

  setTextureMapping(slot: PbrTextureSlot, mapping: PbrTextureMappingOptions = {}): this {
    validateTextureSlot(slot);
    const next = resolveTextureMapping(mapping);
    if (sameTextureMapping(this._textureMappings[slot], next)) return this;
    this._textureMappings = Object.freeze({
      ...this._textureMappings,
      [slot]: next,
    });
    this._stateChanged();
    return this;
  }

  setTextureSampler(slot: PbrTextureSlot, sampler: GPUSamplerDescriptor | null): this {
    validateTextureSlot(slot);
    const next = samplerDescriptor(sampler, `PbrMaterial.samplers.${slot}`);
    const hasOverride = Object.prototype.hasOwnProperty.call(this._samplers, slot);
    if (hasOverride && sameSamplerDescriptor(this._samplers[slot] ?? null, next)) return this;
    this._samplers = Object.freeze({ ...this._samplers, [slot]: next });
    this._stateChanged();
    return this;
  }

  setVariant(name: string | null): this {
    const state = name === null ? this._baseState : this._variants.get(name);
    if (!state) throw new RangeError(`Unknown PBR material variant "${name}".`);
    if (this._activeVariant === name && this._activeVariantRevision === this.revision) return this;

    const resolved = name === null ? this._baseResolvedState : this._resolvedVariants.get(name);
    if (resolved) {
      this.mutateState(() => {
        const stateChanged = this._applyResolvedState(resolved);
        const variantChanged = this._activeVariant !== name;
        this._activeVariant = name;
        if (stateChanged || variantChanged) this._stateChanged();
      });
    } else {
      this.mutateState(() => {
        this.applyState(state);
        if (this._activeVariant !== name) {
          this._activeVariant = name;
          this._stateChanged();
        }
      });
      this._resolvedVariants.set(name as string, this._captureResolvedState());
    }
    this._activeVariantRevision = this.revision;
    return this;
  }

  applyState(state: PbrMaterialState): this {
    this.mutateState(() => {
      if (state.baseColor !== undefined) this.baseColor = state.baseColor;
      if (state.metallic !== undefined) this.metallic = state.metallic;
      if (state.roughness !== undefined) this.roughness = state.roughness;
      if (state.baseColorTexture !== undefined) this.baseColorTexture = state.baseColorTexture;
      if (state.metallicRoughnessTexture !== undefined) this.metallicRoughnessTexture = state.metallicRoughnessTexture;
      if (state.normalTexture !== undefined) this.normalTexture = state.normalTexture;
      if (state.normalScale !== undefined) this.normalScale = state.normalScale;
      if (state.occlusionTexture !== undefined) this.occlusionTexture = state.occlusionTexture;
      if (state.occlusionStrength !== undefined) this.occlusionStrength = state.occlusionStrength;
      if (state.emissiveTexture !== undefined) this.emissiveTexture = state.emissiveTexture;
      if (state.emissiveFactor !== undefined) this.emissiveFactor = state.emissiveFactor;
      if (state.clearcoatFactor !== undefined) this.clearcoatFactor = state.clearcoatFactor;
      if (state.clearcoatTexture !== undefined) this.clearcoatTexture = state.clearcoatTexture;
      if (state.clearcoatRoughnessFactor !== undefined) this.clearcoatRoughnessFactor = state.clearcoatRoughnessFactor;
      if (state.clearcoatRoughnessTexture !== undefined) this.clearcoatRoughnessTexture = state.clearcoatRoughnessTexture;
      if (state.clearcoatNormalTexture !== undefined) this.clearcoatNormalTexture = state.clearcoatNormalTexture;
      if (state.clearcoatNormalScale !== undefined) this.clearcoatNormalScale = state.clearcoatNormalScale;
      if (state.ior !== undefined) this.ior = state.ior;
      if (state.specularFactor !== undefined) this.specularFactor = state.specularFactor;
      if (state.specularColorFactor !== undefined) this.specularColorFactor = state.specularColorFactor;
      if (state.specularTexture !== undefined) this.specularTexture = state.specularTexture;
      if (state.specularColorTexture !== undefined) this.specularColorTexture = state.specularColorTexture;
      if (state.sheenColorFactor !== undefined) this.sheenColorFactor = state.sheenColorFactor;
      if (state.sheenRoughnessFactor !== undefined) this.sheenRoughnessFactor = state.sheenRoughnessFactor;
      if (state.sheenColorTexture !== undefined) this.sheenColorTexture = state.sheenColorTexture;
      if (state.sheenRoughnessTexture !== undefined) this.sheenRoughnessTexture = state.sheenRoughnessTexture;
      if (state.transmissionFactor !== undefined) this.transmissionFactor = state.transmissionFactor;
      if (state.transmissionTexture !== undefined) this.transmissionTexture = state.transmissionTexture;
      if (state.thicknessFactor !== undefined) this.thicknessFactor = state.thicknessFactor;
      if (state.thicknessTexture !== undefined) this.thicknessTexture = state.thicknessTexture;
      if (state.attenuationDistance !== undefined) this.attenuationDistance = state.attenuationDistance;
      if (state.attenuationColor !== undefined) this.attenuationColor = state.attenuationColor;
      if (state.textureMappings !== undefined) {
        const next = resolveTextureMappings(state.textureMappings);
        if (!sameTextureMappings(this._textureMappings, next)) {
          this._textureMappings = next;
          this._stateChanged();
        }
      }
      if (state.samplers !== undefined) this.samplers = state.samplers;
      if (state.alphaMode !== undefined) this.alphaMode = state.alphaMode;
      if (state.alphaCutoff !== undefined) this.alphaCutoff = state.alphaCutoff;
      if (state.doubleSided !== undefined) this.doubleSided = state.doubleSided;
    });
    return this;
  }

  snapshot(): PbrMaterialState {
    return {
      baseColor: this.baseColor.clone(),
      metallic: this.metallic,
      roughness: this.roughness,
      baseColorTexture: this.baseColorTexture,
      metallicRoughnessTexture: this.metallicRoughnessTexture,
      normalTexture: this.normalTexture,
      normalScale: this.normalScale,
      occlusionTexture: this.occlusionTexture,
      occlusionStrength: this.occlusionStrength,
      emissiveTexture: this.emissiveTexture,
      emissiveFactor: [...this.emissiveFactor],
      clearcoatFactor: this.clearcoatFactor,
      clearcoatTexture: this.clearcoatTexture,
      clearcoatRoughnessFactor: this.clearcoatRoughnessFactor,
      clearcoatRoughnessTexture: this.clearcoatRoughnessTexture,
      clearcoatNormalTexture: this.clearcoatNormalTexture,
      clearcoatNormalScale: this.clearcoatNormalScale,
      ior: this.ior,
      specularFactor: this.specularFactor,
      specularColorFactor: [...this.specularColorFactor],
      specularTexture: this.specularTexture,
      specularColorTexture: this.specularColorTexture,
      sheenColorFactor: [...this.sheenColorFactor],
      sheenRoughnessFactor: this.sheenRoughnessFactor,
      sheenColorTexture: this.sheenColorTexture,
      sheenRoughnessTexture: this.sheenRoughnessTexture,
      transmissionFactor: this.transmissionFactor,
      transmissionTexture: this.transmissionTexture,
      thicknessFactor: this.thicknessFactor,
      thicknessTexture: this.thicknessTexture,
      attenuationDistance: this.attenuationDistance,
      attenuationColor: [...this.attenuationColor],
      textureMappings: this.textureMappings,
      samplers: this.samplers,
      alphaMode: this.alphaMode,
      alphaCutoff: this.alphaCutoff,
      doubleSided: this.doubleSided,
    };
  }

  clone(): PbrMaterial {
    const clone = new PbrMaterial({ ...this._baseState, variants: [...this._variants].map(([name, state]) => ({ name, state })) });
    if (this._activeVariant) clone.setVariant(this._activeVariant);
    return clone;
  }

  override getShaderContract(): MaterialShaderContract { return PBR_SHADER_CONTRACT; }

  private _captureResolvedState(): ResolvedPbrMaterialState {
    return {
      baseColor: this._baseColor.clone(),
      metallic: this._metallic,
      roughness: this._roughness,
      baseColorTexture: this._baseColorTexture,
      metallicRoughnessTexture: this._metallicRoughnessTexture,
      normalTexture: this._normalTexture,
      normalScale: this._normalScale,
      occlusionTexture: this._occlusionTexture,
      occlusionStrength: this._occlusionStrength,
      emissiveTexture: this._emissiveTexture,
      emissiveFactor: this._emissiveFactor,
      clearcoatFactor: this._clearcoatFactor,
      clearcoatTexture: this._clearcoatTexture,
      clearcoatRoughnessFactor: this._clearcoatRoughnessFactor,
      clearcoatRoughnessTexture: this._clearcoatRoughnessTexture,
      clearcoatNormalTexture: this._clearcoatNormalTexture,
      clearcoatNormalScale: this._clearcoatNormalScale,
      ior: this._ior,
      specularFactor: this._specularFactor,
      specularColorFactor: this._specularColorFactor,
      specularTexture: this._specularTexture,
      specularColorTexture: this._specularColorTexture,
      sheenColorFactor: this._sheenColorFactor,
      sheenRoughnessFactor: this._sheenRoughnessFactor,
      sheenColorTexture: this._sheenColorTexture,
      sheenRoughnessTexture: this._sheenRoughnessTexture,
      transmissionFactor: this._transmissionFactor,
      transmissionTexture: this._transmissionTexture,
      thicknessFactor: this._thicknessFactor,
      thicknessTexture: this._thicknessTexture,
      attenuationDistance: this._attenuationDistance,
      attenuationColor: this._attenuationColor,
      textureMappings: this._textureMappings,
      samplers: this._samplers,
      alphaMode: this._alphaMode,
      alphaCutoff: this._alphaCutoff,
      doubleSided: this._doubleSided,
    };
  }

  private _applyResolvedState(state: ResolvedPbrMaterialState): boolean {
    let changed = false;
    if (!sameMaterialColor(this._baseColor, state.baseColor)) {
      this._baseColor = state.baseColor.clone();
      changed = true;
    }
    if (this._metallic !== state.metallic) { this._metallic = state.metallic; changed = true; }
    if (this._roughness !== state.roughness) { this._roughness = state.roughness; changed = true; }
    if (this._baseColorTexture !== state.baseColorTexture) { this._baseColorTexture = state.baseColorTexture; changed = true; }
    if (this._metallicRoughnessTexture !== state.metallicRoughnessTexture) {
      this._metallicRoughnessTexture = state.metallicRoughnessTexture;
      changed = true;
    }
    if (this._normalTexture !== state.normalTexture) { this._normalTexture = state.normalTexture; changed = true; }
    if (this._normalScale !== state.normalScale) { this._normalScale = state.normalScale; changed = true; }
    if (this._occlusionTexture !== state.occlusionTexture) { this._occlusionTexture = state.occlusionTexture; changed = true; }
    if (this._occlusionStrength !== state.occlusionStrength) { this._occlusionStrength = state.occlusionStrength; changed = true; }
    if (this._emissiveTexture !== state.emissiveTexture) { this._emissiveTexture = state.emissiveTexture; changed = true; }
    if (!sameVec3(this._emissiveFactor, state.emissiveFactor)) { this._emissiveFactor = state.emissiveFactor; changed = true; }
    if (this._clearcoatFactor !== state.clearcoatFactor) { this._clearcoatFactor = state.clearcoatFactor; changed = true; }
    if (this._clearcoatTexture !== state.clearcoatTexture) { this._clearcoatTexture = state.clearcoatTexture; changed = true; }
    if (this._clearcoatRoughnessFactor !== state.clearcoatRoughnessFactor) {
      this._clearcoatRoughnessFactor = state.clearcoatRoughnessFactor;
      changed = true;
    }
    if (this._clearcoatRoughnessTexture !== state.clearcoatRoughnessTexture) {
      this._clearcoatRoughnessTexture = state.clearcoatRoughnessTexture;
      changed = true;
    }
    if (this._clearcoatNormalTexture !== state.clearcoatNormalTexture) {
      this._clearcoatNormalTexture = state.clearcoatNormalTexture;
      changed = true;
    }
    if (this._clearcoatNormalScale !== state.clearcoatNormalScale) {
      this._clearcoatNormalScale = state.clearcoatNormalScale;
      changed = true;
    }
    if (this._ior !== state.ior) { this._ior = state.ior; changed = true; }
    if (this._specularFactor !== state.specularFactor) { this._specularFactor = state.specularFactor; changed = true; }
    if (!sameVec3(this._specularColorFactor, state.specularColorFactor)) {
      this._specularColorFactor = state.specularColorFactor;
      changed = true;
    }
    if (this._specularTexture !== state.specularTexture) { this._specularTexture = state.specularTexture; changed = true; }
    if (this._specularColorTexture !== state.specularColorTexture) {
      this._specularColorTexture = state.specularColorTexture;
      changed = true;
    }
    if (!sameVec3(this._sheenColorFactor, state.sheenColorFactor)) {
      this._sheenColorFactor = state.sheenColorFactor;
      changed = true;
    }
    if (this._sheenRoughnessFactor !== state.sheenRoughnessFactor) {
      this._sheenRoughnessFactor = state.sheenRoughnessFactor;
      changed = true;
    }
    if (this._sheenColorTexture !== state.sheenColorTexture) { this._sheenColorTexture = state.sheenColorTexture; changed = true; }
    if (this._sheenRoughnessTexture !== state.sheenRoughnessTexture) {
      this._sheenRoughnessTexture = state.sheenRoughnessTexture;
      changed = true;
    }
    if (this._transmissionFactor !== state.transmissionFactor) { this._transmissionFactor = state.transmissionFactor; changed = true; }
    if (this._transmissionTexture !== state.transmissionTexture) {
      this._transmissionTexture = state.transmissionTexture;
      changed = true;
    }
    if (this._thicknessFactor !== state.thicknessFactor) { this._thicknessFactor = state.thicknessFactor; changed = true; }
    if (this._thicknessTexture !== state.thicknessTexture) { this._thicknessTexture = state.thicknessTexture; changed = true; }
    if (this._attenuationDistance !== state.attenuationDistance) {
      this._attenuationDistance = state.attenuationDistance;
      changed = true;
    }
    if (!sameVec3(this._attenuationColor, state.attenuationColor)) {
      this._attenuationColor = state.attenuationColor;
      changed = true;
    }
    if (!sameTextureMappings(this._textureMappings, state.textureMappings)) {
      this._textureMappings = state.textureMappings;
      changed = true;
    }
    if (!sameTextureSamplers(this._samplers, state.samplers)) {
      this._samplers = state.samplers;
      changed = true;
    }
    if (this._alphaMode !== state.alphaMode) { this._alphaMode = state.alphaMode; changed = true; }
    if (this._alphaCutoff !== state.alphaCutoff) { this._alphaCutoff = state.alphaCutoff; changed = true; }
    if (this._doubleSided !== state.doubleSided) { this._doubleSided = state.doubleSided; changed = true; }
    return changed;
  }
}

function resolveTextureMappings(mappings: PbrTextureMappings | undefined): Readonly<Record<PbrTextureSlot, PbrTextureMapping>> {
  const resolved = {} as Record<PbrTextureSlot, PbrTextureMapping>;
  for (const slot of PBR_TEXTURE_SLOTS) resolved[slot] = resolveTextureMapping(mappings?.[slot]);
  return Object.freeze(resolved);
}

function unitVec3(
  value: readonly [number, number, number],
  property: string,
): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RangeError(`${property} must contain exactly 3 numbers.`);
  }
  return Object.freeze([
    clampedNumber(value[0], 0, 1, `${property}[0]`),
    clampedNumber(value[1], 0, 1, `${property}[1]`),
    clampedNumber(value[2], 0, 1, `${property}[2]`),
  ]);
}

function positiveDistance(value: number, property: string): number {
  if (value === Infinity) return value;
  const next = finiteNumber(value, property);
  if (next <= 0) throw new RangeError(`${property} must be greater than 0 or Infinity.`);
  return next;
}

function resolveTextureSamplers(samplers: PbrTextureSamplers | undefined): PbrTextureSamplers {
  const resolved: Partial<Record<PbrTextureSlot, GPUSamplerDescriptor | null>> = {};
  for (const slot of PBR_TEXTURE_SLOTS) {
    const sampler = samplers?.[slot];
    if (sampler !== undefined) resolved[slot] = samplerDescriptor(sampler, `PbrMaterial.samplers.${slot}`);
  }
  return Object.freeze(resolved);
}

function resolveTextureMapping(mapping: PbrTextureMappingOptions = {}): PbrTextureMapping {
  const texCoord = mapping.texCoord ?? 0;
  if (texCoord !== 0 && texCoord !== 1) {
    throw new RangeError(`PBR texture mapping texCoord must be 0 or 1; received ${texCoord}.`);
  }
  const offset = mapping.offset ?? [0, 0];
  const scale = mapping.scale ?? [1, 1];
  return Object.freeze({
    texCoord,
    offset: Object.freeze([
      finiteNumber(offset[0], 'PbrMaterial.textureMapping.offset[0]'),
      finiteNumber(offset[1], 'PbrMaterial.textureMapping.offset[1]'),
    ] as [number, number]),
    rotation: finiteNumber(mapping.rotation ?? 0, 'PbrMaterial.textureMapping.rotation'),
    scale: Object.freeze([
      finiteNumber(scale[0], 'PbrMaterial.textureMapping.scale[0]'),
      finiteNumber(scale[1], 'PbrMaterial.textureMapping.scale[1]'),
    ] as [number, number]),
  });
}

function sameTextureMapping(a: PbrTextureMapping, b: PbrTextureMapping): boolean {
  return a.texCoord === b.texCoord
    && a.offset[0] === b.offset[0]
    && a.offset[1] === b.offset[1]
    && a.rotation === b.rotation
    && a.scale[0] === b.scale[0]
    && a.scale[1] === b.scale[1];
}

function sameTextureMappings(
  a: Readonly<Record<PbrTextureSlot, PbrTextureMapping>>,
  b: Readonly<Record<PbrTextureSlot, PbrTextureMapping>>,
): boolean {
  if (a === b) return true;
  for (const slot of PBR_TEXTURE_SLOTS) {
    if (!sameTextureMapping(a[slot], b[slot])) return false;
  }
  return true;
}

function sameTextureSamplers(a: PbrTextureSamplers, b: PbrTextureSamplers): boolean {
  if (a === b) return true;
  for (const slot of PBR_TEXTURE_SLOTS) {
    const aHas = Object.prototype.hasOwnProperty.call(a, slot);
    const bHas = Object.prototype.hasOwnProperty.call(b, slot);
    if (aHas !== bHas || (aHas && !sameSamplerDescriptor(a[slot] ?? null, b[slot] ?? null))) return false;
  }
  return true;
}

function validateTextureSlot(slot: PbrTextureSlot): void {
  if (!PBR_TEXTURE_SLOTS.includes(slot)) {
    throw new RangeError(`PBR texture slot must be one of ${PBR_TEXTURE_SLOTS.join(', ')}; received ${String(slot)}.`);
  }
}
