import { Transform3D } from './Transform3D';
import { mat4, vec3 } from 'wgpu-matrix';
import type { Mat4, Vec3 } from 'wgpu-matrix';
import { UniqueCheckType } from '../ecs/Component';
import { requiredVec3Array } from '../math/arrayAccess';

export type { Vec3 };

const translationScratch = mat4.identity() as Float32Array;
const rotationYScratch = mat4.identity() as Float32Array;
const rotationXScratch = mat4.identity() as Float32Array;
const rotationZScratch = mat4.identity() as Float32Array;
const scaleScratch = mat4.identity() as Float32Array;
const anchorScratch = mat4.identity() as Float32Array;
const rotationScratch = mat4.identity() as Float32Array;
const tempScratch = mat4.identity() as Float32Array;
const combinedScratch = mat4.identity() as Float32Array;

/**
 * Transform3D extended with Cartesian coordinates and Euler angles (in radians).
 * Right-hand coordinate system: +X right, +Y up, -Z forward.
 * Euler order: Y → X → Z (yaw-pitch-roll).
 */
export class CartesianTransform3D extends Transform3D {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Transform3D');
  static editor = {
    fields: {
      position: {
        type: 'vector',
        label: 'Position',
        group: 'Transform',
        size: 3,
        get: (component: CartesianTransform3D) => component.position,
        set: (component: CartesianTransform3D, value: unknown) => {
          const vector = Array.isArray(value) ? value : [0, 0, 0];
          component.setPosition(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
      rotation: {
        type: 'vector',
        label: 'Rotation',
        group: 'Transform',
        unit: 'rad',
        size: 3,
        get: (component: CartesianTransform3D) => component.rotation,
        set: (component: CartesianTransform3D, value: unknown) => {
          const vector = Array.isArray(value) ? value : [0, 0, 0];
          component.setRotation(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
      scale: {
        type: 'vector',
        label: 'Scale',
        group: 'Transform',
        size: 3,
        get: (component: CartesianTransform3D) => component.scale,
        set: (component: CartesianTransform3D, value: unknown) => {
          const vector = Array.isArray(value) ? value : [1, 1, 1];
          component.setScale(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
      anchor: {
        type: 'vector',
        label: 'Anchor',
        group: 'Transform',
        size: 3,
        get: (component: CartesianTransform3D) => component.anchor,
        set: (component: CartesianTransform3D, value: unknown) => {
          const vector = Array.isArray(value) ? value : [0, 0, 0];
          component.setAnchor(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
    },
  };

  private _position = requiredVec3Array(vec3.fromValues(0, 0, 0) as Float32Array, 'cartesian position');
  private _rotation = requiredVec3Array(vec3.fromValues(0, 0, 0) as Float32Array, 'cartesian rotation');
  private _scale = requiredVec3Array(vec3.fromValues(1, 1, 1) as Float32Array, 'cartesian scale');
  private _anchor = requiredVec3Array(vec3.fromValues(0, 0, 0) as Float32Array, 'cartesian anchor');
  private readonly _anchorOffset = requiredVec3Array(
    vec3.fromValues(0, 0, 0) as Float32Array,
    'cartesian anchor offset',
  );

  constructor(options?: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    anchor?: [number, number, number];
  }) {
    super();
    this.name = 'CartesianTransform3D';
    if (options) {
      if (options.position) vec3.set(...options.position, this._position);
      if (options.rotation) vec3.set(...options.rotation, this._rotation);
      if (options.scale) vec3.set(...options.scale, this._scale);
      if (options.anchor) vec3.set(...options.anchor, this._anchor);
    }
    this._rebuildMatrix();
  }

  get position(): Float32Array { return this._position; }
  get rotation(): Float32Array { return this._rotation; }
  get scale(): Float32Array    { return this._scale; }
  get anchor(): Float32Array   { return this._anchor; }

  setPosition(x: number, y: number, z: number): this {
    vec3.set(x, y, z, this._position);
    this._rebuildMatrix();
    return this;
  }

  setRotation(x: number, y: number, z: number): this {
    vec3.set(x, y, z, this._rotation);
    this._rebuildMatrix();
    return this;
  }

  setScale(x: number, y: number, z: number): this {
    vec3.set(x, y, z, this._scale);
    this._rebuildMatrix();
    return this;
  }

  setAnchor(x: number, y: number, z: number): this {
    vec3.set(x, y, z, this._anchor);
    this._rebuildMatrix();
    return this;
  }

  /**
   * Replaces the local matrix while keeping the Cartesian editing projection in
   * sync. Runtime systems such as physics write matrices directly; without this
   * override, `position`, `rotation`, and `scale` would keep returning stale
   * authoring values even though the rendered transform had moved.
   */
  override setMatrix(matrix: Mat4): this {
    super.setMatrix(matrix);
    const m = this._localMatrix;
    const sx = Math.hypot(m[0] ?? 1, m[1] ?? 0, m[2] ?? 0) || 1;
    const sy = Math.hypot(m[4] ?? 0, m[5] ?? 1, m[6] ?? 0) || 1;
    const sz = Math.hypot(m[8] ?? 0, m[9] ?? 0, m[10] ?? 1) || 1;
    vec3.set(sx, sy, sz, this._scale);

    const r00 = (m[0] ?? 1) / sx;
    const r10 = (m[1] ?? 0) / sx;
    const r20 = (m[2] ?? 0) / sx;
    const r11 = (m[5] ?? 1) / sy;
    const r02 = (m[8] ?? 0) / sz;
    const r12 = (m[9] ?? 0) / sz;
    const r22 = (m[10] ?? 1) / sz;
    const x = Math.asin(Math.max(-1, Math.min(1, -r12)));
    const cosineX = Math.cos(x);
    const y = Math.abs(cosineX) > 1e-6
      ? Math.atan2(r02, r22)
      : Math.atan2(-r20, r00);
    const z = Math.abs(cosineX) > 1e-6 ? Math.atan2(r10, r11) : 0;
    vec3.set(x, y, z, this._rotation);

    // Cartesian position names the pre-anchor origin. The matrix translation is
    // the post-anchor origin, so restore R * anchor before exposing it.
    const ax = this._anchor[0], ay = this._anchor[1], az = this._anchor[2];
    const r01 = (m[4] ?? 0) / sy;
    const r21 = (m[6] ?? 0) / sy;
    vec3.set(
      (m[12] ?? 0) + r00 * ax + r01 * ay + r02 * az,
      (m[13] ?? 0) + r10 * ax + r11 * ay + r12 * az,
      (m[14] ?? 0) + r20 * ax + r21 * ay + r22 * az,
      this._position,
    );
    return this;
  }

  private _rebuildMatrix(): void {
    const rx = this._rotation[0];
    const ry = this._rotation[1];
    const rz = this._rotation[2];

    // Build TRS: translate(position) * rotY * rotX * rotZ * translate(-anchor) * scale
    mat4.translation(this._position, translationScratch);
    mat4.rotationY(ry, rotationYScratch);
    mat4.rotationX(rx, rotationXScratch);
    mat4.rotationZ(rz, rotationZScratch);
    mat4.scaling(this._scale, scaleScratch);
    this._anchorOffset[0] = -this._anchor[0];
    this._anchorOffset[1] = -this._anchor[1];
    this._anchorOffset[2] = -this._anchor[2];
    mat4.translation(this._anchorOffset, anchorScratch);

    mat4.multiply(rotationYScratch, rotationXScratch, rotationScratch);
    mat4.multiply(rotationScratch, rotationZScratch, tempScratch);
    mat4.multiply(anchorScratch, scaleScratch, rotationScratch);
    mat4.multiply(tempScratch, rotationScratch, combinedScratch);
    mat4.multiply(translationScratch, combinedScratch, this._localMatrix);
    this.markDirty();
  }

  override clone(): CartesianTransform3D {
    const c = new CartesianTransform3D();
    vec3.copy(this._position, c._position);
    vec3.copy(this._rotation, c._rotation);
    vec3.copy(this._scale, c._scale);
    vec3.copy(this._anchor, c._anchor);
    c._rebuildMatrix();
    return c;
  }
}
