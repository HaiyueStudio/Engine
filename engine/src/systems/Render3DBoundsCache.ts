import type { Geometry3D } from '../geometry/Geometry3D';
import { computeBoundingSphere, type BoundingSphere } from '../culling/Frustum';

interface MutableBoundingSphere extends BoundingSphere {
  center: [number, number, number];
}

interface BoundingSphereCacheEntry {
  geometryVersion: number;
  lastUsedFrame: number;
  localSphere: BoundingSphere;
}

/**
 * Owns the versioning and frame-lifetime contract for Render3D local bounds.
 * Render3DSystem supplies the frame id; this cache decides when bounds must be
 * recomputed and when geometry that left the scene can be released.
 */
export class Render3DBoundsCache {
  private readonly _entries = new Map<number, BoundingSphereCacheEntry>();

  get size(): number {
    return this._entries.size;
  }

  has(geometryId: number): boolean {
    return this._entries.has(geometryId);
  }

  getWorldSphere(
    geometry: Geometry3D,
    worldMatrix: Float32Array,
    frame: number,
    target?: MutableBoundingSphere,
  ): BoundingSphere | null {
    if (geometry.vertexCount === 0) {
      this._entries.delete(geometry.id);
      return null;
    }
    if (geometry.boundsMode !== 'static') {
      this._entries.delete(geometry.id);
      return geometry.localBounds ? transformBoundingSphereInto(geometry.localBounds, worldMatrix, target) : null;
    }
    let cached = this._entries.get(geometry.id);
    if (!cached || cached.geometryVersion !== geometry.version) {
      cached = {
        geometryVersion: geometry.version,
        lastUsedFrame: frame,
        localSphere: computeBoundingSphere(geometry.positions),
      };
      this._entries.set(geometry.id, cached);
    } else {
      cached.lastUsedFrame = frame;
    }
    return transformBoundingSphereInto(cached.localSphere, worldMatrix, target);
  }

  sweep(frame: number): void {
    for (const [geometryId, cached] of this._entries) {
      if (cached.lastUsedFrame !== frame) this._entries.delete(geometryId);
    }
  }

  clear(): void {
    this._entries.clear();
  }
}

function transformBoundingSphereInto(
  sphere: BoundingSphere,
  matrix: Float32Array,
  target?: MutableBoundingSphere,
): BoundingSphere {
  const result = target ?? { center: [0, 0, 0], radius: 0 };
  const center = result.center;
  const lx = sphere.center[0];
  const ly = sphere.center[1];
  const lz = sphere.center[2];
  center[0] = (matrix[0] ?? 1) * lx + (matrix[4] ?? 0) * ly + (matrix[8] ?? 0) * lz + (matrix[12] ?? 0);
  center[1] = (matrix[1] ?? 0) * lx + (matrix[5] ?? 1) * ly + (matrix[9] ?? 0) * lz + (matrix[13] ?? 0);
  center[2] = (matrix[2] ?? 0) * lx + (matrix[6] ?? 0) * ly + (matrix[10] ?? 1) * lz + (matrix[14] ?? 0);
  const scaleX = Math.hypot(matrix[0] ?? 1, matrix[1] ?? 0, matrix[2] ?? 0);
  const scaleY = Math.hypot(matrix[4] ?? 0, matrix[5] ?? 1, matrix[6] ?? 0);
  const scaleZ = Math.hypot(matrix[8] ?? 0, matrix[9] ?? 0, matrix[10] ?? 1);
  result.radius = sphere.radius * Math.max(scaleX, scaleY, scaleZ);
  return result;
}
