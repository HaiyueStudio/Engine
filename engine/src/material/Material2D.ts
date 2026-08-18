import { Material } from './Material';
import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { enumValue, materialColor, sameMaterialColor } from './materialValidation';

export type BlendMode2D = 'none' | 'normal' | 'additive';

export interface Material2DOptions {
  color?:    ColorLike;
  blending?: BlendMode2D;
}

export class Material2D extends Material {
  readonly type = 'basic2d';

  private _color: ColorValue;
  private _blending: BlendMode2D;
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) {
    const next = materialColor(value, 'Material2D.color');
    if (sameMaterialColor(this._color, next)) return;
    this._color = next;
    this._stateChanged();
  }
  get blending(): BlendMode2D { return this._blending; }
  set blending(value: BlendMode2D) {
    const next = enumValue(value, ['none', 'normal', 'additive'], 'Material2D.blending');
    if (this._blending === next) return;
    this._blending = next;
    this._stateChanged();
  }

  constructor(options: Material2DOptions = {}) {
    super();
    this._color = materialColor(options.color ?? [1, 1, 1, 1], 'Material2D.color');
    this._blending = enumValue(options.blending ?? 'none', ['none', 'normal', 'additive'], 'Material2D.blending');
  }
}
