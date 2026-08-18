import { Component, UniqueCheckType } from '../ecs/Component';
import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';

export type HelperMode = 'aabb' | 'obb' | 'wireframe';

export interface MeshHelperOptions {
  mode?:  HelperMode;
  color?: ColorLike;
  lineWidth?: number;
}

export class MeshHelper extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('MeshHelper');

  mode:  HelperMode;
  private _color: ColorValue;
  get color(): ColorValue { return this._color; }
  set color(value: ColorLike) { this._color = resolveColor(value); }
  lineWidth: number;

  constructor(options: MeshHelperOptions = {}) {
    super('MeshHelper');
    this.mode = options.mode ?? 'aabb';
    this._color = resolveColor(options.color, [0, 1, 0, 1]);
    this.lineWidth = options.lineWidth ?? 1;
  }
}
