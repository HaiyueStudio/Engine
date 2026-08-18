import { Geometry3D } from '@haiyue/engine/geometry';

type Vec3 = readonly [number, number, number];

interface FaceDefinition {
  readonly center: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly normal: Vec3;
  readonly uSize: number;
  readonly vSize: number;
}

export interface SegmentedBoxGeometryOptions {
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly segments?: number;
}

/** Example-local indexed box generator equivalent to a 10-segment BoxGeometry. */
export function createSegmentedBoxGeometry(
  options: SegmentedBoxGeometryOptions = {},
): Geometry3D {
  const width = options.width ?? 3.4;
  const height = options.height ?? 3.4;
  const depth = options.depth ?? 3.4;
  const segments = options.segments ?? 10;
  if (![width, height, depth].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Segmented box dimensions must be positive finite numbers.');
  }
  if (!Number.isInteger(segments) || segments < 1 || segments > 128) {
    throw new RangeError(`Segmented box segments must be an integer from 1 to 128; received ${segments}.`);
  }

  const hx = width * 0.5;
  const hy = height * 0.5;
  const hz = depth * 0.5;
  const faces: readonly FaceDefinition[] = [
    { center: [hx, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0], uSize: height, vSize: depth },
    { center: [-hx, 0, 0], u: [0, 1, 0], v: [0, 0, -1], normal: [-1, 0, 0], uSize: height, vSize: depth },
    { center: [0, hy, 0], u: [0, 0, 1], v: [1, 0, 0], normal: [0, 1, 0], uSize: depth, vSize: width },
    { center: [0, -hy, 0], u: [0, 0, 1], v: [-1, 0, 0], normal: [0, -1, 0], uSize: depth, vSize: width },
    { center: [0, 0, hz], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1], uSize: width, vSize: height },
    { center: [0, 0, -hz], u: [-1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1], uSize: width, vSize: height },
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const textureCoordinates: number[] = [];
  const indices: number[] = [];
  const rowSize = segments + 1;

  for (const face of faces) {
    const firstVertex = positions.length / 3;
    for (let row = 0; row <= segments; row++) {
      const vRatio = row / segments;
      const vOffset = (vRatio - 0.5) * face.vSize;
      for (let column = 0; column <= segments; column++) {
        const uRatio = column / segments;
        const uOffset = (uRatio - 0.5) * face.uSize;
        positions.push(
          face.center[0] + face.u[0] * uOffset + face.v[0] * vOffset,
          face.center[1] + face.u[1] * uOffset + face.v[1] * vOffset,
          face.center[2] + face.u[2] * uOffset + face.v[2] * vOffset,
        );
        normals.push(face.normal[0], face.normal[1], face.normal[2]);
        textureCoordinates.push(uRatio, 1 - vRatio);
      }
    }

    for (let row = 0; row < segments; row++) {
      for (let column = 0; column < segments; column++) {
        const a = firstVertex + row * rowSize + column;
        const b = a + 1;
        const d = a + rowSize;
        const c = d + 1;
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  const indexData = positions.length / 3 > 65_535
    ? new Uint32Array(indices)
    : new Uint16Array(indices);
  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(textureCoordinates) }],
    indices: indexData,
  });
}
