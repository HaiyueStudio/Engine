import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { Material } from './Material';
import {
  enumValue,
  integerInRange,
  materialColor,
  nonNegativeNumber,
  sameMaterialColor,
  sameSamplerDescriptor,
  samplerDescriptor,
} from './materialValidation';

export type VolumeBlendMode = 'normal' | 'additive';

export interface VolumeMaterialOptions {
  texture?: GPUTexture | null;
  color?: ColorLike;
  densityScale?: number;
  opacityScale?: number;
  steps?: number;
  blending?: VolumeBlendMode;
  sampler?: GPUSamplerDescriptor | null;
}

export class VolumeMaterial extends Material {
  readonly type = 'volume';

  private _texture: GPUTexture | null;
  private _color: ColorValue;
  private _densityScale: number;
  private _opacityScale: number;
  private _steps: number;
  private _blending: VolumeBlendMode;
  private _sampler: GPUSamplerDescriptor | null;
  get texture(): GPUTexture | null { return this._texture; }
  set texture(value: GPUTexture | null) {
    if (this._texture === value) return;
    this._texture = value;
    this._stateChanged();
  }
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) {
    const next = materialColor(value, 'VolumeMaterial.color');
    if (sameMaterialColor(this._color, next)) return;
    this._color = next;
    this._stateChanged();
  }
  get densityScale(): number { return this._densityScale; }
  set densityScale(value: number) {
    const next = nonNegativeNumber(value, 'VolumeMaterial.densityScale');
    if (this._densityScale === next) return;
    this._densityScale = next;
    this._stateChanged();
  }
  get opacityScale(): number { return this._opacityScale; }
  set opacityScale(value: number) {
    const next = nonNegativeNumber(value, 'VolumeMaterial.opacityScale');
    if (this._opacityScale === next) return;
    this._opacityScale = next;
    this._stateChanged();
  }
  get steps(): number { return this._steps; }
  set steps(value: number) {
    const next = integerInRange(value, 1, 2048, 'VolumeMaterial.steps');
    if (this._steps === next) return;
    this._steps = next;
    this._stateChanged();
  }
  get blending(): VolumeBlendMode { return this._blending; }
  set blending(value: VolumeBlendMode) {
    const next = enumValue(value, ['normal', 'additive'], 'VolumeMaterial.blending');
    if (this._blending === next) return;
    this._blending = next;
    this._stateChanged();
  }
  get sampler(): GPUSamplerDescriptor | null { return this._sampler; }
  set sampler(value: GPUSamplerDescriptor | null) {
    const next = samplerDescriptor(value, 'VolumeMaterial.sampler');
    if (sameSamplerDescriptor(this._sampler, next)) return;
    this._sampler = next;
    this._stateChanged();
  }

  constructor(options: VolumeMaterialOptions = {}) {
    super();
    this._texture = options.texture ?? null;
    this._color = materialColor(options.color ?? [1, 1, 1, 1], 'VolumeMaterial.color');
    this._densityScale = nonNegativeNumber(options.densityScale ?? 1, 'VolumeMaterial.densityScale');
    this._opacityScale = nonNegativeNumber(options.opacityScale ?? 1, 'VolumeMaterial.opacityScale');
    this._steps = integerInRange(options.steps ?? 96, 1, 2048, 'VolumeMaterial.steps');
    this._blending = enumValue(options.blending ?? 'normal', ['normal', 'additive'], 'VolumeMaterial.blending');
    this._sampler = samplerDescriptor(options.sampler ?? null, 'VolumeMaterial.sampler');
  }
}
