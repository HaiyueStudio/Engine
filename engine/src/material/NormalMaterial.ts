import { Material } from './Material';
import { enumValue } from './materialValidation';

export interface NormalMaterialOptions {
  /** Render normals in view space (default), world space, or local object space. */
  space?: 'view' | 'world' | 'local';
}

export class NormalMaterial extends Material {
  readonly type = 'normal';

  private _space: 'view' | 'world' | 'local';
  get space(): 'view' | 'world' | 'local' { return this._space; }
  set space(value: 'view' | 'world' | 'local') {
    const next = enumValue(value, ['view', 'world', 'local'], 'NormalMaterial.space');
    if (this._space === next) return;
    this._space = next;
    this._stateChanged();
  }

  constructor(options: NormalMaterialOptions = {}) {
    super();
    this._space = enumValue(options.space ?? 'view', ['view', 'world', 'local'], 'NormalMaterial.space');
  }
}
