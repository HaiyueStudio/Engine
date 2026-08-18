import { UniqueCheckType } from '../ecs/Component';
import { LightComponent } from './LightComponent';
import type { ColorLike } from '../color/ColorLike';

export interface PointLightOptions {
  color?:     ColorLike;
  intensity?: number;
  /**
   * Radius of influence. Attenuation reaches zero at this distance.
   * Default: 10.
   */
  range?: number;
}

export class PointLight extends LightComponent {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('LightComponent');
  static override editor = {
    fields: {
      lightType: LightComponent.editor.fields.lightType,
      color: { type: 'color', label: 'Color', group: 'Light' },
      intensity: { type: 'number', label: 'Intensity', group: 'Light', min: 0, step: 0.01 },
      range: { type: 'number', label: 'Range', group: 'Point', min: 0, step: 0.1 },
    },
  };

  readonly lightType = 'point' as const;

  /** World-space position is read from the entity's Transform3D each frame. */
  private _range: number;

  constructor(options: PointLightOptions = {}) {
    super(options.color, options.intensity ?? 1);
    this._range = options.range ?? 10;
    this.name  = 'PointLight';
  }

  get range(): number {
    return this._range;
  }

  set range(value: number) {
    if (this._range === value) return;
    this._range = value;
    this.markDirty();
  }
}
