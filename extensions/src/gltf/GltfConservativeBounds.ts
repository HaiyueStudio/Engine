import type { Geometry3DLocalBounds } from '@haiyue/engine/geometry';
import type { GltfAccessor, GltfAsset, GltfPrimitive } from './GltfSchema';

interface Bounds3 {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

interface JointUsage {
  readonly joints: Set<number>;
  readonly includeSource: boolean;
}

/**
 * Keeps the accessor evidence needed to derive conservative bounds for the
 * current morph weights and skin matrices. Missing evidence returns null so
 * Render3D keeps its fail-open culling behavior.
 */
export class GltfConservativeBounds {
  private _current: Bounds3 | null;
  private _skinUsageCache: {
    jointCount: number;
    joints: Float32Array | undefined;
    weights: Float32Array | undefined;
    usage: JointUsage | null;
  } | null = null;

  private constructor(
    private readonly _base: Bounds3,
    private readonly _positionTargets: readonly (Bounds3 | null)[],
  ) {
    this._current = _base;
  }

  static fromPrimitive(gltf: GltfAsset, primitive: GltfPrimitive): GltfConservativeBounds | null {
    const positionAccessorIndex = primitive.attributes.POSITION;
    if (positionAccessorIndex === undefined) return null;
    const base = readVec3Bounds(gltf.accessors?.[positionAccessorIndex]);
    if (!base) return null;
    const positionTargets = (primitive.targets ?? []).map(target => {
      if (target.POSITION === undefined) return ZERO_BOUNDS;
      return readVec3Bounds(gltf.accessors?.[target.POSITION]);
    });
    return new GltfConservativeBounds(base, positionTargets);
  }

  updateMorphWeights(weights: ArrayLike<number>): Geometry3DLocalBounds | null {
    const min: [number, number, number] = [...this._base.min];
    const max: [number, number, number] = [...this._base.max];
    for (let targetIndex = 0; targetIndex < this._positionTargets.length; targetIndex++) {
      const weight = weights[targetIndex] ?? 0;
      if (!Number.isFinite(weight)) {
        this._current = null;
        return null;
      }
      if (weight === 0) continue;
      const target = this._positionTargets[targetIndex];
      if (!target) {
        this._current = null;
        return null;
      }
      for (let axis = 0; axis < 3; axis++) {
        const targetMin = target.min[axis];
        const targetMax = target.max[axis];
        const currentMin = min[axis];
        const currentMax = max[axis];
        if (targetMin === undefined || targetMax === undefined || currentMin === undefined || currentMax === undefined) {
          this._current = null;
          return null;
        }
        const a = targetMin * weight;
        const b = targetMax * weight;
        min[axis] = currentMin + Math.min(a, b);
        max[axis] = currentMax + Math.max(a, b);
      }
    }
    this._current = { min, max };
    return boundsToSphere(this._current);
  }

  getSourceBounds(): Geometry3DLocalBounds | null {
    return this._current ? boundsToSphere(this._current) : null;
  }

