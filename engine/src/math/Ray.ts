import { mat4, vec3 } from 'wgpu-matrix';
import { Geometry3D } from '../geometry/Geometry3D';
import { getGeometryBVH, getRaycastBVHTrace, type BVHNode } from './RaycastBVH';
import {
  requiredItemAt,
  requiredMat4Array,
  requiredNumberAt,
  requiredVec3Array,
  type RequiredMat4Array,
  type RequiredVec3Array,
} from './arrayAccess';

export interface RayHit {
  distance: number;
  point: Float32Array;
  normal: Float32Array;
}

export interface RayIntersectMeshOptions {
  /** Use a cached local-space BVH for triangle tests. Defaults to true. */
  useBVH?: boolean;
  /** Optional per-call counters, reset even on a miss. Excludes BVH construction. */
  stats?: {
    /** Actual narrow-phase triangle intersection tests. */
    triangleTests: number;
    /** Mesh broad-phase plus BVH node bounding-box tests. */
    boundingBoxTests: number;
  };
}

const EPSILON = 1e-7;

// ---------------------------------------------------------------------------
// Internal helpers (avoid extra allocations in hot path where possible)
// ---------------------------------------------------------------------------

/** Multiply 3-component direction by upper-3×3 of a column-major mat4 (no translation, no w). */
function mulDir(d: RequiredVec3Array, m: RequiredMat4Array, out: RequiredVec3Array): RequiredVec3Array {
  out[0] = m[0] * d[0] + m[4] * d[1] + m[8]  * d[2];
  out[1] = m[1] * d[0] + m[5] * d[1] + m[9]  * d[2];
  out[2] = m[2] * d[0] + m[6] * d[1] + m[10] * d[2];
  return out;
}

/** Transform a local normal by transpose(inverse(world)) without allocating a matrix. */
function mulNormal(
  normal: RequiredVec3Array,
  inverseWorld: RequiredMat4Array,
  out: RequiredVec3Array,
): RequiredVec3Array {
  out[0] = inverseWorld[0] * normal[0] + inverseWorld[1] * normal[1] + inverseWorld[2] * normal[2];
  out[1] = inverseWorld[4] * normal[0] + inverseWorld[5] * normal[1] + inverseWorld[6] * normal[2];
  out[2] = inverseWorld[8] * normal[0] + inverseWorld[9] * normal[1] + inverseWorld[10] * normal[2];
  return out;
}

function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

