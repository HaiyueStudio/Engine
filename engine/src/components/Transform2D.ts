import { Component, UniqueCheckType } from '../ecs/Component';
import { mat4 } from 'wgpu-matrix';
import { requiredMat4Array } from '../math/arrayAccess';

export interface Transform2DOptions {
  x?:      number;
  y?:      number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  scale?:  number;
}

export class Transform2D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('Transform2D');
  static editor = {
    fields: {
      x: { type: 'number', label: 'X', group: 'Position', step: 0.1 },
      y: { type: 'number', label: 'Y', group: 'Position', step: 0.1 },
      rotation: { type: 'number', label: 'Rotation', group: 'Rotation', unit: 'rad', step: 0.01 },
      scaleX: { type: 'number', label: 'Scale X', group: 'Scale', step: 0.01 },
      scaleY: { type: 'number', label: 'Scale Y', group: 'Scale', step: 0.01 },
    },
  };

  /** Column-major 4×4 world matrix (updated by the render system each frame). */
  worldMatrix: Float32Array = mat4.identity() as Float32Array;
  worldMatrixDirty = true;

  private _localMatrix: Float32Array = mat4.identity() as Float32Array;
  private _x: number;
  private _y: number;
  private _rotation: number;
  private _scaleX: number;
  private _scaleY: number;
  private _localVersion = 0;
  private _worldVersion = 0;
  private _lastParentWorldVersion = Number.NaN;

  constructor(options: Transform2DOptions = {}) {
    super('Transform2D');
    this._x        = options.x        ?? 0;
    this._y        = options.y        ?? 0;
    this._rotation = options.rotation ?? 0;
    const s       = options.scale    ?? 1;
    this._scaleX   = options.scaleX   ?? s;
    this._scaleY   = options.scaleY   ?? s;
  }

  get x(): number { return this._x; }
  set x(value: number) {
    if (this._x === value) return;
    this._x = value;
    this.markDirty();
  }

  get y(): number { return this._y; }
  set y(value: number) {
    if (this._y === value) return;
    this._y = value;
    this.markDirty();
  }

  get rotation(): number { return this._rotation; }
  set rotation(value: number) {
    if (this._rotation === value) return;
    this._rotation = value;
    this.markDirty();
  }

  get scaleX(): number { return this._scaleX; }
  set scaleX(value: number) {
    if (this._scaleX === value) return;
    this._scaleX = value;
    this.markDirty();
  }

  get scaleY(): number { return this._scaleY; }
  set scaleY(value: number) {
    if (this._scaleY === value) return;
    this._scaleY = value;
    this.markDirty();
  }

  get localVersion(): number {
    return this._localVersion;
  }

  get worldVersion(): number {
    return this._worldVersion;
  }

  get localMatrix(): Float32Array {
    this._updateLocalMatrix();
    return this._localMatrix;
  }

  get position(): Float32Array {
    return new Float32Array([this._x, this._y, 0]);
  }

  get scale(): Float32Array {
    return new Float32Array([this._scaleX, this._scaleY, 1]);
  }

  setPosition(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  setScale(x: number, y = x): this {
    this.scaleX = x;
    this.scaleY = y;
    return this;
  }

  markDirty(): this {
    this._localVersion++;
    this.worldMatrixDirty = true;
    for (const entity of this.usedBy) entity.world?.frameData.transforms.markDirty(entity);
    return this;
  }

  /** Recompute worldMatrix from this transform's properties, optionally
   *  concatenated with a parent world matrix. */
  updateWorldMatrix(parentMatrix?: Float32Array, parentWorldVersion = Number.NaN): void {
    const parentChanged = !sameParentVersion(this._lastParentWorldVersion, parentWorldVersion);
    if (!this.worldMatrixDirty && !parentChanged) return;

    this._updateLocalMatrix();
    const m = requiredMat4Array(this._localMatrix, 'Transform2D local matrix');
    const worldMatrix = requiredMat4Array(this.worldMatrix, 'Transform2D world matrix');
    if (parentMatrix) {
      mat4.multiply(
        requiredMat4Array(parentMatrix, 'Transform2D parent world matrix'),
        m,
        worldMatrix,
      );
    } else {
      worldMatrix.set(m);
    }
    this._lastParentWorldVersion = parentWorldVersion;
    this._worldVersion++;
    this.worldMatrixDirty = false;
  }

  private _updateLocalMatrix(): void {
    const cos = Math.cos(this._rotation);
    const sin = Math.sin(this._rotation);
    const sx  = this._scaleX;
    const sy  = this._scaleY;
    const m = requiredMat4Array(this._localMatrix, 'Transform2D local matrix');

    // Column-major 4×4
    m[0]  =  sx * cos;  m[1]  = sx * sin;  m[2]  = 0;  m[3]  = 0;
    m[4]  = -sy * sin;  m[5]  = sy * cos;  m[6]  = 0;  m[7]  = 0;
    m[8]  = 0;          m[9]  = 0;         m[10] = 1;  m[11] = 0;
    m[12] = this._x;    m[13] = this._y;   m[14] = 0;  m[15] = 1;
  }

  override clone(): Transform2D {
    const transform = new Transform2D({
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
    });
    transform.disabled = this.disabled;
    return transform;
  }
}

function sameParentVersion(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}
