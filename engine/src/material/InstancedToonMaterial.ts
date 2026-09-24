import { InstancedMaterial } from './InstancedMaterial';
import { clampedNumber, integerInRange } from './materialValidation';
/** Experimental opaque, shadow-free toon material, compatible with both CPU
 * and external GPU instance data. Lighting uses the shared scene light block. */
export class InstancedToonMaterial extends InstancedMaterial {
  override readonly type = 'instanced-toon';
  private _bands = 3;
  private _ambient = .35;
  get bands(): number { return this._bands; }
  set bands(value: number) { const n = integerInRange(value, 2, 8, 'InstancedToonMaterial.bands'); if (n !== this._bands) { this._bands = n; this._stateChanged(); } }
  get ambient(): number { return this._ambient; }
  set ambient(value: number) { const n = clampedNumber(value, 0, 1, 'InstancedToonMaterial.ambient'); if (n !== this._ambient) { this._ambient = n; this._stateChanged(); } }
  override getShaderContract() {
    return { id: 'haiyue.material.instanced-toon', version: 1, shadingModel: 'toon' as const, vertexSemantics: ['POSITION', 'NORMAL'] as const, features: ['instancing', 'opaque', 'no-shadows'] as const };
  }
}
