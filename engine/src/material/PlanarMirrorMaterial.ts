import { Material } from './Material';

export interface PlanarMirrorMaterialOptions {
  /** RGB multiplier applied to the reflected scene. */
  tint?: readonly [number, number, number];
  /** Reflection contribution. Zero shows only tint, one is a full reflection. */
  reflectivity?: number;
}

export interface PlanarMirrorReflection {
  readonly texture: GPUTexture;
  readonly viewProjectionMatrix: Float32Array;
  readonly version: number;
}

interface MutablePlanarMirrorReflection extends PlanarMirrorReflection {
  texture: GPUTexture;
  version: number;
}

/** Projective material populated automatically by PlanarMirror runtime state. */
export class PlanarMirrorMaterial extends Material {
  readonly type = 'planar-mirror';
  private _tint: readonly [number, number, number];
  private _reflectivity: number;
  private readonly _reflections = new Map<string, MutablePlanarMirrorReflection>();

  constructor(options: PlanarMirrorMaterialOptions = {}) {
    super();
    this._tint = validateTint(options.tint ?? [1, 1, 1]);
    this._reflectivity = validateUnit(options.reflectivity ?? 1, 'PlanarMirrorMaterial.reflectivity');
  }

  get tint(): readonly [number, number, number] { return this._tint; }
  set tint(value: readonly [number, number, number]) {
    const next = validateTint(value);
    if (sameTint(this._tint, next)) return;
    this._tint = next;
    this._stateChanged();
  }

  get reflectivity(): number { return this._reflectivity; }
  set reflectivity(value: number) {
    const next = validateUnit(value, 'PlanarMirrorMaterial.reflectivity');
    if (this._reflectivity === next) return;
    this._reflectivity = next;
    this._stateChanged();
  }

  /** @internal */
  setReflection(
    viewKey: string,
    texture: GPUTexture,
    version: number,
    viewProjectionMatrix: Float32Array,
  ): void {
    let reflection = this._reflections.get(viewKey);
    if (!reflection) {
      reflection = {
        texture,
        version,
        viewProjectionMatrix: new Float32Array(16),
      };
      this._reflections.set(viewKey, reflection);
    }
    reflection.texture = texture;
    reflection.version = version;
    reflection.viewProjectionMatrix.set(viewProjectionMatrix);
  }

  /** @internal */
  getReflection(viewKey: string): PlanarMirrorReflection | null {
    return this._reflections.get(viewKey) ?? null;
  }

  /** @internal */
  deleteReflection(viewKey: string): void {
    this._reflections.delete(viewKey);
  }

  /** @internal */
  clearReflections(): void {
    this._reflections.clear();
  }
}

function validateTint(value: readonly [number, number, number]): readonly [number, number, number] {
  if (value.length !== 3 || value.some(channel => !Number.isFinite(channel) || channel < 0)) {
    throw new RangeError('PlanarMirrorMaterial.tint must contain three finite, non-negative channels.');
  }
  return Object.freeze([value[0], value[1], value[2]] as [number, number, number]);
}

function validateUnit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a finite number in [0, 1].`);
  }
  return value;
}

function sameTint(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
