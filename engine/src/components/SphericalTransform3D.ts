import { Transform3D } from './Transform3D';
import { mat4 } from 'wgpu-matrix';
import { UniqueCheckType } from '../ecs/Component';
import { requiredMat4Array, requiredVec3Array } from '../math/arrayAccess';

/** Minimum polar angle from Y-axis (avoids gimbal lock at poles). */
const PHI_EPS = 0.005;

/**
 * Transform3D driven by spherical coordinates.
 *
 * Coordinate convention (right-hand, Y-up):
 *   radius — distance from target
 *   theta  — azimuthal angle in the XZ-plane, measured from +Z axis (radians)
 *   phi    — polar angle from +Y axis (0 = camera directly above, PI/2 = equatorial, PI = below)
 *
 * Camera position relative to target:
 *   x = radius * sin(phi) * sin(theta)
 *   y = radius * cos(phi)
 *   z = radius * sin(phi) * cos(theta)
 *
 * The local matrix is the camera world matrix (inverse of the view/lookAt matrix).
 * Attach this component to a camera entity in place of CartesianTransform3D.
 */
export class SphericalTransform3D extends Transform3D {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Transform3D');
  static editor = {
    fields: {
      radius: { type: 'number', label: 'Radius', group: 'Orbit', min: PHI_EPS, step: 0.1 },
      theta: { type: 'number', label: 'Theta', group: 'Orbit', unit: 'rad', step: 0.01 },
      phi: { type: 'number', label: 'Phi', group: 'Orbit', unit: 'rad', min: PHI_EPS, max: Math.PI - PHI_EPS, step: 0.01 },
      target: {
        type: 'vector',
        label: 'Target',
        group: 'Orbit',
        size: 3,
        get: (component: SphericalTransform3D) => component.target,
        set: (component: SphericalTransform3D, value: unknown) => {
          const vector = Array.isArray(value) ? value : [0, 0, 0];
          component.setTarget(Number(vector[0]) || 0, Number(vector[1]) || 0, Number(vector[2]) || 0);
        },
      },
    },
  };

  private _radius: number;
  private _theta: number;
  private _phi: number;
  private _target = requiredVec3Array(new Float32Array(3), 'spherical target');
  private readonly _eyePosition = requiredVec3Array(new Float32Array(3), 'spherical eye position');

  constructor(options: {
    radius?: number;
    theta?: number;
    phi?: number;
    target?: [number, number, number];
  } = {}) {
    super();
    this.name = 'SphericalTransform3D';
    this._radius = Math.max(PHI_EPS, options.radius ?? 10);
    this._theta  = options.theta  ?? 0;
    this._phi    = Math.max(PHI_EPS, Math.min(Math.PI - PHI_EPS, options.phi ?? Math.PI / 4));
    this._target.set(options.target ?? [0, 0, 0]);
    this._rebuild();
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  get radius(): number { return this._radius; }
  get theta():  number { return this._theta; }
  get phi():    number { return this._phi; }
  get target(): Float32Array { return this._target; }

  /** World-space eye position derived from current spherical state. */
  get eyePosition(): Float32Array {
    const matrix = requiredMat4Array(this._localMatrix, 'spherical local matrix');
    this._eyePosition[0] = matrix[12];
    this._eyePosition[1] = matrix[13];
    this._eyePosition[2] = matrix[14];
    return this._eyePosition;
  }

  // ── Setters (each triggers a rebuild) ─────────────────────────────────────

  set radius(v: number) {
    this._radius = Math.max(PHI_EPS, v);
    this._rebuild();
  }

  set theta(v: number) {
    this._theta = v;
    this._rebuild();
  }

  set phi(v: number) {
    this._phi = Math.max(PHI_EPS, Math.min(Math.PI - PHI_EPS, v));
    this._rebuild();
  }

  // ── Batch updates (one rebuild) ────────────────────────────────────────────

  /** Move the orbit target without changing angles or radius. */
  setTarget(x: number, y: number, z: number): this {
    this._target[0] = x;
    this._target[1] = y;
    this._target[2] = z;
    this._rebuild();
    return this;
  }

  /** Update all spherical parameters at once (single rebuild). */
  set(radius: number, theta: number, phi: number): this {
    this._radius = Math.max(PHI_EPS, radius);
    this._theta  = theta;
    this._phi    = Math.max(PHI_EPS, Math.min(Math.PI - PHI_EPS, phi));
    this._rebuild();
    return this;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _rebuild(): void {
    const { _radius: r, _theta: t, _phi: p } = this;
    const sp = Math.sin(p), cp = Math.cos(p);
    const st = Math.sin(t), ct = Math.cos(t);

    const eye = this._eyePosition;
    eye[0] = this._target[0] + r * sp * st;
    eye[1] = this._target[1] + r * cp;
    eye[2] = this._target[2] + r * sp * ct;

    // mat4.lookAt → VIEW matrix; inverse → camera world matrix
    const view = requiredMat4Array(
      mat4.lookAt(eye, this._target, [0, 1, 0]) as Float32Array,
      'spherical view matrix',
    );
    mat4.inverse(view, requiredMat4Array(this._localMatrix, 'spherical local matrix'));
    this.markDirty();
  }

  override clone(): SphericalTransform3D {
    return new SphericalTransform3D({
      radius: this._radius,
      theta:  this._theta,
      phi:    this._phi,
      target: [this._target[0], this._target[1], this._target[2]],
    });
  }
}
