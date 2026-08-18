import { Material } from './Material';
import type { ColorValue } from '../color/Color';
import type { ColorLike, ColorTuple } from '../color/ColorLike';
import { enumValue, materialColor, nonNegativeNumber, sameMaterialColor } from './materialValidation';

export type BlendModeBlinnPhong = 'none' | 'normal';

export interface BlinnPhongMaterialOptions {
  ambient?:   ColorLike;
  diffuse?:   ColorLike;
  specular?:  ColorLike;
  shininess?: number;
  blending?:  BlendModeBlinnPhong;
}

export class BlinnPhongMaterial extends Material {
  readonly type = 'blinnphong';

  private _ambient: ColorValue;
  private _diffuse: ColorValue;
  private _specular: ColorValue;
  private _shininess: number;
  private _blending: BlendModeBlinnPhong;
  get ambient(): ColorValue { return this._ambient; }
  set ambient(value: ColorLike) {
    const next = materialColor(value, 'BlinnPhongMaterial.ambient');
    if (sameMaterialColor(this._ambient, next)) return;
    this._ambient = next;
    this._stateChanged();
  }
  get diffuse(): ColorValue { return this._diffuse; }
  set diffuse(value: ColorLike) {
    const next = materialColor(value, 'BlinnPhongMaterial.diffuse');
    if (sameMaterialColor(this._diffuse, next)) return;
    this._diffuse = next;
    this._stateChanged();
  }
  get specular(): ColorValue { return this._specular; }
  set specular(value: ColorLike) {
    const next = materialColor(value, 'BlinnPhongMaterial.specular');
    if (sameMaterialColor(this._specular, next)) return;
    this._specular = next;
    this._stateChanged();
  }
  get shininess(): number { return this._shininess; }
  set shininess(value: number) {
    const next = nonNegativeNumber(value, 'BlinnPhongMaterial.shininess');
    if (this._shininess === next) return;
    this._shininess = next;
    this._stateChanged();
  }
  get blending(): BlendModeBlinnPhong { return this._blending; }
  set blending(value: BlendModeBlinnPhong) {
    const next = enumValue(value, ['none', 'normal'], 'BlinnPhongMaterial.blending');
    if (this._blending === next) return;
    this._blending = next;
    this._stateChanged();
  }

  constructor(options: BlinnPhongMaterialOptions = {}) {
    super();
    this._ambient = materialColor(options.ambient ?? ([0.1, 0.1, 0.1, 1] satisfies ColorTuple), 'BlinnPhongMaterial.ambient');
    this._diffuse = materialColor(options.diffuse ?? ([0.8, 0.8, 0.8, 1] satisfies ColorTuple), 'BlinnPhongMaterial.diffuse');
    this._specular = materialColor(options.specular ?? ([1, 1, 1, 1] satisfies ColorTuple), 'BlinnPhongMaterial.specular');
    this._shininess = nonNegativeNumber(options.shininess ?? 32, 'BlinnPhongMaterial.shininess');
    this._blending = enumValue(options.blending ?? 'none', ['none', 'normal'], 'BlinnPhongMaterial.blending');
  }

  clone(): BlinnPhongMaterial {
    return new BlinnPhongMaterial({
      ambient:   this.ambient.clone(),
      diffuse:   this.diffuse.clone(),
      specular:  this.specular.clone(),
      shininess: this.shininess,
      blending:  this.blending,
    });
  }
}
