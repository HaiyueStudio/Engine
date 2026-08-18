// ── Bounding sphere ──────────────────────────────────────────────────────────

import type { Geometry3D } from '../geometry/Geometry3D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredMat4Array, requiredNumberAt, type RequiredMat4Array } from '../math/arrayAccess';

type PlaneElements = Float32Array & {
  0: number; 1: number; 2: number; 3: number;
};

export interface BoundingSphere {
  center: readonly [number, number, number];
  radius: number;
}

export type GeometryFrustumTestMode = 'any' | 'all';

/**
 * Compute the bounding sphere of a positions Float32Array (x,y,z triplets).
 * Uses centroid + max-distance approach (fast, slightly conservative).
 */
export function computeBoundingSphere(positions: Float32Array): BoundingSphere {
  if (positions.length < 3 || positions.length % 3 !== 0) {
    throw frustumParameterError(
      'computeBoundingSphere requires a non-empty Float32Array of xyz triplets.',
      'Pass at least one complete [x, y, z] position.',
    );
  }
  const count = positions.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    cx += requiredNumberAt(positions, i, 'bounding sphere positions');
    cy += requiredNumberAt(positions, i + 1, 'bounding sphere positions');
    cz += requiredNumberAt(positions, i + 2, 'bounding sphere positions');
  }
  cx /= count; cy /= count; cz /= count;

  let r2 = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = requiredNumberAt(positions, i, 'bounding sphere positions') - cx;
    const dy = requiredNumberAt(positions, i + 1, 'bounding sphere positions') - cy;
    const dz = requiredNumberAt(positions, i + 2, 'bounding sphere positions') - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) r2 = d2;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(r2) };
}

/**
 * Transform a local-space bounding sphere to world space using a 4×4 column-major matrix.
 * The radius is scaled by the maximum of the three column lengths (handles non-uniform scale).
 */
export function transformBoundingSphere(
  sphere: BoundingSphere,
  m: Float32Array,
): BoundingSphere {
  const matrix = requireMatrix4(m, 'transformBoundingSphere');
  const [lx, ly, lz] = sphere.center;
  const wx = matrix[0] * lx + matrix[4] * ly + matrix[8]  * lz + matrix[12];
  const wy = matrix[1] * lx + matrix[5] * ly + matrix[9]  * lz + matrix[13];
  const wz = matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14];

  const sx = Math.sqrt(matrix[0] * matrix[0] + matrix[1] * matrix[1] + matrix[2] * matrix[2]);
  const sy = Math.sqrt(matrix[4] * matrix[4] + matrix[5] * matrix[5] + matrix[6] * matrix[6]);
  const sz = Math.sqrt(matrix[8] * matrix[8] + matrix[9] * matrix[9] + matrix[10] * matrix[10]);

  return { center: [wx, wy, wz], radius: sphere.radius * Math.max(sx, sy, sz) };
}

// ── Frustum ──────────────────────────────────────────────────────────────────

/**
 * Six-plane camera frustum.
 *
 * Extract planes with `setFromViewProjection(viewProj)` and test objects with
 * `containsSphere()`.  The planes are stored normalized so radius comparisons
 * are direct dot-product tests.
 */
export class Frustum {
  // 6 planes × 4 floats each (a, b, c, d), plane normal (a,b,c) is unit length
  private readonly _planes = new Float32Array(24);
  private readonly _planeViews: readonly PlaneElements[] = Object.freeze([
    createPlaneView(this._planes, 0),
    createPlaneView(this._planes, 4),
    createPlaneView(this._planes, 8),
    createPlaneView(this._planes, 12),
    createPlaneView(this._planes, 16),
    createPlaneView(this._planes, 20),
  ]);

