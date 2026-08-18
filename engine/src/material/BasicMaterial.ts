import { Material } from './Material';
import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import type { CompressedTextureSourceDescriptor } from '../assets/AssetManager';
import { DEFORMATION_SHADER_ARTIFACT } from '../shaders/generated/deformation-artifact.generated';
import {
  booleanValue,
  enumValue,
  finiteVec3,
  materialColor,
  sameMaterialColor,
  sameSamplerDescriptor,
  sameVec3,
  samplerDescriptor,
} from './materialValidation';

export type BlendMode = 'none' | 'normal' | 'additive';
export interface SampleableTextureSource {
  readonly texture: GPUTexture;
  readonly version?: number;
}
export type MaterialTextureSource = string | ImageBitmap | HTMLCanvasElement | HTMLImageElement | GPUTexture | SampleableTextureSource | CompressedTextureSourceDescriptor | null;

export interface BasicMaterialOptions {
  color?: ColorLike;
  texture?: MaterialTextureSource;
  emissiveFactor?: readonly [number, number, number];
  emissiveTexture?: MaterialTextureSource;
  blending?: BlendMode;
  /**
   * Whether this material writes to the depth buffer.
   * Defaults to true for opaque/normal alpha materials and false for additive materials.
   */
  depthWrite?: boolean;
  /**
   * Optional material-level culling override. When omitted/null, geometry.cullMode is used.
   */
  cullMode?: GPUCullMode | null;
  /**
   * Optional material-level winding override. When omitted/null, geometry.frontFace is used.
   */
  frontFace?: GPUFrontFace | null;
  /**
   * Optional texture sampler override.
   */
  sampler?: GPUSamplerDescriptor | null;
}

export const BASIC_MATERIAL_SHADER = Object.freeze({
  code: DEFORMATION_SHADER_ARTIFACT.passes.forward.code,
  featureKey: DEFORMATION_SHADER_ARTIFACT.passes.forward.canonicalHash,
});
export const BASIC_MATERIAL_SKINNED_SHADER = Object.freeze({
  code: DEFORMATION_SHADER_ARTIFACT.passes['forward-skinned'].code,
  featureKey: DEFORMATION_SHADER_ARTIFACT.passes['forward-skinned'].canonicalHash,
});
export const BASIC_MATERIAL_WGSL = BASIC_MATERIAL_SHADER.code;
export const BASIC_MATERIAL_SKINNED_WGSL = BASIC_MATERIAL_SKINNED_SHADER.code;

export class BasicMaterial extends Material {
  readonly type = 'basic';

  private _color: ColorValue;
  private _texture: MaterialTextureSource;
  private _emissiveFactor: readonly [number, number, number];
  private _emissiveTexture: MaterialTextureSource;
  private _blending: BlendMode;
  private _depthWrite: boolean;
  private _cullMode: GPUCullMode | null;
  private _frontFace: GPUFrontFace | null;
  private _sampler: GPUSamplerDescriptor | null;

  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) {
    const next = materialColor(value, 'BasicMaterial.color');
    if (sameMaterialColor(this._color, next)) return;
    this._color = next;
    this._stateChanged();
  }
  get texture(): MaterialTextureSource { return this._texture; }
  set texture(value: MaterialTextureSource) {
    if (this._texture === value) return;
    this._texture = value;
    this._stateChanged();
  }
  get emissiveFactor(): readonly [number, number, number] { return this._emissiveFactor; }
  set emissiveFactor(value: readonly [number, number, number]) {
    const next = finiteVec3(value, 'BasicMaterial.emissiveFactor');
    if (sameVec3(this._emissiveFactor, next)) return;
    this._emissiveFactor = next;
    this._stateChanged();
  }
  get emissiveTexture(): MaterialTextureSource { return this._emissiveTexture; }
  set emissiveTexture(value: MaterialTextureSource) {
    if (this._emissiveTexture === value) return;
    this._emissiveTexture = value;
    this._stateChanged();
  }
  get blending(): BlendMode { return this._blending; }
  set blending(value: BlendMode) {
    const next = enumValue(value, ['none', 'normal', 'additive'], 'BasicMaterial.blending');
    if (this._blending === next) return;
    this._blending = next;
    this._stateChanged();
  }
  get depthWrite(): boolean { return this._depthWrite; }
  set depthWrite(value: boolean) {
    const next = booleanValue(value, 'BasicMaterial.depthWrite');
    if (this._depthWrite === next) return;
    this._depthWrite = next;
    this._stateChanged();
  }
  get cullMode(): GPUCullMode | null { return this._cullMode; }
  set cullMode(value: GPUCullMode | null) {
    const next = value === null ? null : enumValue(value, ['none', 'front', 'back'], 'BasicMaterial.cullMode');
    if (this._cullMode === next) return;
    this._cullMode = next;
    this._stateChanged();
  }
  get frontFace(): GPUFrontFace | null { return this._frontFace; }
  set frontFace(value: GPUFrontFace | null) {
    const next = value === null ? null : enumValue(value, ['ccw', 'cw'], 'BasicMaterial.frontFace');
    if (this._frontFace === next) return;
    this._frontFace = next;
    this._stateChanged();
  }
  get sampler(): GPUSamplerDescriptor | null { return this._sampler; }
  set sampler(value: GPUSamplerDescriptor | null) {
    const next = samplerDescriptor(value, 'BasicMaterial.sampler');
    if (sameSamplerDescriptor(this._sampler, next)) return;
    this._sampler = next;
    this._stateChanged();
  }

  constructor(options: BasicMaterialOptions = {}) {
    super();
    this._color = materialColor(options.color ?? [1, 1, 1, 1], 'BasicMaterial.color');
    this._texture = options.texture ?? null;
    this._emissiveFactor = finiteVec3(options.emissiveFactor ?? [1, 1, 1], 'BasicMaterial.emissiveFactor');
    this._emissiveTexture = options.emissiveTexture ?? null;
    this._blending = enumValue(options.blending ?? 'none', ['none', 'normal', 'additive'], 'BasicMaterial.blending');
    this._depthWrite = booleanValue(options.depthWrite ?? this._blending !== 'additive', 'BasicMaterial.depthWrite');
    this._cullMode = options.cullMode == null
      ? null
      : enumValue<GPUCullMode>(options.cullMode, ['none', 'front', 'back'], 'BasicMaterial.cullMode');
    this._frontFace = options.frontFace == null
      ? null
      : enumValue<GPUFrontFace>(options.frontFace, ['ccw', 'cw'], 'BasicMaterial.frontFace');
    this._sampler = samplerDescriptor(options.sampler ?? null, 'BasicMaterial.sampler');
  }
}
