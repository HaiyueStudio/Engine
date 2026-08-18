import type { MaterialShaderContract } from './Material';
import { InstancedMaterial } from './InstancedMaterial';
import { clampedNumber, enumValue } from './materialValidation';

export type InstancedPbrAlphaMode = 'opaque' | 'blend';

export interface InstancedPbrMaterialOptions {
  metallic?: number;
  roughness?: number;
  alphaMode?: InstancedPbrAlphaMode;
}

export const INSTANCED_PBR_SHADER_CONTRACT: MaterialShaderContract = Object.freeze({
  id: 'haiyue.material.instanced-metallic-roughness',
  version: 1,
  shadingModel: 'metallic-roughness',
  vertexSemantics: Object.freeze(['POSITION', 'NORMAL'] as const),
  features: Object.freeze(['instance-base-color', 'metallic-roughness', 'analytic-lights', 'environment-light']),
});

/** Metallic-roughness PBR material with one transform and base color per instance. */
export class InstancedPbrMaterial extends InstancedMaterial {
  override readonly type = 'instanced-pbr';
  private _metallic: number;
  private _roughness: number;
  private _alphaMode: InstancedPbrAlphaMode;

  constructor(instanceCount: number, options: InstancedPbrMaterialOptions = {}) {
    super(instanceCount);
    this._metallic = clampedNumber(options.metallic ?? 0, 0, 1, 'InstancedPbrMaterial.metallic');
    this._roughness = clampedNumber(options.roughness ?? 0.72, 0.04, 1, 'InstancedPbrMaterial.roughness');
    this._alphaMode = enumValue(options.alphaMode ?? 'opaque', ['opaque', 'blend'], 'InstancedPbrMaterial.alphaMode');
  }

  get metallic(): number { return this._metallic; }
  set metallic(value: number) {
    const next = clampedNumber(value, 0, 1, 'InstancedPbrMaterial.metallic');
    if (next === this._metallic) return;
    this._metallic = next;
    this._stateChanged();
  }

  get roughness(): number { return this._roughness; }
  set roughness(value: number) {
    const next = clampedNumber(value, 0.04, 1, 'InstancedPbrMaterial.roughness');
    if (next === this._roughness) return;
    this._roughness = next;
    this._stateChanged();
  }

  get alphaMode(): InstancedPbrAlphaMode { return this._alphaMode; }
  set alphaMode(value: InstancedPbrAlphaMode) {
    const next = enumValue(value, ['opaque', 'blend'], 'InstancedPbrMaterial.alphaMode');
    if (next === this._alphaMode) return;
    this._alphaMode = next;
    this._stateChanged();
  }

  override getShaderContract(): MaterialShaderContract {
    return INSTANCED_PBR_SHADER_CONTRACT;
  }
}