  /**
   * Populate the frustum planes from a combined view-projection matrix
   * (column-major Float32Array, WebGPU depth range [0, 1]).
   *
   * Uses the Gribb/Hartmann row-vector extraction method:
   *   Left:   row3 + row0      Right:  row3 - row0
   *   Bottom: row3 + row1      Top:    row3 - row1
   *   Near:   row2             Far:    row3 - row2
   */
  setFromViewProjection(m: Float32Array): this {
    const matrix = requireMatrix4(m, 'Frustum.setFromViewProjection');
    // column-major: row j = ( m[j], m[4+j], m[8+j], m[12+j] )
    this._writePlane(0, matrix[3]+matrix[0],  matrix[7]+matrix[4],  matrix[11]+matrix[8],  matrix[15]+matrix[12]); // left
    this._writePlane(1, matrix[3]-matrix[0],  matrix[7]-matrix[4],  matrix[11]-matrix[8],  matrix[15]-matrix[12]); // right
    this._writePlane(2, matrix[3]+matrix[1],  matrix[7]+matrix[5],  matrix[11]+matrix[9],  matrix[15]+matrix[13]); // bottom
    this._writePlane(3, matrix[3]-matrix[1],  matrix[7]-matrix[5],  matrix[11]-matrix[9],  matrix[15]-matrix[13]); // top
    this._writePlane(4, matrix[2],            matrix[6],            matrix[10],            matrix[14]);            // near
    this._writePlane(5, matrix[3]-matrix[2],  matrix[7]-matrix[6],  matrix[11]-matrix[10], matrix[15]-matrix[14]); // far
    return this;
  }

  /**
   * Populate the frustum from six explicit planes.
   * Each plane is [a, b, c, d] for ax + by + cz + d = 0, with normals pointing inward.
   */
  setFromPlanes(planes: ArrayLike<number>): this {
    if (planes.length < 24) {
      throw new EngineError(
        EngineErrorCode.GeometryInvalidParameter,
        'Frustum.setFromPlanes requires 24 numbers.',
        {
          hint: 'Pass six planes in [a,b,c,d] order, or use setFromViewProjection() for matrix extraction.',
          docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
        },
      );
    }
    for (let i = 0; i < 6; i++) {
      const b = i * 4;
      this._writePlane(
        i,
        requiredNumberAt(planes, b, 'frustum planes'),
        requiredNumberAt(planes, b + 1, 'frustum planes'),
        requiredNumberAt(planes, b + 2, 'frustum planes'),
        requiredNumberAt(planes, b + 3, 'frustum planes'),
      );
    }
    return this;
  }

  copyPlanesTo(out: Float32Array, offset = 0): Float32Array {
    out.set(this._planes, offset);
    return out;
  }

  /**
   * Returns true if the sphere is fully or partially inside the frustum.
   * Returns false only if the sphere is completely outside at least one plane.
   */
  containsSphere(sphere: BoundingSphere): boolean {
    const [cx, cy, cz] = sphere.center;
    const r = sphere.radius;
    for (const plane of this._planeViews) {
      if (plane[0] * cx + plane[1] * cy + plane[2] * cz + plane[3] < -r) return false;
    }
    return true;
  }

  containsPoint(point: readonly [number, number, number]): boolean {
    const [x, y, z] = point;
    for (const plane of this._planeViews) {
      if (plane[0] * x + plane[1] * y + plane[2] * z + plane[3] < 0) return false;
    }
    return true;
  }

  /**
   * Tighter mesh/frustum test for triangle-list Geometry3D.
   * mode='any': true if any triangle intersects the frustum.
   * mode='all': true only if every triangle is inside or intersects the frustum.
   */
  intersectsGeometry(
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    mode: GeometryFrustumTestMode = 'any',
  ): boolean {
    const positions = geometry.positions;
    if (positions.length < 9) return false;
    const matrix = requireMatrix4(worldMatrix, 'Frustum.intersectsGeometry');

    const indices = geometry.indices;
    if (indices) {
      for (let i = 0; i + 2 < indices.length; i += 3) {
        const intersects = this._triangleMayIntersect(
          positions,
          requiredNumberAt(indices, i, 'geometry indices') * 3,
          requiredNumberAt(indices, i + 1, 'geometry indices') * 3,
          requiredNumberAt(indices, i + 2, 'geometry indices') * 3,
          matrix,
        );
        if (mode === 'any' && intersects) {
          return true;
        }
        if (mode === 'all' && !intersects) return false;
      }
      return mode === 'all';
    }

    for (let i = 0; i + 8 < positions.length; i += 9) {
      const intersects = this._triangleMayIntersect(positions, i, i + 3, i + 6, matrix);
      if (mode === 'any' && intersects) {
        return true;
      }
      if (mode === 'all' && !intersects) return false;
    }
    return mode === 'all';
  }

