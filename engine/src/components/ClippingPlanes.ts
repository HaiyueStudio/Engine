import { Component, UniqueCheckType } from '../ecs/Component';

export const MAX_CLIPPING_PLANES = 8;

export interface ClippingPlane {
  /** World-space plane normal. It is normalized when assigned. */
  readonly normal: readonly [number, number, number];
  /** Plane equation constant: dot(normal, worldPosition) + constant >= 0 is retained. */
  readonly constant: number;
}

export interface ClippingPlanesOptions {
  planes?: readonly ClippingPlane[];
}

/**
 * Clips one renderable entity against up to eight world-space planes.
 *
 * The intersection of the retained half-spaces is rendered. This is a
 * fragment-clipping feature and deliberately does not generate cap geometry.
 */
export class ClippingPlanes extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('ClippingPlanes');

  private readonly _packedPlanes = new Float32Array(MAX_CLIPPING_PLANES * 4);
  private _count = 0;
  private _revision = 1;

  constructor(options: ClippingPlanesOptions | readonly ClippingPlane[] = {}) {
    super('ClippingPlanes');
    const planes = Array.isArray(options)
      ? options as readonly ClippingPlane[]
      : (options as ClippingPlanesOptions).planes ?? [];
    this.setPlanes(planes);
  }

  get count(): number { return this._count; }
  get revision(): number { return this._revision; }

  /** Packed normalized vec4 plane equations consumed by renderer object tables. */
  get packedPlanes(): Readonly<Float32Array> { return this._packedPlanes; }

  getPlane(index: number): ClippingPlane {
    this._validateExistingIndex(index);
    const offset = index * 4;
    return Object.freeze({
      normal: Object.freeze([
        this._packedPlanes[offset]!,
        this._packedPlanes[offset + 1]!,
        this._packedPlanes[offset + 2]!,
      ]) as readonly [number, number, number],
      constant: this._packedPlanes[offset + 3]!,
    });
  }

  setPlanes(planes: readonly ClippingPlane[]): this {
    if (!Array.isArray(planes)) throw new TypeError('ClippingPlanes.planes must be an array.');
    if (planes.length > MAX_CLIPPING_PLANES) {
      throw new RangeError(`ClippingPlanes supports at most ${MAX_CLIPPING_PLANES} planes.`);
    }
    const next = new Float32Array(MAX_CLIPPING_PLANES * 4);
    for (let index = 0; index < planes.length; index++) {
      writeNormalizedPlane(next, index * 4, planes[index], `ClippingPlanes.planes[${index}]`);
    }
    if (this._count === planes.length && samePrefix(this._packedPlanes, next, planes.length * 4)) return this;
    this._packedPlanes.set(next);
    this._count = planes.length;
    this._changed();
    return this;
  }

  setPlane(index: number, plane: ClippingPlane): this {
    this._validateExistingIndex(index);
    const offset = index * 4;
    const next = new Float32Array(4);
    writeNormalizedPlane(next, 0, plane, `ClippingPlanes.planes[${index}]`);
    if (samePrefix(this._packedPlanes.subarray(offset, offset + 4), next, 4)) return this;
    this._packedPlanes.set(next, offset);
    this._changed();
    return this;
  }

  clear(): this {
    if (this._count === 0) return this;
    this._packedPlanes.fill(0);
    this._count = 0;
    this._changed();
    return this;
  }

  override clone(): ClippingPlanes {
    const planes: ClippingPlane[] = [];
    for (let index = 0; index < this._count; index++) planes.push(this.getPlane(index));
    const copy = new ClippingPlanes(planes);
    copy.disabled = this.disabled;
    return copy;
  }

  private _validateExistingIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this._count) {
      throw new RangeError(`ClippingPlanes plane index ${index} is outside [0, ${this._count}).`);
    }
  }

  private _changed(): void {
    this._revision = this._revision >= Number.MAX_SAFE_INTEGER ? 1 : this._revision + 1;
    for (const entity of this.usedBy) entity.world?.notifyEntityComponentChanged(entity, this);
  }
}

function writeNormalizedPlane(
  target: Float32Array,
  offset: number,
  plane: ClippingPlane | undefined,
  label: string,
): void {
  if (!plane || !Array.isArray(plane.normal) || plane.normal.length !== 3) {
    throw new TypeError(`${label} must provide a three-component normal.`);
  }
  const x = Number(plane.normal[0]);
  const y = Number(plane.normal[1]);
  const z = Number(plane.normal[2]);
  const constant = Number(plane.constant);
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 1e-8 || !Number.isFinite(constant)) {
    throw new RangeError(`${label} must contain a finite non-zero normal and finite constant.`);
  }
  target[offset] = x / length;
  target[offset + 1] = y / length;
  target[offset + 2] = z / length;
  target[offset + 3] = constant / length;
}

function samePrefix(a: Float32Array, b: Float32Array, length: number): boolean {
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return false;
  return true;
}
