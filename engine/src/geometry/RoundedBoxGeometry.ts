import { Geometry3D } from './Geometry3D';
import { createBox3D } from './BoxGeometry';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { requiredNumberAt } from '../math/arrayAccess';

export interface RoundedBoxGeometryOptions {
  width?: number;
  height?: number;
  depth?: number;
  /** Corner radius in local units. Clamped to half of the smallest dimension. */
  radius?: number;
  /** Number of subdivisions across each rounded edge/corner band. */
  segments?: number;
}

type Axis = 0 | 1 | 2;

interface FaceSpec {
  axis: Axis;
  sign: 1 | -1;
  uAxis: Axis;
  vAxis: Axis;
  flip: boolean;
}

const FACES: FaceSpec[] = [
  { axis: 0, sign:  1, uAxis: 2, vAxis: 1, flip: true  },
  { axis: 0, sign: -1, uAxis: 2, vAxis: 1, flip: false },
  { axis: 1, sign:  1, uAxis: 0, vAxis: 2, flip: true  },
  { axis: 1, sign: -1, uAxis: 0, vAxis: 2, flip: false },
  { axis: 2, sign:  1, uAxis: 0, vAxis: 1, flip: false },
  { axis: 2, sign: -1, uAxis: 0, vAxis: 1, flip: true  },
];

const MAX_ROUNDED_BOX_SEGMENTS = 256;

/**
 * Creates a rounded box geometry with smooth normals.
 *
 * The geometry is generated from subdivided cube faces and projected onto a
 * rounded box. `segments` controls the rounded bands only; the flat center of
 * each face remains a single grid span.
 */
export function createRoundedBox3D(options: RoundedBoxGeometryOptions = {}): Geometry3D {
  const requestedWidth = options.width ?? 1;
  const requestedHeight = options.height ?? 1;
  const requestedDepth = options.depth ?? 1;
  const requestedRadius = options.radius;
  const requestedSegments = options.segments ?? 4;
  requireFiniteRoundedBoxValue(requestedWidth, 'width');
  requireFiniteRoundedBoxValue(requestedHeight, 'height');
  requireFiniteRoundedBoxValue(requestedDepth, 'depth');
  if (requestedRadius !== undefined) requireFiniteRoundedBoxValue(requestedRadius, 'radius');
  if (!Number.isFinite(requestedSegments) || requestedSegments > MAX_ROUNDED_BOX_SEGMENTS) {
    throw roundedBoxParameterError(
      `segments must be finite and no greater than ${MAX_ROUNDED_BOX_SEGMENTS}; received ${String(requestedSegments)}.`,
      'Use an integer segment count from 1 to 256.',
    );
  }

  const width = Math.max(0.0001, requestedWidth);
  const height = Math.max(0.0001, requestedHeight);
  const depth = Math.max(0.0001, requestedDepth);
  const maxRadius = Math.min(width, height, depth) * 0.5;
  const radius = Math.max(0, Math.min(requestedRadius ?? maxRadius * 0.15, maxRadius));
  const segments = Math.max(1, Math.floor(requestedSegments));

  if (radius <= 0.00001) return createBox3D({ width, height, depth });

  const half: [number, number, number] = [width * 0.5, height * 0.5, depth * 0.5];
  const inner: [number, number, number] = [
    Math.max(0, half[0] - radius),
    Math.max(0, half[1] - radius),
    Math.max(0, half[2] - radius),
  ];
  const coords: [number[], number[], number[]] = [
    buildAxisCoords(half[0], inner[0], segments),
    buildAxisCoords(half[1], inner[1], segments),
    buildAxisCoords(half[2], inner[2], segments),
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const face of FACES) {
    const faceStart = positions.length / 3;
    const uCoords = coords[face.uAxis];
    const vCoords = coords[face.vAxis];

    for (let v = 0; v < vCoords.length; v++) {
      const vCoord = requiredNumberAt(vCoords, v, 'rounded-box v coordinates');
      for (let u = 0; u < uCoords.length; u++) {
        const uCoord = requiredNumberAt(uCoords, u, 'rounded-box u coordinates');
        const source: [number, number, number] = [0, 0, 0];
        source[face.axis] = face.sign * half[face.axis];
        source[face.uAxis] = uCoord;
        source[face.vAxis] = vCoord;

        const rounded = projectToRoundedBox(source, inner, radius);
        positions.push(rounded.position[0], rounded.position[1], rounded.position[2]);
        normals.push(rounded.normal[0], rounded.normal[1], rounded.normal[2]);
        uvs.push(u / (uCoords.length - 1), 1 - v / (vCoords.length - 1));
      }
    }

    const row = uCoords.length;
    for (let v = 0; v < vCoords.length - 1; v++) {
      for (let u = 0; u < uCoords.length - 1; u++) {
        const a = faceStart + v * row + u;
        const b = a + 1;
        const c = a + row + 1;
        const d = a + row;
        if (face.flip) indices.push(a, c, b, a, d, c);
        else indices.push(a, b, c, a, c, d);
      }
    }
  }

  const indexArray = positions.length / 3 > 65535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: indexArray,
  });
}

