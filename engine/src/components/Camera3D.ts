import { Component, UniqueCheckType } from '../ecs/Component';
import { mat4 } from 'wgpu-matrix';
import { requiredMat4Array, requiredNumberAt } from '../math/arrayAccess';

export type ProjectionType = 'perspective' | 'orthographic';

export interface Camera3DOptions {
  type?: ProjectionType;
  /** Perspective: vertical field of view in radians */
  fov?: number;
  /** Aspect ratio (width/height). Updated automatically by the render system. */
  aspect?: number;
  near?: number;
  far?: number;
  /** Orthographic bounds */
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export class Camera3D extends Component {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Camera3D');
  static editor = {
    fields: {
      projectionType: {
        type: 'select',
        label: 'Projection',
        group: 'Projection',
        options: [
          { label: 'Perspective', value: 'perspective' },
          { label: 'Orthographic', value: 'orthographic' },
        ],
      },
      fov: {
        type: 'number',
        label: 'FOV',
        group: 'Perspective',
        unit: 'rad',
        min: 0.017,
        max: 3.124,
        step: 0.01,
        visibleWhen: (component: Camera3D) => component.projectionType === 'perspective',
      },
      near: {
        type: 'number',
        label: 'Near',
        group: 'Clipping',
        step: 0.01,
        validate: (value: unknown) => Number(value) > 0 ? null : 'Near must be greater than 0.',
      },
      far: {
        type: 'number',
        label: 'Far',
        group: 'Clipping',
        step: 1,
        validate: (value: unknown, component: Camera3D) => Number(value) > component.near ? null : 'Far must be greater than Near.',
      },
      reverseZ: { type: 'boolean', label: 'Reverse Z', group: 'Clipping' },
      orthoLeft: {
        type: 'number',
        label: 'Left',
        group: 'Orthographic',
        step: 0.1,
        visibleWhen: (component: Camera3D) => component.projectionType === 'orthographic',
      },
      orthoRight: {
        type: 'number',
        label: 'Right',
        group: 'Orthographic',
        step: 0.1,
        visibleWhen: (component: Camera3D) => component.projectionType === 'orthographic',
        validate: (value: unknown, component: Camera3D) => Number(value) > component.orthoLeft ? null : 'Right must be greater than Left.',
      },
      orthoTop: {
        type: 'number',
        label: 'Top',
        group: 'Orthographic',
        step: 0.1,
        visibleWhen: (component: Camera3D) => component.projectionType === 'orthographic',
        validate: (value: unknown, component: Camera3D) => Number(value) > component.orthoBottom ? null : 'Top must be greater than Bottom.',
      },
      orthoBottom: {
        type: 'number',
        label: 'Bottom',
        group: 'Orthographic',
        step: 0.1,
        visibleWhen: (component: Camera3D) => component.projectionType === 'orthographic',
      },
    },
  };

  private _projMatrix: Float32Array = mat4.identity() as Float32Array;
  private _projDirty = true;
  private _projectionType: ProjectionType = 'perspective';
  private _fov = Math.PI / 4;
  private _aspect = 1;
  private _near = 0.1;
  private _far = 1000;
  private _orthoLeft = -1;
  private _orthoRight = 1;
  private _orthoTop = 1;
  private _orthoBottom = -1;
  private _reverseZ = false;

  constructor(options: Camera3DOptions = {}) {
    super('Camera3D');
    this.projectionType = options.type ?? 'perspective';
    this.fov = options.fov ?? Math.PI / 4;
    this.aspect = options.aspect ?? 1;
    this.near = options.near ?? 0.1;
    this.far = options.far ?? 1000;
    this.orthoLeft   = options.left   ?? -1;
    this.orthoRight  = options.right  ?? 1;
    this.orthoTop    = options.top    ?? 1;
    this.orthoBottom = options.bottom ?? -1;
  }

  get projectionType(): ProjectionType { return this._projectionType; }
  set projectionType(value: ProjectionType) {
    if (this._projectionType === value) return;
    this._projectionType = value;
    this.setDirty();
  }

  get fov(): number { return this._fov; }
  set fov(value: number) {
    if (this._fov === value) return;
    this._fov = value;
    this.setDirty();
  }

  get aspect(): number { return this._aspect; }
  set aspect(value: number) {
    if (this._aspect === value) return;
    this._aspect = value;
    this.setDirty();
  }

  get near(): number { return this._near; }
  set near(value: number) {
    if (this._near === value) return;
    this._near = value;
    this.setDirty();
  }

  get far(): number { return this._far; }
  set far(value: number) {
    if (this._far === value) return;
    this._far = value;
    this.setDirty();
  }

  get orthoLeft(): number { return this._orthoLeft; }
  set orthoLeft(value: number) {
    if (this._orthoLeft === value) return;
    this._orthoLeft = value;
    this.setDirty();
  }

  get orthoRight(): number { return this._orthoRight; }
  set orthoRight(value: number) {
    if (this._orthoRight === value) return;
    this._orthoRight = value;
    this.setDirty();
  }

  get orthoTop(): number { return this._orthoTop; }
  set orthoTop(value: number) {
    if (this._orthoTop === value) return;
    this._orthoTop = value;
    this.setDirty();
  }

  get orthoBottom(): number { return this._orthoBottom; }
  set orthoBottom(value: number) {
    if (this._orthoBottom === value) return;
    this._orthoBottom = value;
    this.setDirty();
  }

  get reverseZ(): boolean { return this._reverseZ; }
  set reverseZ(value: boolean) {
    if (this._reverseZ === value) return;
    this._reverseZ = value;
    this.setDirty();
  }

  updateAspect(aspect: number): void {
    this.aspect = aspect;
  }

  /** Force projection matrix to recompute on next access. */
  setDirty(): void {
    this._projDirty = true;
  }

  get projectionMatrix(): Float32Array {
    if (this._projDirty) {
      this.writeProjectionMatrix(this._projMatrix, this.aspect, this.reverseZ);
      this._projDirty = false;
    }
    return this._projMatrix;
  }

  /** Writes a view-specific projection without mutating camera component state. */
  writeProjectionMatrix(out: Float32Array, aspect = this.aspect, reverseZ = this.reverseZ): Float32Array {
    if (this.projectionType === 'perspective') {
      mat4.perspective(this.fov, aspect, this.near, this.far, out);
    } else {
      mat4.ortho(
        this.orthoLeft, this.orthoRight,
        this.orthoBottom, this.orthoTop,
        this.near, this.far,
        out,
      );
    }
    if (reverseZ) {
      const matrix = requiredMat4Array(out, 'Camera3D projection matrix');
      for (let column = 0; column < 4; column++) {
        const depthIndex = column * 4 + 2;
        matrix[depthIndex] = -requiredNumberAt(matrix, depthIndex, 'Camera3D projection matrix')
          + requiredNumberAt(matrix, depthIndex + 1, 'Camera3D projection matrix');
      }
    }
    return out;
  }

  override clone(): Camera3D {
    const camera = new Camera3D({
      type: this.projectionType,
      fov: this.fov,
      aspect: this.aspect,
      near: this.near,
      far: this.far,
      left: this.orthoLeft,
      right: this.orthoRight,
      top: this.orthoTop,
      bottom: this.orthoBottom,
    });
    camera.reverseZ = this.reverseZ;
    camera.disabled = this.disabled;
    return camera;
  }
}
