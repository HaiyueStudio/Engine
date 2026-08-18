import { Geometry3D } from './Geometry3D';

export interface ConeGeometryOptions {
  radius?: number;
  height?: number;
  radialSegments?: number;
}

export function createCone3D(options: ConeGeometryOptions = {}): Geometry3D {
  const radius = options.radius ?? 0.5;
  const height = options.height ?? 1;
  const segments = Math.max(3, options.radialSegments ?? 32);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const halfH = height / 2;
  // Slope normal: side normals tilt outward
  const normalY = radius / Math.sqrt(radius * radius + height * height);
  const normalR = height / Math.sqrt(radius * radius + height * height);

  // Side vertices: bottom ring + apex per segment (duplicated for normals)
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);

    // Bottom ring vertex
    positions.push(cos * radius, -halfH, sin * radius);
    normals.push(cos * normalR, normalY, sin * normalR);
    uvs.push(i / segments, 1);

    // Apex vertex (duplicated per segment for different normals)
    positions.push(cos * normalR * 0.001, halfH, sin * normalR * 0.001); // near apex
    normals.push(cos * normalR, normalY, sin * normalR);
    uvs.push((i + 0.5) / segments, 0);
  }

  // Side indices
  for (let i = 0; i < segments; i++) {
    const base = i * 2;
    // Keep the geometric face normal aligned with the authored outward
    // vertex normals. Mirrored views flip the render front face, so an
    // inward winding here otherwise makes the defect appear view-dependent.
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
  }

  // Bottom cap
  const capCenterIdx = positions.length / 3;
  positions.push(0, -halfH, 0);
  normals.push(0, -1, 0);
  uvs.push(0.5, 0.5);

  const capStartIdx = positions.length / 3;
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    positions.push(cos * radius, -halfH, sin * radius);
    normals.push(0, -1, 0);
    uvs.push(cos * 0.5 + 0.5, sin * 0.5 + 0.5);
  }

  for (let i = 0; i < segments; i++) {
    // Viewed from below, center -> current -> next is counter-clockwise and
    // therefore faces -Y in the engine's right-handed geometry convention.
    indices.push(capCenterIdx, capStartIdx + i, capStartIdx + i + 1);
  }

  return new Geometry3D({
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    textureCoordinates: [{ set: 0, data: new Float32Array(uvs) }],
    indices: new Uint32Array(indices),
  });
}
