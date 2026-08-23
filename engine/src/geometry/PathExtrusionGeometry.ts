import { EngineError, EngineErrorCode } from '../core/EngineError';
import { Geometry3D } from './Geometry3D';

export interface PathExtrusionPoint {
  /** Center of this extrusion ring in local space. */
  readonly position: readonly [number, number, number];
  /** Rotation around the local path tangent, in radians. */
  readonly roll?: number;
}

export interface PathExtrusionGeometryOptions {
  /** Ordered path rings. Closed paths connect the final point back to the first. */
  readonly path: readonly PathExtrusionPoint[];
  /** Cross-section vertices in local right/up coordinates. Clockwise order faces outward. */
  readonly shape: readonly (readonly [number, number])[];
  /** Connect the final path point back to the first. Defaults to false. */
  readonly closedPath?: boolean;
  /** Connect the final cross-section edge back to the first. Defaults to true. */
  readonly closedShape?: boolean;
  /** World-distance multipliers for the path and cross-section UV axes. */
  readonly uvScale?: readonly [number, number];
}

interface Frame {
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

const EPSILON = 1e-7;
const MAX_PATH_POINTS = 16_384;
const MAX_SHAPE_POINTS = 1_024;
const MAX_OUTPUT_VERTICES = 4_000_000;

/**
 * Extrudes a 2D cross-section along a 3D path.
 *
 * The generator derives a stable right/up frame from each path tangent and
 * applies each point's optional `roll`. A closed path duplicates its first
 * ring only in the output so UVs remain continuous at the seam.
 */
export function createPathExtrusion3D(options: PathExtrusionGeometryOptions): Geometry3D {
  validateOptions(options);
  const { path, shape } = options;
  const closedPath = options.closedPath ?? false;
  const closedShape = options.closedShape ?? true;
  const uvScale = options.uvScale ?? [1, 1];
  const pathDistances = cumulativePathDistances(path, closedPath);
  const shapeDistances = cumulativeShapeDistances(shape, closedShape);
  const frames = path.map((_, index) => createFrame(path, index, closedPath));
  const pathRingCount = closedPath ? path.length + 1 : path.length;
  const shapeEdgeCount = closedShape ? shape.length : shape.length - 1;
  const vertexCount = pathRingCount * shapeEdgeCount * 2;
  if (vertexCount > MAX_OUTPUT_VERTICES) {
    throw parameterError(
      `path and shape produce ${vertexCount} vertices; maximum is ${MAX_OUTPUT_VERTICES}.`,
      'Reduce path or cross-section resolution before extrusion.',
    );
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const segmentCount = pathRingCount - 1;
  const indices = new (vertexCount > 65_535 ? Uint32Array : Uint16Array)(segmentCount * shapeEdgeCount * 6);
  let vertexOffset = 0;

  for (let edge = 0; edge < shapeEdgeCount; edge++) {
    const nextEdge = (edge + 1) % shape.length;
    const shapeA = shape[edge]!;
    const shapeB = shape[nextEdge]!;
    const edgeX = shapeB[0] - shapeA[0];
    const edgeY = shapeB[1] - shapeA[1];
    const edgeLength = Math.hypot(edgeX, edgeY);
    const normalX = -edgeY / edgeLength;
    const normalY = edgeX / edgeLength;
    const faceStart = vertexOffset;

    for (let ring = 0; ring < pathRingCount; ring++) {
      const sourceIndex = ring % path.length;
      const point = path[sourceIndex]!;
      const frame = frames[sourceIndex]!;
      const pathDistance = ring === path.length ? pathDistances[path.length]! : pathDistances[sourceIndex]!;
      for (const shapeIndex of [edge, nextEdge]) {
        const coordinate = shape[shapeIndex]!;
        const position = mapCrossSection(point.position, frame, coordinate);
        positions.set(position, vertexOffset * 3);
        normals.set([
          frame.right[0] * normalX + frame.up[0] * normalY,
          frame.right[1] * normalX + frame.up[1] * normalY,
          frame.right[2] * normalX + frame.up[2] * normalY,
        ], vertexOffset * 3);
        uvs.set([
          pathDistance * uvScale[0],
          shapeDistances[shapeIndex]! * uvScale[1],
        ], vertexOffset * 2);
        vertexOffset++;
      }
    }

    for (let segment = 0; segment < segmentCount; segment++) {
      const a = faceStart + segment * 2;
      const b = a + 1;
      const nextA = a + 2;
      const nextB = a + 3;
      const indexOffset = (edge * segmentCount + segment) * 6;
      indices.set([a, nextB, b, a, nextA, nextB], indexOffset);
    }
  }

  return new Geometry3D({
    positions,
    normals,
    textureCoordinates: [{ set: 0, data: uvs }],
    indices,
  });
}

function createFrame(path: readonly PathExtrusionPoint[], index: number, closed: boolean): Frame {
  const previousIndex = index === 0 ? (closed ? path.length - 1 : 0) : index - 1;
  const nextIndex = index === path.length - 1 ? (closed ? 0 : path.length - 1) : index + 1;
  const previous = path[previousIndex]!.position;
  const next = path[nextIndex]!.position;
  const tangent = normalize3([next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]]);
  const referenceUp: readonly [number, number, number] = Math.abs(tangent[1]) < 0.96 ? [0, 1, 0] : [0, 0, 1];
  const baseRight = normalize3(cross3(referenceUp, tangent));
  const baseUp = normalize3(cross3(tangent, baseRight));
  const roll = path[index]!.roll ?? 0;
  const cosine = Math.cos(roll);
  const sine = Math.sin(roll);
  return {
    right: [
      baseRight[0] * cosine + baseUp[0] * sine,
      baseRight[1] * cosine + baseUp[1] * sine,
      baseRight[2] * cosine + baseUp[2] * sine,
    ],
    up: [
      baseUp[0] * cosine - baseRight[0] * sine,
      baseUp[1] * cosine - baseRight[1] * sine,
      baseUp[2] * cosine - baseRight[2] * sine,
    ],
  };
}

function mapCrossSection(
  center: readonly [number, number, number],
  frame: Frame,
  coordinate: readonly [number, number],
): readonly [number, number, number] {
  return [
    center[0] + frame.right[0] * coordinate[0] + frame.up[0] * coordinate[1],
    center[1] + frame.right[1] * coordinate[0] + frame.up[1] * coordinate[1],
    center[2] + frame.right[2] * coordinate[0] + frame.up[2] * coordinate[1],
  ];
}

function cumulativePathDistances(path: readonly PathExtrusionPoint[], closed: boolean): number[] {
  const distances = new Array<number>(path.length + (closed ? 1 : 0)).fill(0);
  for (let index = 1; index < path.length; index++) {
    distances[index] = distances[index - 1]! + distance3(path[index - 1]!.position, path[index]!.position);
  }
  if (closed) distances[path.length] = distances[path.length - 1]! + distance3(path[path.length - 1]!.position, path[0]!.position);
  return distances;
}

function cumulativeShapeDistances(shape: readonly (readonly [number, number])[], closed: boolean): number[] {
  const distances = new Array<number>(shape.length).fill(0);
  for (let index = 1; index < shape.length; index++) {
    distances[index] = distances[index - 1]! + Math.hypot(shape[index]![0] - shape[index - 1]![0], shape[index]![1] - shape[index - 1]![1]);
  }
  if (closed) {
    const perimeter = distances[shape.length - 1]! + Math.hypot(shape[0]![0] - shape[shape.length - 1]![0], shape[0]![1] - shape[shape.length - 1]![1]);
    if (!Number.isFinite(perimeter)) throw parameterError('shape perimeter must be finite.');
  }
  return distances;
}

function validateOptions(options: PathExtrusionGeometryOptions): void {
  if (!options || typeof options !== 'object') throw parameterError('options are required.');
  const closedPath = options.closedPath ?? false;
  const closedShape = options.closedShape ?? true;
  if (!Array.isArray(options.path) || options.path.length < (closedPath ? 3 : 2) || options.path.length > MAX_PATH_POINTS) {
    throw parameterError(`path must contain ${closedPath ? '3' : '2'} to ${MAX_PATH_POINTS} points.`);
  }
  if (!Array.isArray(options.shape) || options.shape.length < (closedShape ? 3 : 2) || options.shape.length > MAX_SHAPE_POINTS) {
    throw parameterError(`shape must contain ${closedShape ? '3' : '2'} to ${MAX_SHAPE_POINTS} points.`);
  }
  for (let index = 0; index < options.path.length; index++) {
    const point = options.path[index]!;
    if (!point || !isFiniteTuple(point.position, 3) || (point.roll !== undefined && !Number.isFinite(point.roll))) {
      throw parameterError(`path[${index}] must contain a finite position and optional finite roll.`);
    }
    if (index > 0 && distance3(options.path[index - 1]!.position, point.position) <= EPSILON) {
      throw parameterError(`path[${index - 1}] and path[${index}] must not overlap.`);
    }
  }
  if (closedPath && distance3(options.path[options.path.length - 1]!.position, options.path[0]!.position) <= EPSILON) {
    throw parameterError('closed path must not repeat its first point at the end.');
  }
  for (let index = 0; index < options.shape.length; index++) {
    const point = options.shape[index]!;
    if (!isFiniteTuple(point, 2)) throw parameterError(`shape[${index}] must contain two finite values.`);
    const nextIndex = (index + 1) % options.shape.length;
    if ((closedShape || index < options.shape.length - 1)
      && Math.hypot(point[0]! - options.shape[nextIndex]![0], point[1]! - options.shape[nextIndex]![1]) <= EPSILON) {
      throw parameterError(`shape edge ${index} must have non-zero length.`);
    }
  }
  if (options.uvScale !== undefined && !isFiniteTuple(options.uvScale, 2)) throw parameterError('uvScale must contain two finite values.');
}

function isFiniteTuple(value: readonly number[] | undefined, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function distance3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function cross3(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
}

function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= EPSILON) throw parameterError('path tangent must have non-zero length.');
  return [value[0] / length, value[1] / length, value[2] / length];
}

function parameterError(message: string, hint = 'Use finite, non-overlapping path and shape coordinates.'): EngineError {
  return new EngineError(EngineErrorCode.GeometryInvalidParameter, `Path extrusion ${message}`, { hint });
}
