import type { Geometry3D } from '../geometry/Geometry3D';
import { requiredItemAt, requiredNumberAt, requiredVec3Array, type RequiredVec3Array } from './arrayAccess';

const BVH_LEAF_TRIANGLES = 8;

interface RaycastTriangle {
  ia: number;
  ib: number;
  ic: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  cx: number;
  cy: number;
  cz: number;
}

export interface BVHNode {
  min: RequiredVec3Array;
  max: RequiredVec3Array;
  left: BVHNode | null;
  right: BVHNode | null;
  start: number;
  end: number;
}

interface GeometryBVH {
  positions: Float32Array;
  indices: Uint16Array | Uint32Array | null;
  geometryVersion: number;
  triangles: RaycastTriangle[];
  root: BVHNode;
}

const geometryBVHCache = new WeakMap<Geometry3D, GeometryBVH>();

function createTriangle(positions: Float32Array, ia: number, ib: number, ic: number): RaycastTriangle {
  const ax = requiredNumberAt(positions, ia * 3, 'geometry positions');
  const ay = requiredNumberAt(positions, ia * 3 + 1, 'geometry positions');
  const az = requiredNumberAt(positions, ia * 3 + 2, 'geometry positions');
  const bx = requiredNumberAt(positions, ib * 3, 'geometry positions');
  const by = requiredNumberAt(positions, ib * 3 + 1, 'geometry positions');
  const bz = requiredNumberAt(positions, ib * 3 + 2, 'geometry positions');
  const cx = requiredNumberAt(positions, ic * 3, 'geometry positions');
  const cy = requiredNumberAt(positions, ic * 3 + 1, 'geometry positions');
  const cz = requiredNumberAt(positions, ic * 3 + 2, 'geometry positions');
  const minX = Math.min(ax, bx, cx), minY = Math.min(ay, by, cy), minZ = Math.min(az, bz, cz);
  const maxX = Math.max(ax, bx, cx), maxY = Math.max(ay, by, cy), maxZ = Math.max(az, bz, cz);
  return {
    ia, ib, ic,
    minX, minY, minZ,
    maxX, maxY, maxZ,
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    cz: (minZ + maxZ) * 0.5,
  };
}

type TriangleCenterAxis = 'cx' | 'cy' | 'cz';

function sortTriangleRange(
  triangles: RaycastTriangle[],
  start: number,
  end: number,
  axis: TriangleCenterAxis,
): void {
  const insertionSort = (lo: number, hi: number) => {
    for (let i = lo + 1; i < hi; i++) {
      const item = requiredItemAt(triangles, i, 'BVH triangles');
      let j = i - 1;
      while (j >= lo && requiredItemAt(triangles, j, 'BVH triangles')[axis] > item[axis]) {
        triangles[j + 1] = requiredItemAt(triangles, j, 'BVH triangles');
        j -= 1;
      }
      triangles[j + 1] = item;
    }
  };

  const quickSort = (lo: number, hi: number) => {
    while (hi - lo > 16) {
      const mid = (lo + hi) >> 1;
      const pivot = requiredItemAt(triangles, mid, 'BVH triangles')[axis];
      let i = lo;
      let j = hi - 1;
      while (i <= j) {
        while (requiredItemAt(triangles, i, 'BVH triangles')[axis] < pivot) i += 1;
        while (requiredItemAt(triangles, j, 'BVH triangles')[axis] > pivot) j -= 1;
        if (i <= j) {
          const tmp = requiredItemAt(triangles, i, 'BVH triangles');
          triangles[i] = requiredItemAt(triangles, j, 'BVH triangles');
          triangles[j] = tmp;
          i += 1;
          j -= 1;
        }
      }
      if (j - lo < hi - i) {
        if (lo < j + 1) quickSort(lo, j + 1);
        lo = i;
      } else {
        if (i < hi) quickSort(i, hi);
        hi = j + 1;
      }
    }
    insertionSort(lo, hi);
  };

  quickSort(start, end);
}

