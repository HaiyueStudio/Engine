import { Geometry3D } from './Geometry3D';

export interface TorusGeometryOptions {
  radius?: number;
  tube?: number;
  radialSegments?: number;
  tubularSegments?: number;
  arc?: number;
}

export function createTorus3D(options: TorusGeometryOptions = {}): Geometry3D {
  const radius = options.radius ?? 0.55;
  const tube = options.tube ?? 0.18;
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? 16));
  const tubularSegments = Math.max(3, Math.floor(options.tubularSegments ?? 48));
  const arc = options.arc ?? Math.PI * 2;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 0; j <= radialSegments; j++) {
    const v = (j / radialSegments) * Math.PI * 2;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    for (let i = 0; i <= tubularSegments; i++) {
      const u = (i / tubularSegments) * arc;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const centerX = radius * cosU;
      const centerZ = radius * sinU;
      const nx = cosU * cosV;
      const ny = sinV;
      const nz = sinU * cosV;
      positions.push(centerX + tube * nx, tube * ny, centerZ + tube * nz);
      normals.push(nx, ny, nz);
      uvs.push(i / tubularSegments, j / radialSegments);
    }
  }

  const row = tubularSegments + 1;
  for (let j = 0; j < radialSegments; j++) {
    for (let i = 0; i < tubularSegments; i++) {
      const a = j * row + i;
      const b = (j + 1) * row + i;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, d, b, c);
    }
  }

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: createIndexArray(indices, positions.length / 3),
  });
}

function createIndexArray(indices: number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}
