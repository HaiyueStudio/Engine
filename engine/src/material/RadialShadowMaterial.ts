import { Material } from './Material';
import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { clampedNumber, materialColor, sameMaterialColor } from './materialValidation';

export interface RadialShadowMaterialOptions {
  color?: ColorLike;
  opacity?: number;
  innerRadius?: number;
}

export class RadialShadowMaterial extends Material {
  readonly type = 'radial-shadow';

  private _color: ColorValue;
  private _opacity: number;
  private _innerRadius: number;
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) {
    const next = materialColor(value, 'RadialShadowMaterial.color');
    if (sameMaterialColor(this._color, next)) return;
    this._color = next;
    this._stateChanged();
  }
  get opacity(): number { return this._opacity; }
  set opacity(value: number) {
    const next = clampedNumber(value, 0, 1, 'RadialShadowMaterial.opacity');
    if (this._opacity === next) return;
    this._opacity = next;
    this._stateChanged();
  }
  get innerRadius(): number { return this._innerRadius; }
  set innerRadius(value: number) {
    const next = clampedNumber(value, 0, 1, 'RadialShadowMaterial.innerRadius');
    if (this._innerRadius === next) return;
    this._innerRadius = next;
    this._stateChanged();
  }

  constructor(options: RadialShadowMaterialOptions = {}) {
    super();
    this._color = materialColor(options.color ?? [0, 0, 0, 1], 'RadialShadowMaterial.color');
    this._opacity = clampedNumber(options.opacity ?? 0.28, 0, 1, 'RadialShadowMaterial.opacity');
    this._innerRadius = clampedNumber(options.innerRadius ?? 0.18, 0, 1, 'RadialShadowMaterial.innerRadius');
  }
}