function buildBVHNode(triangles: RaycastTriangle[], start: number, end: number): BVHNode {
  const min = requiredVec3Array(new Float32Array([Infinity, Infinity, Infinity]), 'BVH minimum');
  const max = requiredVec3Array(new Float32Array([-Infinity, -Infinity, -Infinity]), 'BVH maximum');
  let cminX = Infinity, cminY = Infinity, cminZ = Infinity;
  let cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;

  for (let i = start; i < end; i++) {
    const tri = requiredItemAt(triangles, i, 'BVH triangles');
    if (tri.minX < min[0]) min[0] = tri.minX;
    if (tri.minY < min[1]) min[1] = tri.minY;
    if (tri.minZ < min[2]) min[2] = tri.minZ;
    if (tri.maxX > max[0]) max[0] = tri.maxX;
    if (tri.maxY > max[1]) max[1] = tri.maxY;
    if (tri.maxZ > max[2]) max[2] = tri.maxZ;
    if (tri.cx < cminX) cminX = tri.cx;
    if (tri.cy < cminY) cminY = tri.cy;
    if (tri.cz < cminZ) cminZ = tri.cz;
    if (tri.cx > cmaxX) cmaxX = tri.cx;
    if (tri.cy > cmaxY) cmaxY = tri.cy;
    if (tri.cz > cmaxZ) cmaxZ = tri.cz;
  }

  if (end - start <= BVH_LEAF_TRIANGLES) {
    return { min, max, left: null, right: null, start, end };
  }

  const spanX = cmaxX - cminX;
  const spanY = cmaxY - cminY;
  const spanZ = cmaxZ - cminZ;
  const axis = spanX >= spanY && spanX >= spanZ ? 'cx' : spanY >= spanZ ? 'cy' : 'cz';
  sortTriangleRange(triangles, start, end, axis);
  const mid = (start + end) >> 1;
  if (mid <= start || mid >= end) {
    return { min, max, left: null, right: null, start, end };
  }

  return {
    min,
    max,
    left: buildBVHNode(triangles, start, mid),
    right: buildBVHNode(triangles, mid, end),
    start,
    end,
  };
}

export function getGeometryBVH(geometry: Geometry3D): GeometryBVH {
  const cached = geometryBVHCache.get(geometry);
  if (cached
    && cached.positions === geometry.positions
    && cached.indices === geometry.indices
    && cached.geometryVersion === geometry.version) return cached;

  const triangles: RaycastTriangle[] = [];
  const positions = geometry.positions;
  const indices = geometry.indices;
  if (indices) {
    for (let i = 0; i + 2 < indices.length; i += 3) {
      triangles.push(createTriangle(
        positions,
        requiredNumberAt(indices, i, 'geometry indices'),
        requiredNumberAt(indices, i + 1, 'geometry indices'),
        requiredNumberAt(indices, i + 2, 'geometry indices'),
      ));
    }
  } else {
    const n = positions.length / 3;
    for (let i = 0; i + 2 < n; i += 3) {
      triangles.push(createTriangle(positions, i, i + 1, i + 2));
    }
  }

  const root = buildBVHNode(triangles, 0, triangles.length);
  const bvh = { positions, indices, geometryVersion: geometry.version, triangles, root };
  geometryBVHCache.set(geometry, bvh);
  return bvh;
}

/** Private, scoped instrumentation. Ordinary ray queries do not allocate trace data. */
export interface RaycastBVHTraceSink {
  bounds(accepted: boolean): void;
  node(node: BVHNode, accepted: boolean): void;
}

const traceSinks = new WeakMap<object, RaycastBVHTraceSink>();
let activeTraceCount = 0;

export function getRaycastBVHTrace(owner: object): RaycastBVHTraceSink | undefined {
  return activeTraceCount ? traceSinks.get(owner) : undefined;
}

export function withRaycastBVHTrace<T>(owner: object, sink: RaycastBVHTraceSink, query: () => T): T {
  const previous = traceSinks.get(owner);
  traceSinks.set(owner, sink);
  activeTraceCount++;
  try {
    return query();
  } finally {
    activeTraceCount--;
    if (previous) traceSinks.set(owner, previous);
    else traceSinks.delete(owner);
  }
}
