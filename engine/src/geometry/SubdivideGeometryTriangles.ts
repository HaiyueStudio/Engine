import { EngineError, EngineErrorCode } from '../core/EngineError';
import { Geometry3D } from './Geometry3D';
import {
  buildGeometry3DFromTransformStreams,
  createGeometry3DTransformStreams,
  interpolateGeometry3DVertex,
  validateGeometry3DVertexStream,
} from './Geometry3DTransformStreams';

const MAX_SUBDIVISION_ITERATIONS = 8;
const MAX_SUBDIVIDED_TRIANGLES = 1_000_000;

export interface SubdivideGeometryTrianglesOptions {
  /** Number of midpoint-refinement passes. Each pass turns one triangle into four. */
  readonly iterations?: number;
}

/**
 * Refines arbitrary triangle-list geometry by inserting one shared midpoint on
 * every topological edge and replacing each source triangle with four children.
 *
 * This is linear topology refinement, not a smoothing scheme: existing vertex
 * positions never move. Numeric vertex attributes are interpolated, normals are
 * renormalized, and skin influences are merged and reduced to four weights.
 * Non-indexed inputs keep their intentionally disconnected triangle topology.
 */
export function subdivideGeometryTriangles(
  source: Geometry3D,
  options: SubdivideGeometryTrianglesOptions = {},
): Geometry3D {
  if (source.topology !== null && source.topology !== 'triangle-list') {
    throw subdivisionError(
      `subdivideGeometryTriangles requires triangle-list geometry; received ${String(source.topology)}.`,
    );
  }
  const iterations = options.iterations ?? 1;
  validateIterations(iterations);
  const vertexCount = validateGeometry3DVertexStream(
    source.positions,
    3,
    undefined,
    'positions',
    subdivisionError,
  );
  let indices = createTriangleIndices(source.indices, vertexCount);
  validateTriangleBudget(indices.length / 3, iterations);
  const streams = createGeometry3DTransformStreams(source, subdivisionError);

  for (let iteration = 0; iteration < iterations; iteration++) {
    const edgeMidpoints = new Map<string, number>();
    const nextIndices: number[] = [];
    const midpoint = (first: number, second: number): number => {
      const low = Math.min(first, second);
      const high = Math.max(first, second);
      const key = `${low}:${high}`;
      const cached = edgeMidpoints.get(key);
      if (cached !== undefined) return cached;
      const result = interpolateGeometry3DVertex(streams, null, first, second, 0.5);
      edgeMidpoints.set(key, result);
      return result;
    };
    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = indices[offset]!;
      const b = indices[offset + 1]!;
      const c = indices[offset + 2]!;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      nextIndices.push(
        a, ab, ca,
        b, bc, ab,
        c, ca, bc,
        ab, bc, ca,
      );
    }
    indices = nextIndices;
  }
  return buildGeometry3DFromTransformStreams(source, streams, indices);
}

function validateIterations(iterations: number): void {
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > MAX_SUBDIVISION_ITERATIONS) {
    throw subdivisionError(
      `iterations must be an integer from 0 to ${MAX_SUBDIVISION_ITERATIONS}; received ${iterations}.`,
    );
  }
}

function validateTriangleBudget(triangleCount: number, iterations: number): void {
  const outputTriangleCount = triangleCount * 4 ** iterations;
  if (!Number.isSafeInteger(outputTriangleCount) || outputTriangleCount > MAX_SUBDIVIDED_TRIANGLES) {
    throw subdivisionError(
      `Subdivision would create ${outputTriangleCount} triangles; the safety limit is ${MAX_SUBDIVIDED_TRIANGLES}.`,
    );
  }
}

function createTriangleIndices(
  source: Uint16Array | Uint32Array | null,
  vertexCount: number,
): number[] {
  if (source === null) {
    if (vertexCount % 3 !== 0) {
      throw subdivisionError(
        `Non-indexed source must contain complete triangles; received ${vertexCount} vertices.`,
      );
    }
    return Array.from({ length: vertexCount }, (_, index) => index);
  }
  if (!(source instanceof Uint16Array) && !(source instanceof Uint32Array)) {
    throw subdivisionError('Source indices must be Uint16Array, Uint32Array, or null.');
  }
  if (source.length % 3 !== 0) {
    throw subdivisionError(
      `Indexed source must contain complete triangles; received ${source.length} indices.`,
    );
  }
  const result = Array.from(source);
  for (let offset = 0; offset < result.length; offset++) {
    const index = result[offset]!;
    if (index >= vertexCount) {
      throw subdivisionError(
        `Source index ${index} at offset ${offset} exceeds vertexCount ${vertexCount}.`,
      );
    }
  }
  return result;
}

function subdivisionError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      hint: 'Provide complete triangle-list geometry with aligned per-vertex attributes and a bounded iteration count.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
