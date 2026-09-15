import type { Geometry3D } from '../geometry/Geometry3D';
import type { Ray, RayHit } from './Ray';
import { getGeometryBVH, withRaycastBVHTrace, type BVHNode } from './RaycastBVH';

/** Detached local-space topology; IDs are stable until the geometry BVH is rebuilt. */
export interface RaycastBVHSnapshot {
  readonly geometryVersion: number;
  readonly nodes: readonly {
    readonly id: number;
    readonly depth: number;
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly left: number | null;
    readonly right: number | null;
    /** Half-open range in triangleIndices, measured in triangles (not indices). */
    readonly start: number;
    readonly end: number;
  }[];
  /** Source vertex indices, three per triangle, in the cached BVH's actual sorted order. */
  readonly triangleIndices: readonly number[];
}

export interface RaycastBVHTrace {
  readonly snapshot: RaycastBVHSnapshot;
  readonly broadPhaseHit: boolean;
  /** Actual traversal order. A rejection may be a spatial miss or closest-hit pruning. */
  readonly steps: readonly { readonly nodeId: number; readonly accepted: boolean }[];
  readonly triangleTests: number;
  readonly boundingBoxTests: number;
  /** Caller-owned world-space hit buffers, never the ray's reusable scratch buffers. */
  readonly hit: RayHit | null;
}

export interface RaycastBVHInspector {
  /** Builds/reuses the same cache that Ray.intersectMesh uses. Refreshes after markDirty(). */
  getSnapshot(): RaycastBVHSnapshot;
  /** Executes the production BVH query with optional diagnostics attached only for this call. */
  trace(ray: Ray, worldMatrix: Float32Array): RaycastBVHTrace;
}

/** Experimental visualization/debugging adapter; no mutable BVH/cache internals escape. */
export function createRaycastBVHInspector(geometry: Geometry3D): RaycastBVHInspector {
  let cached: ReturnType<typeof getGeometryBVH> | undefined;
  let snapshot: RaycastBVHSnapshot;
  const ids = new Map<BVHNode, number>();

  function getSnapshot(): RaycastBVHSnapshot {
    const bvh = getGeometryBVH(geometry);
    if (cached === bvh) return snapshot;
    const nodes: Array<RaycastBVHSnapshot['nodes'][number]> = [];
    ids.clear();
    const visit = (node: BVHNode, depth: number): number => {
      const id = nodes.length;
      ids.set(node, id);
      const record = {
        id, depth,
        min: Object.freeze([node.min[0], node.min[1], node.min[2]] as const),
        max: Object.freeze([node.max[0], node.max[1], node.max[2]] as const),
        left: null as number | null, right: null as number | null,
        start: node.start, end: node.end,
      };
      nodes.push(record);
      if (node.left) record.left = visit(node.left, depth + 1);
      if (node.right) record.right = visit(node.right, depth + 1);
      Object.freeze(record);
      return id;
    };
    if (bvh.triangles.length) visit(bvh.root, 0);
    snapshot = Object.freeze({
      geometryVersion: bvh.geometryVersion,
      nodes: Object.freeze(nodes),
      triangleIndices: Object.freeze(bvh.triangles.flatMap(tri => [tri.ia, tri.ib, tri.ic])),
    });
    cached = bvh;
    return snapshot;
  }

  return Object.freeze({
    getSnapshot,
    trace(ray: Ray, worldMatrix: Float32Array): RaycastBVHTrace {
      const snapshot = getSnapshot();
      const steps: Array<RaycastBVHTrace['steps'][number]> = [];
      const stats = { triangleTests: 0, boundingBoxTests: 0 };
      const result: RayHit = { distance: 0, point: new Float32Array(3), normal: new Float32Array(3) };
      let broadPhaseHit = false;
      const hit = withRaycastBVHTrace(ray, {
        bounds(accepted) { broadPhaseHit = accepted; },
        node(node, accepted) {
          const nodeId = ids.get(node);
          if (nodeId === undefined) throw new Error('Raycast BVH trace does not match its snapshot.');
          steps.push(Object.freeze({ nodeId, accepted }));
        },
      }, () => ray.intersectMesh(geometry, worldMatrix, { useBVH: true, stats }, result));
      return Object.freeze({ snapshot, broadPhaseHit, steps: Object.freeze(steps), ...stats, hit });
    },
  });
}
