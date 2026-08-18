import { Geometry3D } from './Geometry3D';

export interface CylinderGeometryOptions {
  radiusTop?: number;
  radiusBottom?: number;
  height?: number;
  radialSegments?: number;
  heightSegments?: number;
  openEnded?: boolean;
}

export function createCylinder3D(options: CylinderGeometryOptions = {}): Geometry3D {
  const radiusTop = Math.max(0, options.radiusTop ?? 0.5);
  const radiusBottom = Math.max(0, options.radiusBottom ?? 0.5);
  const height = options.height ?? 1;
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? 32));
  const heightSegments = Math.max(1, Math.floor(options.heightSegments ?? 1));
  const openEnded = options.openEnded ?? false;
  const halfH = height / 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const slope = (radiusBottom - radiusTop) / Math.max(0.000001, height);

  for (let y = 0; y <= heightSegments; y++) {
    const v = y / heightSegments;
    const radius = radiusTop + (radiusBottom - radiusTop) * v;
    const py = halfH - v * height;
    for (let i = 0; i <= radialSegments; i++) {
      const u = i / radialSegments;
      const theta = u * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      positions.push(cos * radius, py, sin * radius);
      const normalLength = Math.hypot(cos, slope, sin) || 1;
      normals.push(cos / normalLength, slope / normalLength, sin / normalLength);
      uvs.push(u, v);
    }
  }

  const row = radialSegments + 1;
  for (let y = 0; y < heightSegments; y++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = y * row + i;
      const b = a + row;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, d, b, d, c, b);
    }
  }

  if (!openEnded) {
    if (radiusTop > 0) appendCap(positions, normals, uvs, indices, radiusTop, halfH, 1, radialSegments);
    if (radiusBottom > 0) appendCap(positions, normals, uvs, indices, radiusBottom, -halfH, -1, radialSegments);
  }

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: createIndexArray(indices, positions.length / 3),
  });
}

function appendCap(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
  radius: number,
  y: number,
  sign: 1 | -1,
  radialSegments: number,
): void {
  const center = positions.length / 3;
  positions.push(0, y, 0);
  normals.push(0, sign, 0);
  uvs.push(0.5, 0.5);
  const ringStart = positions.length / 3;

  for (let i = 0; i <= radialSegments; i++) {
    const theta = (i / radialSegments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    positions.push(cos * radius, y, sin * radius);
    normals.push(0, sign, 0);
    uvs.push(cos * 0.5 + 0.5, sin * 0.5 * sign + 0.5);
  }

  for (let i = 0; i < radialSegments; i++) {
    if (sign > 0) indices.push(center, ringStart + i + 1, ringStart + i);
    else indices.push(center, ringStart + i, ringStart + i + 1);
  }
}

function createIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}
