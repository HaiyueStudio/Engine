import type { ColorValue } from '../color/Color';
import type { ColorLike } from '../color/ColorLike';
import { Material } from './Material';
import { booleanValue, enumValue, materialColor, positiveNumber, sameMaterialColor } from './materialValidation';

export interface LineMaterialOptions {
  color?: ColorLike;
  width?: number;
  screenSpace?: boolean;
  cap?: 'butt' | 'round';
}

export class LineMaterial extends Material {
  readonly type = 'line';

  private _color: ColorValue;
  private _width: number;
  private _screenSpace: boolean;
  private _cap: 'butt' | 'round';
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) {
    const next = materialColor(value, 'LineMaterial.color');
    if (sameMaterialColor(this._color, next)) return;
    this._color = next;
    this._stateChanged();
  }
  /** Width in pixels (screen-space) or world units (world-space) */
  get width(): number { return this._width; }
  set width(value: number) {
    const next = positiveNumber(value, 'LineMaterial.width');
    if (this._width === next) return;
    this._width = next;
    this._stateChanged();
  }
  /** true = constant pixel width regardless of depth; false = perspective-affected */
  get screenSpace(): boolean { return this._screenSpace; }
  set screenSpace(value: boolean) {
    const next = booleanValue(value, 'LineMaterial.screenSpace');
    if (this._screenSpace === next) return;
    this._screenSpace = next;
    this._stateChanged();
  }
  /** 'butt' = flat square caps, 'round' = semicircle caps */
  get cap(): 'butt' | 'round' { return this._cap; }
  set cap(value: 'butt' | 'round') {
    const next = enumValue(value, ['butt', 'round'], 'LineMaterial.cap');
    if (this._cap === next) return;
    this._cap = next;
    this._stateChanged();
  }

  constructor(options: LineMaterialOptions = {}) {
    super();
    this._color = materialColor(options.color ?? [1, 1, 1, 1], 'LineMaterial.color');
    this._width = positiveNumber(options.width ?? 4, 'LineMaterial.width');
    this._screenSpace = booleanValue(options.screenSpace ?? true, 'LineMaterial.screenSpace');
    this._cap = enumValue(options.cap ?? 'round', ['butt', 'round'], 'LineMaterial.cap');
  }
}
