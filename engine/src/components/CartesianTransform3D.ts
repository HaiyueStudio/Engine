import { Transform3D } from './Transform3D';
import { mat4, vec3 } from 'wgpu-matrix';
import type { Vec3 } from 'wgpu-matrix';
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
