import { Material } from './Material';
import { booleanValue, positiveNumber } from './materialValidation';

export interface DepthMaterialOptions {
  near?: number;
  far?: number;
  isOrthographic?: boolean;
}

export class DepthMaterial extends Material {
  readonly type = 'depth';

  private _near: number;
  private _far: number;
  private _isOrthographic: boolean;

  get near(): number { return this._near; }
  set near(value: number) {
    const next = positiveNumber(value, 'DepthMaterial.near');
    if (next >= this._far) throw new RangeError(`DepthMaterial.near must be less than far (${this._far}); received ${value}.`);
    if (this._near === next) return;
    this._near = next;
    this._stateChanged();
  }
  get far(): number { return this._far; }
  set far(value: number) {
    const next = positiveNumber(value, 'DepthMaterial.far');
    if (next <= this._near) throw new RangeError(`DepthMaterial.far must be greater than near (${this._near}); received ${value}.`);
    if (this._far === next) return;
    this._far = next;
    this._stateChanged();
  }
  get isOrthographic(): boolean { return this._isOrthographic; }
  set isOrthographic(value: boolean) {
    const next = booleanValue(value, 'DepthMaterial.isOrthographic');
    if (this._isOrthographic === next) return;
    this._isOrthographic = next;
    this._stateChanged();
  }

  constructor(options: DepthMaterialOptions = {}) {
    super();
    this._near = positiveNumber(options.near ?? 0.1, 'DepthMaterial.near');
    this._far = positiveNumber(options.far ?? 100, 'DepthMaterial.far');
    if (this._far <= this._near) throw new RangeError(`DepthMaterial.far must be greater than near (${this._near}); received ${this._far}.`);
    this._isOrthographic = booleanValue(options.isOrthographic ?? false, 'DepthMaterial.isOrthographic');
  }
}
