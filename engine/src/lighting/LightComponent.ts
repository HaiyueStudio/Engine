import { Component, UniqueCheckType } from '../ecs/Component';
import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';

export type LightType = 'ambient' | 'directional' | 'point';

export abstract class LightComponent extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('LightComponent');
  static editor = {
    fields: {
      lightType: {
        type: 'select',
        label: 'Type',
        group: 'Light',
        options: [
          { label: 'Ambient', value: 'ambient' },
          { label: 'Directional', value: 'directional' },
          { label: 'Point', value: 'point' },
        ],
        get: (component: LightComponent) => component.lightType,
      },
      color: { type: 'color', label: 'Color', group: 'Light' },
      intensity: { type: 'number', label: 'Intensity', group: 'Light', min: 0, step: 0.01 },
    },
  };

  abstract readonly lightType: LightType;

  private _color: ColorValue;
  private _intensity: number;
  private _version = 0;

  constructor(color: ColorLike | undefined = undefined, intensity = 1) {
    super('LightComponent');
    this._color = resolveColor(color);
    this._intensity = intensity;
  }

  get color(): ColorValue {
    return this._color;
  }

  set color(value: ColorLike) {
    this._color = resolveColor(value);
    this.markDirty();
  }

  get intensity(): number {
    return this._intensity;
  }

  set intensity(value: number) {
    if (this._intensity === value) return;
    this._intensity = value;
    this.markDirty();
  }

  get version(): number {
    return this._version;
  }

  markDirty(): this {
    this._version++;
    return this;
  }
}
