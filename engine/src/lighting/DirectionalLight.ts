import { UniqueCheckType } from '../ecs/Component';
import { LightComponent } from './LightComponent';
import type { ColorLike } from '../color/ColorLike';

export interface DirectionalLightOptions {
  color?:     ColorLike;
  intensity?: number;
  /** World-space direction the light travels in (need not be normalised). */
  direction?: [number, number, number];
  castShadow?: boolean;
  shadow?: Partial<DirectionalShadowOptions>;
}

export interface DirectionalShadowOptions {
  mapSize: 512 | 1024 | 2048;
  extent: number;
  near: number;
  far: number;
  bias: number;
  normalBias: number;
}

export class DirectionalLight extends LightComponent {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('LightComponent');
  static override editor = {
    fields: {
      lightType: LightComponent.editor.fields.lightType,
      color: { type: 'color', label: 'Color', group: 'Light' },
      intensity: { type: 'number', label: 'Intensity', group: 'Light', min: 0, step: 0.01 },
      direction: {
        type: 'vector',
        label: 'Direction',
        group: 'Directional',
        size: 3,
        get: (component: DirectionalLight) => component.direction,
        set: (component: DirectionalLight, value: unknown) => {
          const vector = Array.isArray(value) ? value : [0, -1, 0];
          component.setDirection(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
      castShadow: { type: 'boolean', label: 'Cast Shadow', group: 'Shadow' },
      shadowMapSize: {
        type: 'select', label: 'Map Size', group: 'Shadow', options: [512, 1024, 2048],
        get: (component: DirectionalLight) => component.shadow.mapSize,
        set: (component: DirectionalLight, value: unknown) => {
          const size = Number(value);
          component.shadow.mapSize = size === 512 || size === 2048 ? size : 1024;
          component.markDirty();
        },
      },
      shadowExtent: {
        type: 'number', label: 'Extent', group: 'Shadow', min: 1, step: 0.5,
        get: (component: DirectionalLight) => component.shadow.extent,
        set: (component: DirectionalLight, value: unknown) => { component.shadow.extent = Math.max(1, Number(value) || 1); component.markDirty(); },
      },
      shadowBias: {
        type: 'number', label: 'Bias', group: 'Shadow', min: 0, step: 0.0001,
        get: (component: DirectionalLight) => component.shadow.bias,
        set: (component: DirectionalLight, value: unknown) => { component.shadow.bias = Math.max(0, Number(value) || 0); component.markDirty(); },
      },
    },
  };

  readonly lightType = 'directional' as const;

  /** Direction the light travels (normalised in the shader). */
  private _direction: [number, number, number];
  castShadow: boolean;
  shadow: DirectionalShadowOptions;

  constructor(options: DirectionalLightOptions = {}) {
    super(options.color, options.intensity ?? 1);
    this._direction = options.direction ?? [0, -1, 0];
    this.castShadow = options.castShadow ?? true;
    this.shadow = {
      mapSize: options.shadow?.mapSize ?? 1024,
      extent: Math.max(1, options.shadow?.extent ?? 20),
      near: Math.max(0.01, options.shadow?.near ?? 0.1),
      far: Math.max(1, options.shadow?.far ?? 60),
      bias: Math.max(0, options.shadow?.bias ?? 0.0015),
      normalBias: Math.max(0, options.shadow?.normalBias ?? 0.02),
    };
    this.name = 'DirectionalLight';
  }

  get direction(): [number, number, number] {
    return this._direction;
  }

  set direction(value: [number, number, number]) {
    if (
      this._direction[0] === value[0] &&
      this._direction[1] === value[1] &&
      this._direction[2] === value[2]
    ) return;
    this._direction = value;
    this.markDirty();
  }

  setDirection(x: number, y: number, z: number): this {
    if (this._direction[0] === x && this._direction[1] === y && this._direction[2] === z) return this;
    this._direction[0] = x;
    this._direction[1] = y;
    this._direction[2] = z;
    return this.markDirty();
  }
}
