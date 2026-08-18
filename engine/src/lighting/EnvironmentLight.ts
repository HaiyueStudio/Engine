import type { ColorValue } from '../color/Color';
import { resolveColor, type ColorLike } from '../color/ColorLike';
import { Component, UniqueCheckType } from '../ecs/Component';

export interface EnvironmentCubeTexture {
  readonly texture: GPUTexture;
  readonly mipLevelCount?: number;
  readonly version?: number;
}

export interface EnvironmentLightOptions {
  diffuseTexture?: EnvironmentCubeTexture | GPUTexture | null;
  specularTexture?: EnvironmentCubeTexture | GPUTexture | null;
  intensity?: number;
  rotation?: number;
  diffuseColor?: ColorLike;
  specularColor?: ColorLike;
}

export class EnvironmentLight extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('EnvironmentLight');
  static editor = {
    fields: {
      intensity: { type: 'number', label: 'Intensity', group: 'Environment', min: 0, step: 0.01 },
      rotation: { type: 'number', label: 'Rotation', group: 'Environment', unit: 'rad', step: 0.01 },
      diffuseColor: { type: 'color', label: 'Diffuse', group: 'Environment' },
      specularColor: { type: 'color', label: 'Specular', group: 'Environment' },
    },
  };

  diffuseTexture: EnvironmentCubeTexture | GPUTexture | null;
  specularTexture: EnvironmentCubeTexture | GPUTexture | null;
  intensity: number;
  rotation: number;
  private _diffuseColor: ColorValue;
  private _specularColor: ColorValue;
  get diffuseColor(): ColorValue { return this._diffuseColor; }
  set diffuseColor(value: ColorLike) { this._diffuseColor = resolveColor(value); }
  get specularColor(): ColorValue { return this._specularColor; }
  set specularColor(value: ColorLike) { this._specularColor = resolveColor(value); }

  constructor(options: EnvironmentLightOptions = {}) {
    super('EnvironmentLight');
    this.diffuseTexture = options.diffuseTexture ?? null;
    this.specularTexture = options.specularTexture ?? null;
    this.intensity = Math.max(0, options.intensity ?? 1);
    this.rotation = options.rotation ?? 0;
    // Keep the implicit analytic fallback achromatic. Applications that want a
    // cool or warm environment must opt into that artistic tint explicitly.
    this._diffuseColor = resolveColor(options.diffuseColor, [0.39, 0.39, 0.39]);
    this._specularColor = resolveColor(options.specularColor, [0.88, 0.88, 0.88]);
  }
}
