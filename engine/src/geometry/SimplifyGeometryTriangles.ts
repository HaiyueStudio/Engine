import { EngineError, EngineErrorCode } from '../core/EngineError';
import { Geometry3D } from './Geometry3D';
import { buildGeometry3DQemCollapseCandidates } from './Geometry3DQemSimplifier';
import {
  compactGeometry3DTransformStreams,
  createGeometry3DTransformStreams,
  interpolateGeometry3DVertex,
  validateGeometry3DVertexStream,
} from './Geometry3DTransformStreams';

export interface SimplifyGeometryTrianglesOptions {
  /** Desired remaining triangle fraction in the range (0, 1]. Defaults to 0.5. */
  readonly targetRatio?: number;
  /** Desired absolute triangle count. Mutually exclusive with targetRatio. */
  readonly targetTriangleCount?: number;
  /** Locks every vertex on an open topological boundary. Defaults to true. */
  readonly preserveBoundary?: boolean;
}

/**
 * Simplifies indexed triangle-list geometry with constrained quadric-error edge
 * collapses. Candidate positions stay on their source edge, so existing manual
 * bounds remain conservative and attribute interpolation has a stable meaning.
 *
 * The target is best-effort: boundary locking and topology/normal-flip guards
 * may stop before it is reached. Attribute seams represented by split vertices
 * stay split. Numeric custom attributes are treated as continuous values.
 */
export function simplifyGeometryTriangles(
  source: Geometry3D,
  options: SimplifyGeometryTrianglesOptions = {},
): Geometry3D {
  if (source.topology !== null && source.topology !== 'triangle-list') {
    throw simplificationError(
      `simplifyGeometryTriangles requires triangle-list geometry; received ${String(source.topology)}.`,
    );
  }
  validateOptions(options);
  const vertexCount = validateGeometry3DVertexStream(
    source.positions,
    3,
    undefined,
    'positions',
    simplificationError,
  );
  validateFinitePositions(source.positions);
  if (source.indices === null) {
    if (vertexCount === 0) {
      const emptyStreams = createGeometry3DTransformStreams(source, simplificationError);
      return compactGeometry3DTransformStreams(source, emptyStreams, []);
    }
    throw simplificationError(
      'simplifyGeometryTriangles requires indexed geometry so shared topological edges are unambiguous.',
    );
  }
  let indices = validateIndices(source.indices, vertexCount);
  indices = removeDegenerateAndDuplicateFaces(indices);
  const targetTriangleCount = resolveTargetTriangleCount(indices.length / 3, options);
  const preserveBoundary = options.preserveBoundary ?? true;
  const streams = createGeometry3DTransformStreams(source, simplificationError);

  while (indices.length / 3 > targetTriangleCount) {
    const candidates = buildGeometry3DQemCollapseCandidates(
      indices,
      streams.positions.data,
      vertexCount,
      preserveBoundary,
    );
    if (candidates.length === 0) break;

    const selected = [] as typeof candidates;
    const occupiedFaces = new Set<number>();
    let estimatedTriangleCount = indices.length / 3;
    for (const candidate of candidates) {
      if (candidate.incidentFaces.some(face => occupiedFaces.has(face))) continue;
      if (estimatedTriangleCount - candidate.removedFaces < targetTriangleCount) continue;
      selected.push(candidate);
      estimatedTriangleCount -= candidate.removedFaces;
      for (const face of candidate.incidentFaces) occupiedFaces.add(face);
      if (estimatedTriangleCount <= targetTriangleCount) break;
    }
    if (selected.length === 0) break;

    const replacements = new Map<number, number>();
    for (const candidate of selected) {
      interpolateGeometry3DVertex(streams, candidate.a, candidate.a, candidate.b, candidate.t);
      replacements.set(candidate.b, candidate.a);
    }
    const rewritten = indices.map(index => replacements.get(index) ?? index);
    const nextIndices = removeDegenerateAndDuplicateFaces(rewritten);
    if (nextIndices.length >= indices.length) break;
    indices = nextIndices;
  }

  return compactGeometry3DTransformStreams(source, streams, indices);
}

function validateOptions(options: SimplifyGeometryTrianglesOptions): void {
  if (options.targetRatio !== undefined && options.targetTriangleCount !== undefined) {
    throw simplificationError('targetRatio and targetTriangleCount are mutually exclusive.');
  }
  if (
    options.targetRatio !== undefined
    && (!Number.isFinite(options.targetRatio) || options.targetRatio <= 0 || options.targetRatio > 1)
  ) {
    throw simplificationError(`targetRatio must be finite and in (0, 1]; received ${options.targetRatio}.`);
  }
  if (
    options.targetTriangleCount !== undefined
    && (!Number.isInteger(options.targetTriangleCount) || options.targetTriangleCount < 1)
  ) {
    throw simplificationError(
      `targetTriangleCount must be a positive integer; received ${options.targetTriangleCount}.`,
    );
  }
  if (options.preserveBoundary !== undefined && typeof options.preserveBoundary !== 'boolean') {
    throw simplificationError('preserveBoundary must be a boolean.');
  }
}

function validateFinitePositions(positions: Float32Array): void {
  for (let index = 0; index < positions.length; index++) {
    if (!Number.isFinite(positions[index])) {
      throw simplificationError(`positions contains a non-finite value at component ${index}.`);
    }
  }
}

function validateIndices(source: Uint16Array | Uint32Array, vertexCount: number): number[] {
  if (!(source instanceof Uint16Array) && !(source instanceof Uint32Array)) {
    throw simplificationError('Source indices must be Uint16Array or Uint32Array.');
  }
  if (source.length % 3 !== 0) {
    throw simplificationError(
      `Indexed source must contain complete triangles; received ${source.length} indices.`,
    );
  }
  const result = Array.from(source);
  for (let offset = 0; offset < result.length; offset++) {
    const index = result[offset]!;
    if (index >= vertexCount) {
      throw simplificationError(
        `Source index ${index} at offset ${offset} exceeds vertexCount ${vertexCount}.`,
      );
    }
  }
  return result;
}

function resolveTargetTriangleCount(
  triangleCount: number,
  options: SimplifyGeometryTrianglesOptions,
): number {
  if (triangleCount === 0) return 0;
  if (options.targetTriangleCount !== undefined) {
    return Math.min(triangleCount, options.targetTriangleCount);
  }
  return Math.max(1, Math.floor(triangleCount * (options.targetRatio ?? 0.5)));
}

function removeDegenerateAndDuplicateFaces(indices: readonly number[]): number[] {
  const result: number[] = [];
  const faces = new Set<string>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!;
    const b = indices[offset + 1]!;
    const c = indices[offset + 2]!;
    if (a === b || b === c || c === a) continue;
    const key = [a, b, c].sort((left, right) => left - right).join(':');
    if (faces.has(key)) continue;
    faces.add(key);
    result.push(a, b, c);
  }
  return result;
}

function simplificationError(message: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    message,
    {
      hint: 'Provide indexed triangle-list geometry and one valid simplification target.',
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