  private _writePlane(i: number, a: number, b: number, c: number, d: number): void {
    const len = Math.sqrt(a * a + b * b + c * c);
    if (!Number.isFinite(len) || !Number.isFinite(d) || len < 1e-10) {
      throw frustumParameterError(
        `Frustum plane ${i} must contain a finite, non-zero normal and distance.`,
        'Check the source matrix or explicit [a, b, c, d] plane coefficients.',
      );
    }
    const inv  = 1 / len;
    const plane = this._planeViews[i];
    if (!plane) throw new RangeError(`Frustum plane index ${i} is outside [0, 5].`);
    plane[0] = a * inv;
    plane[1] = b * inv;
    plane[2] = c * inv;
    plane[3] = d * inv;
  }

  private _triangleMayIntersect(
    positions: Float32Array,
    ia: number,
    ib: number,
    ic: number,
    worldMatrix: RequiredMat4Array,
  ): boolean {
    const m = worldMatrix;
    const ax0 = requiredNumberAt(positions, ia, 'geometry positions');
    const ay0 = requiredNumberAt(positions, ia + 1, 'geometry positions');
    const az0 = requiredNumberAt(positions, ia + 2, 'geometry positions');
    const bx0 = requiredNumberAt(positions, ib, 'geometry positions');
    const by0 = requiredNumberAt(positions, ib + 1, 'geometry positions');
    const bz0 = requiredNumberAt(positions, ib + 2, 'geometry positions');
    const cx0 = requiredNumberAt(positions, ic, 'geometry positions');
    const cy0 = requiredNumberAt(positions, ic + 1, 'geometry positions');
    const cz0 = requiredNumberAt(positions, ic + 2, 'geometry positions');
    const ax = m[0] * ax0 + m[4] * ay0 + m[8]  * az0 + m[12];
    const ay = m[1] * ax0 + m[5] * ay0 + m[9]  * az0 + m[13];
    const az = m[2] * ax0 + m[6] * ay0 + m[10] * az0 + m[14];
    const bx = m[0] * bx0 + m[4] * by0 + m[8]  * bz0 + m[12];
    const by = m[1] * bx0 + m[5] * by0 + m[9]  * bz0 + m[13];
    const bz = m[2] * bx0 + m[6] * by0 + m[10] * bz0 + m[14];
    const cx = m[0] * cx0 + m[4] * cy0 + m[8]  * cz0 + m[12];
    const cy = m[1] * cx0 + m[5] * cy0 + m[9]  * cz0 + m[13];
    const cz = m[2] * cx0 + m[6] * cy0 + m[10] * cz0 + m[14];
    for (const plane of this._planeViews) {
      const da = plane[0] * ax + plane[1] * ay + plane[2] * az + plane[3];
      const db = plane[0] * bx + plane[1] * by + plane[2] * bz + plane[3];
      const dc = plane[0] * cx + plane[1] * cy + plane[2] * cz + plane[3];
      if (da < 0 && db < 0 && dc < 0) return false;
    }
    return true;
  }
}

function requireMatrix4(matrix: Float32Array, operation: string): RequiredMat4Array {
  if (matrix.length < 16) {
    throw frustumParameterError(
      `${operation} requires a 4x4 matrix with at least 16 elements; received ${matrix.length}.`,
      'Pass a column-major Float32Array containing a complete 4x4 matrix.',
    );
  }
  return requiredMat4Array(matrix, operation);
}

function createPlaneView(buffer: Float32Array, offset: number): PlaneElements {
  const view = buffer.subarray(offset, offset + 4);
  if (view.length !== 4) throw new RangeError(`Cannot create a four-element frustum plane view at offset ${offset}.`);
  return view as PlaneElements;
}

function frustumParameterError(message: string, hint: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    { hint, docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER' },
  );
}
