import { Geometry3D } from './Geometry3D';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredItemAt, requiredNumberAt } from '../math/arrayAccess';

export interface IcosahedronGeometryOptions {
  radius?: number;
  detail?: number;
}

interface Vertex {
  x: number;
  y: number;
  z: number;
}

const MAX_ICOSAHEDRON_DETAIL = 8;

export function createIcosahedron3D(options: IcosahedronGeometryOptions = {}): Geometry3D {
  const radius = options.radius ?? 0.5;
  const requestedDetail = options.detail ?? 0;
  if (!Number.isFinite(requestedDetail) || requestedDetail > MAX_ICOSAHEDRON_DETAIL) {
    throw new EngineError(
      EngineErrorCode.GeometryInvalidParameter,
      `Icosahedron detail must be finite and no greater than ${MAX_ICOSAHEDRON_DETAIL}; received ${String(requestedDetail)}.`,
      {
        hint: 'Use detail 0–8; each level quadruples the triangle count.',
        docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
      },
    );
  }
  const detail = Math.max(0, Math.floor(requestedDetail));
  const t = (1 + Math.sqrt(5)) / 2;

  const vertices: Vertex[] = [
    normalizeVertex({ x: -1, y:  t, z:  0 }),
    normalizeVertex({ x:  1, y:  t, z:  0 }),
    normalizeVertex({ x: -1, y: -t, z:  0 }),
    normalizeVertex({ x:  1, y: -t, z:  0 }),
    normalizeVertex({ x:  0, y: -1, z:  t }),
    normalizeVertex({ x:  0, y:  1, z:  t }),
    normalizeVertex({ x:  0, y: -1, z: -t }),
    normalizeVertex({ x:  0, y:  1, z: -t }),
    normalizeVertex({ x:  t, y:  0, z: -1 }),
    normalizeVertex({ x:  t, y:  0, z:  1 }),
    normalizeVertex({ x: -t, y:  0, z: -1 }),
    normalizeVertex({ x: -t, y:  0, z:  1 }),
  ];

  let indices = [
     0, 11,  5,   0,  5,  1,   0,  1,  7,   0,  7, 10,   0, 10, 11,
     1,  5,  9,   5, 11,  4,  11, 10,  2,  10,  7,  6,   7,  1,  8,
     3,  9,  4,   3,  4,  2,   3,  2,  6,   3,  6,  8,   3,  8,  9,
     4,  9,  5,   2,  4, 11,   6,  2, 10,   8,  6,  7,   9,  8,  1,
  ];

  for (let level = 0; level < detail; level++) {
    const next: number[] = [];
    const midpointCache = new Map<string, number>();
    for (let i = 0; i < indices.length; i += 3) {
      const a = requiredNumberAt(indices, i, 'icosahedron indices');
      const b = requiredNumberAt(indices, i + 1, 'icosahedron indices');
      const c = requiredNumberAt(indices, i + 2, 'icosahedron indices');
      const ab = getMidpointIndex(vertices, midpointCache, a, b);
      const bc = getMidpointIndex(vertices, midpointCache, b, c);
      const ca = getMidpointIndex(vertices, midpointCache, c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const vertex of vertices) {
    positions.push(vertex.x * radius, vertex.y * radius, vertex.z * radius);
    normals.push(vertex.x, vertex.y, vertex.z);
    uvs.push(0.5 + Math.atan2(vertex.z, vertex.x) / (Math.PI * 2), 0.5 - Math.asin(vertex.y) / Math.PI);
  }

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: createIndexArray(indices, vertices.length),
  });
}

function getMidpointIndex(vertices: Vertex[], cache: Map<string, number>, a: number, b: number): number {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const va = requiredItemAt(vertices, a, 'icosahedron vertices');
  const vb = requiredItemAt(vertices, b, 'icosahedron vertices');
  const index = vertices.length;
  vertices.push(normalizeVertex({
    x: (va.x + vb.x) * 0.5,
    y: (va.y + vb.y) * 0.5,
    z: (va.z + vb.z) * 0.5,
  }));
  cache.set(key, index);
  return index;
}

function normalizeVertex(vertex: Vertex): Vertex {
  const length = Math.hypot(vertex.x, vertex.y, vertex.z) || 1;
  return {
    x: vertex.x / length,
    y: vertex.y / length,
    z: vertex.z / length,
  };
}

function createIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}