function normLen(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function intersectAABB(
  min: RequiredVec3Array,
  max: RequiredVec3Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance = Infinity,
): boolean {
  let tMin = -Infinity;
  let tMax = Infinity;
  const axis = (origin: number, dir: number, axisMin: number, axisMax: number): boolean => {
    if (Math.abs(dir) < EPSILON) return origin >= axisMin && origin <= axisMax;
    const inv = 1 / dir;
    const t1 = (axisMin - origin) * inv;
    const t2 = (axisMax - origin) * inv;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    return true;
  };
  if (!axis(ox, dx, min[0], max[0])) return false;
  if (!axis(oy, dy, min[1], max[1])) return false;
  if (!axis(oz, dz, min[2], max[2])) return false;
  return tMax >= 0 && tMin <= tMax && tMin <= maxDistance;
}

// ---------------------------------------------------------------------------

export class Ray {
  static useBVH = true;

  origin: Float32Array = new Float32Array(3);
  direction: Float32Array = new Float32Array([0, 0, -1]);
  private readonly _invWorld = requiredMat4Array(mat4.identity() as Float32Array, 'inverse world matrix');
  private readonly _localOrigin = requiredVec3Array(new Float32Array(3), 'local ray origin');
  private readonly _localDirRaw = requiredVec3Array(new Float32Array(3), 'raw local ray direction');
  private readonly _localDir = requiredVec3Array(new Float32Array(3), 'local ray direction');
  private readonly _localHit = requiredVec3Array(new Float32Array(3), 'local ray hit');
  private readonly _unprojectInput = requiredVec3Array(new Float32Array(3), 'unprojected ray input');
  private readonly _unprojectWorld = requiredVec3Array(new Float32Array(3), 'unprojected ray point');
  private readonly _worldHitScratch = requiredVec3Array(new Float32Array(3), 'world ray hit');
  private readonly _worldNormalScratch = requiredVec3Array(new Float32Array(3), 'world ray normal scratch');
  private readonly _worldNormalResult = requiredVec3Array(new Float32Array(3), 'world ray normal');
  private readonly _bvhStack: BVHNode[] = [];

  /**
   * Initialise from a canvas pointer position.
   * Supports perspective and orthographic projections, including reverseZ.
   * Orthographic rays start on the camera plane and remain parallel.
   *
   * @param ndcX  [-1, 1] horizontal NDC
   * @param ndcY  [-1, 1] vertical NDC  (1 = top)
   * @param camWorldPos  Camera world position (worldMatrix column 3)
   * @param invViewProj  inverse(projection × view)
   */
  setFromCamera(
    ndcX: number,
    ndcY: number,
    camWorldPos: Float32Array,
    invViewProj: Float32Array,
  ): this {
    const cameraPosition = requiredVec3Array(camWorldPos, 'camera world position');
    const inverseViewProjection = requiredMat4Array(invViewProj, 'inverse view-projection matrix');
    const rayOrigin = requiredVec3Array(this.origin, 'ray origin');
    const rayDirection = requiredVec3Array(this.direction, 'ray direction');
    // Unproject any NDC-z value to get a world-space point on the ray.
    // Using z=0.5 avoids precision extremes at 0 and 1.
    const unprojectInput = this._unprojectInput;
    unprojectInput[0] = ndcX;
    unprojectInput[1] = ndcY;
    unprojectInput[2] = 0.5;
    const wp = requiredVec3Array(
      vec3.transformMat4(unprojectInput, inverseViewProjection, this._unprojectWorld) as Float32Array,
      'unprojected ray point',
    );
    rayOrigin[0] = cameraPosition[0];
    rayOrigin[1] = cameraPosition[1];
    rayOrigin[2] = cameraPosition[2];
    let dx = wp[0] - cameraPosition[0];
    let dy = wp[1] - cameraPosition[1];
    let dz = wp[2] - cameraPosition[2];
    // An orthographic inverse has a constant homogeneous w. Its screen-right
    // and screen-up columns determine forward (-Z), independently of the depth
    // mapping. In particular, reverseZ and a negative near plane must not flip
    // the ray. Perspective rays retain the camera position as their origin.
    if (inverseViewProjection[3] === 0 && inverseViewProjection[7] === 0 && inverseViewProjection[11] === 0) {
      const m = inverseViewProjection;
      dx = m[2] * m[5] - m[1] * m[6];
      dy = m[0] * m[6] - m[2] * m[4];
      dz = m[1] * m[4] - m[0] * m[5];
      const squaredLength = dx * dx + dy * dy + dz * dz;
      const depth = ((wp[0] - cameraPosition[0]) * dx + (wp[1] - cameraPosition[1]) * dy + (wp[2] - cameraPosition[2]) * dz) / squaredLength;
      rayOrigin[0] = wp[0] - dx * depth;
      rayOrigin[1] = wp[1] - dy * depth;
      rayOrigin[2] = wp[2] - dz * depth;
    }
    const len = normLen(dx, dy, dz);
    if (!Number.isFinite(len) || len < EPSILON || !rayOrigin.every(Number.isFinite)) {
      throw new RangeError('Ray.setFromCamera could not derive a finite non-zero direction.');
    }
    rayDirection[0] = dx / len;
    rayDirection[1] = dy / len;
    rayDirection[2] = dz / len;
    return this;
  }

  /**
   * Ray vs mesh intersection test.
   * Transforms the ray into the object's local space, runs an AABB broad-phase,
   * then tests every triangle with Möller–Trumbore.
   * Returns the closest front-face hit or null.
   */
  intersectMesh(
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    options: RayIntersectMeshOptions = {},
    outResult?: RayHit,
  ): RayHit | null {
    const stats = options.stats;
    const trace = getRaycastBVHTrace(this);
    if (stats) {
      stats.triangleTests = 0;
      stats.boundingBoxTests = 0;
    }
    const matrix = requiredMat4Array(worldMatrix, 'mesh world matrix');
    const rayOrigin = requiredVec3Array(this.origin, 'ray origin');
    const rayDirection = requiredVec3Array(this.direction, 'ray direction');
    const invWorld = requiredMat4Array(
      mat4.inverse(matrix, this._invWorld) as Float32Array,
      'inverse mesh world matrix',
    );

    // Ray in local space
    const lo = requiredVec3Array(
      vec3.transformMat4(rayOrigin, invWorld, this._localOrigin) as Float32Array,
      'local ray origin',
    );
    const ldRaw = mulDir(rayDirection, invWorld, this._localDirRaw);
    const ldLen = normLen(ldRaw[0], ldRaw[1], ldRaw[2]);
    if (!Number.isFinite(ldLen) || ldLen < EPSILON) return null;
    const ld = this._localDir;
    ld[0] = ldRaw[0] / ldLen;
    ld[1] = ldRaw[1] / ldLen;
    ld[2] = ldRaw[2] / ldLen;

    // ── Broad phase: AABB slab test ──────────────────────────────────────
    const { min, max } = geometry.getBoundingBox();
    const boundsMin = requiredVec3Array(min, 'geometry bounding-box minimum');
    const boundsMax = requiredVec3Array(max, 'geometry bounding-box maximum');
    if (stats) stats.boundingBoxTests++;
    const boundsAccepted = intersectAABB(boundsMin, boundsMax, lo[0], lo[1], lo[2], ld[0], ld[1], ld[2]);
    trace?.bounds(boundsAccepted);
    if (!boundsAccepted) return null;

    // ── Narrow phase: Möller–Trumbore per triangle ───────────────────────
    const pos = geometry.positions;
    const idx_ = geometry.indices;
    let minT = Infinity;
    let hitNx = 0, hitNy = 0, hitNz = 0;

    const lox = lo[0], loy = lo[1], loz = lo[2];
    const ldx = ld[0], ldy = ld[1], ldz = ld[2];

    const testTri = (ia: number, ib: number, ic: number) => {
      if (stats) stats.triangleTests++;
      const ax = requiredNumberAt(pos, ia * 3, 'geometry positions');
      const ay = requiredNumberAt(pos, ia * 3 + 1, 'geometry positions');
      const az = requiredNumberAt(pos, ia * 3 + 2, 'geometry positions');
      const bx = requiredNumberAt(pos, ib * 3, 'geometry positions');
      const by = requiredNumberAt(pos, ib * 3 + 1, 'geometry positions');
      const bz = requiredNumberAt(pos, ib * 3 + 2, 'geometry positions');
      const cx = requiredNumberAt(pos, ic * 3, 'geometry positions');
      const cy = requiredNumberAt(pos, ic * 3 + 1, 'geometry positions');
      const cz = requiredNumberAt(pos, ic * 3 + 2, 'geometry positions');

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

      const hx = ldy * e2z - ldz * e2y;
      const hy = ldz * e2x - ldx * e2z;
      const hz = ldx * e2y - ldy * e2x;
      const det = dot(e1x, e1y, e1z, hx, hy, hz);
      if (Math.abs(det) < EPSILON) return;

      const invDet = 1 / det;
      const sx = lox - ax, sy = loy - ay, sz = loz - az;
      const u = invDet * dot(sx, sy, sz, hx, hy, hz);
      if (u < 0 || u > 1) return;

      const qx = sy * e1z - sz * e1y;
      const qy = sz * e1x - sx * e1z;
      const qz = sx * e1y - sy * e1x;
      const v = invDet * dot(ldx, ldy, ldz, qx, qy, qz);
      if (v < 0 || u + v > 1) return;

      const t = invDet * dot(e2x, e2y, e2z, qx, qy, qz);
      if (t < EPSILON || t >= minT) return;

      minT = t;
      // Face normal (CCW winding)
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nl = normLen(nx, ny, nz);
      hitNx = nx / nl; hitNy = ny / nl; hitNz = nz / nl;
    };

    const useBVH = options.useBVH ?? Ray.useBVH;
    if (useBVH) {
      const bvh = getGeometryBVH(geometry);
      const stack = this._bvhStack;
      stack.length = 0;
      stack.push(bvh.root);
      while (stack.length) {
        const node = stack.pop();
        if (!node) break;
        if (stats) stats.boundingBoxTests++;
        const accepted = intersectAABB(node.min, node.max, lox, loy, loz, ldx, ldy, ldz, minT);
        trace?.node(node, accepted);
        if (!accepted) continue;
        if (!node.left && !node.right) {
          for (let i = node.start; i < node.end; i++) {
            const tri = requiredItemAt(bvh.triangles, i, 'BVH triangles');
            testTri(tri.ia, tri.ib, tri.ic);
          }
        } else {
          if (node.left) stack.push(node.left);
          if (node.right) stack.push(node.right);
        }
      }
    } else if (idx_) {
      for (let i = 0; i + 2 < idx_.length; i += 3) {
        testTri(
          requiredNumberAt(idx_, i, 'geometry indices'),
          requiredNumberAt(idx_, i + 1, 'geometry indices'),
          requiredNumberAt(idx_, i + 2, 'geometry indices'),
        );
      }
    } else {
      const n = pos.length / 3;
      for (let i = 0; i + 2 < n; i += 3) testTri(i, i + 1, i + 2);
    }

    if (minT === Infinity) return null;

    // Local hit point → world space
    const localHit = this._localHit;
    localHit[0] = lox + ldx * minT;
    localHit[1] = loy + ldy * minT;
    localHit[2] = loz + ldz * minT;
    const worldHit = requiredVec3Array(
      vec3.transformMat4(localHit, matrix, this._worldHitScratch) as Float32Array,
      'world ray hit',
    );

    // Normal: transpose(inverse(world)) upper-3×3, then re-normalise.
    const localNormal = this._localDirRaw;
    localNormal[0] = hitNx;
    localNormal[1] = hitNy;
    localNormal[2] = hitNz;
    const wn = mulNormal(localNormal, invWorld, this._worldNormalScratch);
    const wnLen = normLen(wn[0], wn[1], wn[2]);
    if (!Number.isFinite(wnLen) || wnLen < EPSILON) return null;
    const worldNormal = this._worldNormalResult;
    worldNormal[0] = wn[0] / wnLen;
    worldNormal[1] = wn[1] / wnLen;
    worldNormal[2] = wn[2] / wnLen;

    const dx = worldHit[0] - rayOrigin[0];
    const dy = worldHit[1] - rayOrigin[1];
    const dz = worldHit[2] - rayOrigin[2];

    const distance = normLen(dx, dy, dz);
    if (outResult) {
      outResult.distance = distance;
      outResult.point.set(worldHit);
      outResult.normal.set(worldNormal);
      return outResult;
    }
    return { distance, point: worldHit, normal: worldNormal };
  }
}
