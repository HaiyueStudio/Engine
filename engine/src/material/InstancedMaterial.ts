import { mat4 } from 'wgpu-matrix';
import { Material } from './Material';
import { clampedNumber, finiteNumber, integerInRange } from './materialValidation';

export class InstancedMaterial extends Material {
  readonly type: string = 'instanced';
  readonly instanceCount: number;

  /** Column-major model matrices — instanceCount × 16 floats */
  readonly transforms: Float32Array;
  /** Linear RGBA colors — instanceCount × 4 floats */
  readonly colors: Float32Array;

  private _transformDirtyStart = 0;
  private _transformDirtyEnd: number;
  private _colorDirtyStart = 0;
  private _colorDirtyEnd: number;
  private _activeInstanceCount: number;

  get transformsDirty(): boolean { return this._transformDirtyEnd > this._transformDirtyStart; }
  set transformsDirty(value: boolean) {
    if (value) this.markTransformsDirty();
    else this.clearTransformsDirty();
  }
  get colorsDirty(): boolean { return this._colorDirtyEnd > this._colorDirtyStart; }
  set colorsDirty(value: boolean) {
    if (value) this.markColorsDirty();
    else this.clearColorsDirty();
  }
  get transformDirtyStart(): number { return this._transformDirtyStart; }
  get transformDirtyEnd(): number { return this._transformDirtyEnd; }
  get colorDirtyStart(): number { return this._colorDirtyStart; }
  get colorDirtyEnd(): number { return this._colorDirtyEnd; }

  get activeInstanceCount(): number { return this._activeInstanceCount; }

  constructor(instanceCount: number) {
    super();
    this.instanceCount = integerInRange(instanceCount, 0, 0x7fff_ffff, 'InstancedMaterial.instanceCount');
    this.transforms    = new Float32Array(instanceCount * 16);
    this.colors        = new Float32Array(instanceCount * 4);
    this._activeInstanceCount = instanceCount;
    this._transformDirtyEnd = instanceCount;
    this._colorDirtyEnd = instanceCount;

    // Identity matrices + white as defaults
    for (let i = 0; i < instanceCount; i++) {
      mat4.identity(this.transforms.subarray(i * 16, i * 16 + 16));
      const offset = i * 4;
      this.colors[offset] = 1;
      this.colors[offset + 1] = 1;
      this.colors[offset + 2] = 1;
      this.colors[offset + 3] = 1;
    }
  }

  setTransform(index: number, matrix: Float32Array): this {
    this._validateIndex(index);
    if (matrix.length < 16) throw new RangeError(`InstancedMaterial transform must contain at least 16 values; received ${matrix.length}.`);
    for (let offset = 0; offset < 16; offset++) finiteNumber(matrix[offset]!, `InstancedMaterial.transform[${offset}]`);
    const targetOffset = index * 16;
    let changed = false;
    for (let offset = 0; offset < 16; offset++) {
      if (this.transforms[targetOffset + offset] !== matrix[offset]) {
        changed = true;
        break;
      }
    }
    if (!changed) return this;
    this.transforms.set(matrix.subarray(0, 16), targetOffset);
    this.markTransformsDirty(index, index + 1);
    this._stateChanged();
    return this;
  }

  setColor(index: number, r: number, g: number, b: number, a = 1): this {
    this._validateIndex(index);
    r = finiteNumber(r, 'InstancedMaterial.color.r');
    g = finiteNumber(g, 'InstancedMaterial.color.g');
    b = finiteNumber(b, 'InstancedMaterial.color.b');
    a = clampedNumber(a, 0, 1, 'InstancedMaterial.color.a');
    const targetOffset = index * 4;
    if (this.colors[targetOffset] === r
      && this.colors[targetOffset + 1] === g
      && this.colors[targetOffset + 2] === b
      && this.colors[targetOffset + 3] === a) return this;
    this.colors[targetOffset] = r;
    this.colors[targetOffset + 1] = g;
    this.colors[targetOffset + 2] = b;
    this.colors[targetOffset + 3] = a;
    this.markColorsDirty(index, index + 1);
    this._stateChanged();
    return this;
  }

  setActiveInstanceCount(count: number): this {
    const next = Math.max(0, Math.min(this.instanceCount, Math.floor(finiteNumber(count, 'InstancedMaterial.activeInstanceCount'))));
    if (this._activeInstanceCount === next) return this;
    this._activeInstanceCount = next;
    this._stateChanged();
    return this;
  }

  copyInstance(sourceIndex: number, targetIndex: number): this {
    this._validateIndex(sourceIndex);
    this._validateIndex(targetIndex);
    if (sourceIndex === targetIndex) return this;
    this.transforms.copyWithin(targetIndex * 16, sourceIndex * 16, sourceIndex * 16 + 16);
    this.colors.copyWithin(targetIndex * 4, sourceIndex * 4, sourceIndex * 4 + 4);
    this.markTransformsDirty(targetIndex, targetIndex + 1);
    this.markColorsDirty(targetIndex, targetIndex + 1);
    this._stateChanged();
    return this;
  }

  markTransformsDirty(start = 0, end = this.instanceCount): this {
    if (end <= start) return this;
    this._transformDirtyStart = Math.min(this._transformDirtyStart, Math.max(0, start));
    this._transformDirtyEnd = Math.max(this._transformDirtyEnd, Math.min(this.instanceCount, end));
    return this;
  }

  markColorsDirty(start = 0, end = this.instanceCount): this {
    if (end <= start) return this;
    this._colorDirtyStart = Math.min(this._colorDirtyStart, Math.max(0, start));
    this._colorDirtyEnd = Math.max(this._colorDirtyEnd, Math.min(this.instanceCount, end));
    return this;
  }

  clearTransformsDirty(): void {
    this._transformDirtyStart = this.instanceCount;
    this._transformDirtyEnd = 0;
  }

  clearColorsDirty(): void {
    this._colorDirtyStart = this.instanceCount;
    this._colorDirtyEnd = 0;
  }

  private _validateIndex(index: number): void {
    integerInRange(index, 0, this.instanceCount - 1, 'InstancedMaterial.index');
  }
}