  getSkinnedBounds(
    jointMatrices: Float32Array,
    joints?: Float32Array,
    weights?: Float32Array,
  ): Geometry3DLocalBounds | null {
    if (!this._current || jointMatrices.length === 0 || jointMatrices.length % 16 !== 0) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const jointCount = jointMatrices.length / 16;
    let usage: JointUsage | null;
    if (this._skinUsageCache
      && this._skinUsageCache.jointCount === jointCount
      && this._skinUsageCache.joints === joints
      && this._skinUsageCache.weights === weights) {
      usage = this._skinUsageCache.usage;
    } else {
      usage = collectJointUsage(jointCount, joints, weights);
      this._skinUsageCache = { jointCount, joints, weights, usage };
    }
    if (!usage) return null;
    if (usage.includeSource) includeBounds(min, max, this._current);
    for (const jointIndex of usage.joints) {
      if (!includeTransformedBounds(min, max, this._current, jointMatrices, jointIndex * 16)) return null;
    }
    return boundsToSphere({ min, max });
  }
}

function collectJointUsage(
  jointCount: number,
  joints: Float32Array | undefined,
  weights: Float32Array | undefined,
): JointUsage | null {
  if (!joints || !weights || joints.length !== weights.length || joints.length % 4 !== 0) {
    return { joints: new Set(Array.from({ length: jointCount }, (_, index) => index)), includeSource: true };
  }
  const used = new Set<number>();
  let includeSource = false;
  for (let vertexOffset = 0; vertexOffset < joints.length; vertexOffset += 4) {
    let weightSum = 0;
    for (let influence = 0; influence < 4; influence++) {
      const offset = vertexOffset + influence;
      const weight = weights[offset];
      const joint = joints[offset];
      if (weight === undefined || joint === undefined
        || !Number.isFinite(weight) || !Number.isInteger(joint) || joint < 0 || joint >= jointCount) return null;
      if (weight <= 0) continue;
      used.add(joint);
      weightSum += weight;
    }
    if (weightSum <= 0) includeSource = true;
  }
  if (used.size === 0) includeSource = true;
  return { joints: used, includeSource };
}

function readVec3Bounds(accessor: GltfAccessor | undefined): Bounds3 | null {
  if (!accessor || accessor.type !== 'VEC3') return null;
  const min = accessor.min;
  const max = accessor.max;
  if (!min || !max || min.length !== 3 || max.length !== 3) return null;
  if (![...min, ...max].every(Number.isFinite)) return null;
  const [minX, minY, minZ] = min;
  const [maxX, maxY, maxZ] = max;
  if (minX === undefined || minY === undefined || minZ === undefined
    || maxX === undefined || maxY === undefined || maxZ === undefined) return null;
  if (minX > maxX || minY > maxY || minZ > maxZ) return null;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

function includeTransformedBounds(
  outMin: [number, number, number],
  outMax: [number, number, number],
  bounds: Bounds3,
  matrix: Float32Array,
  offset: number,
): boolean {
  if (offset < 0 || offset + 15 >= matrix.length) return false;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.max[0] : bounds.min[0];
    const y = corner & 2 ? bounds.max[1] : bounds.min[1];
    const z = corner & 4 ? bounds.max[2] : bounds.min[2];
    const tx = (matrix[offset] ?? NaN) * x + (matrix[offset + 4] ?? NaN) * y + (matrix[offset + 8] ?? NaN) * z + (matrix[offset + 12] ?? NaN);
    const ty = (matrix[offset + 1] ?? NaN) * x + (matrix[offset + 5] ?? NaN) * y + (matrix[offset + 9] ?? NaN) * z + (matrix[offset + 13] ?? NaN);
    const tz = (matrix[offset + 2] ?? NaN) * x + (matrix[offset + 6] ?? NaN) * y + (matrix[offset + 10] ?? NaN) * z + (matrix[offset + 14] ?? NaN);
    if (![tx, ty, tz].every(Number.isFinite)) return false;
    outMin[0] = Math.min(outMin[0], tx);
    outMin[1] = Math.min(outMin[1], ty);
    outMin[2] = Math.min(outMin[2], tz);
    outMax[0] = Math.max(outMax[0], tx);
    outMax[1] = Math.max(outMax[1], ty);
    outMax[2] = Math.max(outMax[2], tz);
  }
  return true;
}

function includeBounds(
  outMin: [number, number, number],
  outMax: [number, number, number],
  bounds: Bounds3,
): void {
  for (let axis = 0; axis < 3; axis++) {
    const currentMin = outMin[axis];
    const currentMax = outMax[axis];
    const boundsMin = bounds.min[axis];
    const boundsMax = bounds.max[axis];
    if (currentMin === undefined || currentMax === undefined || boundsMin === undefined || boundsMax === undefined) continue;
    outMin[axis] = Math.min(currentMin, boundsMin);
    outMax[axis] = Math.max(currentMax, boundsMax);
  }
}

function boundsToSphere(bounds: Bounds3): Geometry3DLocalBounds {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  return {
    center,
    radius: Math.hypot(
      bounds.max[0] - center[0],
      bounds.max[1] - center[1],
      bounds.max[2] - center[2],
    ),
  };
}

const ZERO_BOUNDS: Bounds3 = Object.freeze({
  min: Object.freeze([0, 0, 0] as [number, number, number]),
  max: Object.freeze([0, 0, 0] as [number, number, number]),
});