function buildAxisCoords(half: number, inner: number, segments: number): number[] {
  if (inner <= 0.00001) {
    const coords: number[] = [];
    const count = segments * 2;
    for (let i = 0; i <= count; i++) coords.push(-half + (2 * half * i) / count);
    return coords;
  }

  const radius = half - inner;
  const coords: number[] = [];
  for (let i = 0; i <= segments; i++) coords.push(-half + (radius * i) / segments);
  coords.push(inner);
  for (let i = 1; i <= segments; i++) coords.push(inner + (radius * i) / segments);
  return dedupeSorted(coords);
}

function dedupeSorted(values: number[]): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (
      result.length === 0
      || Math.abs(requiredNumberAt(result, result.length - 1, 'rounded-box coordinates') - value) > 0.000001
    ) result.push(value);
  }
  return result;
}

function projectToRoundedBox(
  source: [number, number, number],
  inner: [number, number, number],
  radius: number,
): { position: [number, number, number]; normal: [number, number, number] } {
  const core: [number, number, number] = [
    clamp(source[0], -inner[0], inner[0]),
    clamp(source[1], -inner[1], inner[1]),
    clamp(source[2], -inner[2], inner[2]),
  ];
  const delta: [number, number, number] = [
    source[0] - core[0],
    source[1] - core[1],
    source[2] - core[2],
  ];
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  const normal: [number, number, number] = length > 0.000001
    ? [delta[0] / length, delta[1] / length, delta[2] / length]
    : fallbackNormal(source);

  return {
    position: [
      core[0] + normal[0] * radius,
      core[1] + normal[1] * radius,
      core[2] + normal[2] * radius,
    ],
    normal,
  };
}

function fallbackNormal(source: [number, number, number]): [number, number, number] {
  const ax = Math.abs(source[0]);
  const ay = Math.abs(source[1]);
  const az = Math.abs(source[2]);
  if (ax >= ay && ax >= az) return [Math.sign(source[0]) || 1, 0, 0];
  if (ay >= az) return [0, Math.sign(source[1]) || 1, 0];
  return [0, 0, Math.sign(source[2]) || 1];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function requireFiniteRoundedBoxValue(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw roundedBoxParameterError(`${label} must be finite; received ${String(value)}.`);
  }
}

function roundedBoxParameterError(message: string, hint?: string): EngineError {
  return new EngineError(
    EngineErrorCode.GeometryInvalidParameter,
    `Rounded box ${message}`,
    {
      ...(hint === undefined ? {} : { hint }),
      docsPath: 'errors/E_GEOMETRY_INVALID_PARAMETER',
    },
  );
}
