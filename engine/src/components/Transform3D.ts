import { ComponentWithData, UniqueCheckType } from '../ecs/Component';
import { mat4 } from 'wgpu-matrix';
import type { Mat4 } from 'wgpu-matrix';
import { requiredMat4Array } from '../math/arrayAccess';

export type { Mat4 };

/**
 * Base Transform3D component. Stores the local transform as a 4×4 matrix.
 * If an entity has no Transform3D, the engine uses the identity matrix.
 */
export class Transform3D extends ComponentWithData<Float32Array> {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Transform3D');
  static editor: unknown = {
    fields: {
      localMatrix: {
        type: 'array',
        label: 'Local Matrix',
        rows: 6,
        get: (component: Transform3D) => Array.from(component.localMatrix),
        set: (component: Transform3D, value: unknown) => {
          if (!Array.isArray(value)) return;
          const values = value.map(item => Number(item));
          if (values.length !== 16 || values.some(item => !Number.isFinite(item))) return;
          component.localMatrix = Float32Array.from(values);
        },
        validate: (value: unknown) => (
          Array.isArray(value) &&
          value.length === 16 &&
          value.every(item => Number.isFinite(Number(item)))
            ? null
            : 'Local Matrix must contain 16 numbers.'
        ),
      },
    },
  };

  /** Local transform matrix (column-major Float32Array, 16 elements) */
  protected _localMatrix: Float32Array;
  /** World transform matrix (updated by the render system) */
  worldMatrix: Float32Array = mat4.identity() as Float32Array;
  worldMatrixDirty = true;
  private _localVersion = 0;
  private _lastLocalVersion = -1;
  private _worldVersion = 0;
  private _lastParentWorldVersion = Number.NaN;

  get localVersion(): number {
    return this._localVersion;
  }

  get worldVersion(): number {
    return this._worldVersion;
  }

  constructor() {
    super(mat4.identity() as Float32Array, 'Transform3D');
    this._localMatrix = this.data;
  }

  get localMatrix(): Float32Array {
    return this._localMatrix;
  }

  set localMatrix(m: Float32Array) {
    mat4.copy(
      requiredMat4Array(m, 'Transform3D localMatrix input'),
      requiredMat4Array(this._localMatrix, 'Transform3D local matrix'),
    );
    this.markDirty();
  }

  /** Set the local matrix directly from a Mat4 value. */
  setMatrix(m: Mat4): this {
    mat4.copy(
      requiredMat4Array(m, 'Transform3D matrix input'),
      requiredMat4Array(this._localMatrix, 'Transform3D local matrix'),
    );
    return this.markDirty();
  }

  /** Set only the local translation terms while preserving rotation/scale. */
  setTranslation(x: number, y: number, z: number): this {
    this._localMatrix[12] = x;
    this._localMatrix[13] = y;
    this._localMatrix[14] = z;
    return this.markDirty();
  }

  markDirty(): this {
    this._localVersion++;
    this.worldMatrixDirty = true;
    for (const entity of this.usedBy) entity.world?.frameData.transforms.markDirty(entity);
    return this;
  }

  /** Compute worldMatrix from parent chain. Called by the render system. */
  updateWorldMatrix(parentWorldMatrix?: Float32Array, parentWorldVersion = Number.NaN): this {
    const localChanged = this._lastLocalVersion !== this._localVersion;
    const parentChanged = !sameParentVersion(this._lastParentWorldVersion, parentWorldVersion);
    if (!this.worldMatrixDirty && !localChanged && !parentChanged) {
      return this;
    }

    const localMatrix = requiredMat4Array(this._localMatrix, 'Transform3D local matrix');
    const worldMatrix = requiredMat4Array(this.worldMatrix, 'Transform3D world matrix');
    if (parentWorldMatrix) {
      mat4.multiply(
        requiredMat4Array(parentWorldMatrix, 'Transform3D parent world matrix'),
        localMatrix,
        worldMatrix,
      );
    } else {
      mat4.copy(localMatrix, worldMatrix);
    }
    this._lastLocalVersion = this._localVersion;
    this._lastParentWorldVersion = parentWorldVersion;
    this._worldVersion++;
    this.worldMatrixDirty = false;
    return this;
  }

  override clone(): Transform3D {
    const c = new Transform3D();
    c.localMatrix = Float32Array.from(this._localMatrix);
    return c;
  }
}

function sameParentVersion(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}
