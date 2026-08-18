import { Geometry3D } from './Geometry3D';

export interface SphereGeometryOptions {
  radius?: number;
  widthSegments?: number;
  heightSegments?: number;
}

export function createSphere3D(options: SphereGeometryOptions = {}): Geometry3D {
  const radius = options.radius ?? 0.5;
  const wSeg = Math.max(3, options.widthSegments ?? 32);
  const hSeg = Math.max(2, options.heightSegments ?? 16);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= hSeg; row++) {
    const phi = (row / hSeg) * Math.PI;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    for (let col = 0; col <= wSeg; col++) {
      const theta = (col / wSeg) * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      const cosTheta = Math.cos(theta);

      const nx = cosTheta * sinPhi;
      const ny = cosPhi;
      const nz = sinTheta * sinPhi;

      positions.push(nx * radius, ny * radius, nz * radius);
      normals.push(nx, ny, nz);
      uvs.push(col / wSeg, row / hSeg);
    }
  }

  for (let row = 0; row < hSeg; row++) {
    for (let col = 0; col < wSeg; col++) {
      const a = row * (wSeg + 1) + col;
      const b = a + (wSeg + 1);
      indices.push(a, a + 1, b);
      indices.push(b, a + 1, b + 1);
    }
  }

  const indexArray = new Uint32Array(indices);

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: indexArray,
  });
}
