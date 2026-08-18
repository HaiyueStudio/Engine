import { Transform3D } from './Transform3D';
import { UniqueCheckType } from '../ecs/Component';
import {
  requiredMat4Array,
  requiredVec3Array,
  type RequiredVec3Array,
} from '../math/arrayAccess';

export type Vec3Tuple = [number, number, number];

export interface BasisTransform3DOptions {
  /** Local coordinate in the configured basis. */
  coordinates?: Vec3Tuple;
  /** Basis vector for local +X. Defaults to world +X. */
  basisX?: Vec3Tuple;
  /** Basis vector for local +Y. Defaults to world +Y. */
  basisY?: Vec3Tuple;
  /** Basis vector for local +Z. Defaults to world +Z. */
  basisZ?: Vec3Tuple;
}

/**
 * Transform3D driven by a custom 3-D basis and local coordinates.
 *
 * The basis vectors form the columns of the local matrix. The translation is:
 *   world = basisX * x + basisY * y + basisZ * z
 *
 * With the default basis vectors this behaves like Cartesian coordinates.
 */
export class BasisTransform3D extends Transform3D {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Transform3D');

  private _coordinates = requiredVec3Array(new Float32Array([0, 0, 0]), 'basis coordinates');
  private _basisX = requiredVec3Array(new Float32Array([1, 0, 0]), 'basis X');
  private _basisY = requiredVec3Array(new Float32Array([0, 1, 0]), 'basis Y');
  private _basisZ = requiredVec3Array(new Float32Array([0, 0, 1]), 'basis Z');
  private readonly _mappedPosition = requiredVec3Array(new Float32Array(3), 'basis mapped position');

  constructor(options: BasisTransform3DOptions = {}) {
    super();
    this.name = 'BasisTransform3D';
    if (options.coordinates) this._setVec(this._coordinates, options.coordinates);
    if (options.basisX) this._setVec(this._basisX, options.basisX);
    if (options.basisY) this._setVec(this._basisY, options.basisY);
    if (options.basisZ) this._setVec(this._basisZ, options.basisZ);
    this._rebuildMatrix();
  }

  get coordinates(): Float32Array { return this._coordinates; }
  get basisX(): Float32Array { return this._basisX; }
  get basisY(): Float32Array { return this._basisY; }
  get basisZ(): Float32Array { return this._basisZ; }

  /** Position produced by the basis-coordinate mapping before parent transforms. */
  get mappedPosition(): Float32Array {
    const matrix = requiredMat4Array(this._localMatrix, 'basis local matrix');
    this._mappedPosition[0] = matrix[12];
    this._mappedPosition[1] = matrix[13];
    this._mappedPosition[2] = matrix[14];
    return this._mappedPosition;
  }

  setCoordinates(x: number, y: number, z: number): this {
    this._coordinates[0] = x;
    this._coordinates[1] = y;
    this._coordinates[2] = z;
    this._rebuildMatrix();
    return this;
  }

  setBasis(
    basisX: Vec3Tuple,
    basisY: Vec3Tuple,
    basisZ: Vec3Tuple,
  ): this {
    this._setVec(this._basisX, basisX);
    this._setVec(this._basisY, basisY);
    this._setVec(this._basisZ, basisZ);
    this._rebuildMatrix();
    return this;
  }

  setBasisX(x: number, y: number, z: number): this {
    this._basisX[0] = x;
    this._basisX[1] = y;
    this._basisX[2] = z;
    this._rebuildMatrix();
    return this;
  }

  setBasisY(x: number, y: number, z: number): this {
    this._basisY[0] = x;
    this._basisY[1] = y;
    this._basisY[2] = z;
    this._rebuildMatrix();
    return this;
  }

  setBasisZ(x: number, y: number, z: number): this {
    this._basisZ[0] = x;
    this._basisZ[1] = y;
    this._basisZ[2] = z;
    this._rebuildMatrix();
    return this;
  }

  private _setVec(out: RequiredVec3Array, value: Vec3Tuple): void {
    out[0] = value[0];
    out[1] = value[1];
    out[2] = value[2];
  }

  private _rebuildMatrix(): void {
    const matrix = requiredMat4Array(this._localMatrix, 'basis local matrix');
    const x = this._coordinates[0];
    const y = this._coordinates[1];
    const z = this._coordinates[2];

    matrix[0] = this._basisX[0];
    matrix[1] = this._basisX[1];
    matrix[2] = this._basisX[2];
    matrix[3] = 0;

    matrix[4] = this._basisY[0];
    matrix[5] = this._basisY[1];
    matrix[6] = this._basisY[2];
    matrix[7] = 0;

    matrix[8] = this._basisZ[0];
    matrix[9] = this._basisZ[1];
    matrix[10] = this._basisZ[2];
    matrix[11] = 0;

    matrix[12] = this._basisX[0] * x + this._basisY[0] * y + this._basisZ[0] * z;
    matrix[13] = this._basisX[1] * x + this._basisY[1] * y + this._basisZ[1] * z;
    matrix[14] = this._basisX[2] * x + this._basisY[2] * y + this._basisZ[2] * z;
    matrix[15] = 1;

    this.markDirty();
  }

  override clone(): BasisTransform3D {
    return new BasisTransform3D({
      coordinates: [
        this._coordinates[0],
        this._coordinates[1],
        this._coordinates[2],
      ],
      basisX: [this._basisX[0], this._basisX[1], this._basisX[2]],
      basisY: [this._basisY[0], this._basisY[1], this._basisY[2]],
      basisZ: [this._basisZ[0], this._basisZ[1], this._basisZ[2]],
    });
  }
}
