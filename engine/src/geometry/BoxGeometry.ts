import { Geometry3D } from './Geometry3D';

export interface BoxGeometryOptions {
  width?: number;
  height?: number;
  depth?: number;
}

/**
 * Creates a box geometry with proper normals and UVs.
 * Each face has its own 4 vertices so normals are face-accurate.
 */
export function createBox3D(options: BoxGeometryOptions = {}): Geometry3D {
  const w = (options.width ?? 1) / 2;
  const h = (options.height ?? 1) / 2;
  const d = (options.depth ?? 1) / 2;

  // 6 faces × 4 vertices = 24 vertices
  // positions: [x,y,z] per vertex
  // normals:   [nx,ny,nz] per vertex
  // uvs:       [u,v] per vertex
  // indices:   2 triangles per face = 6 indices per face × 6 faces = 36

  const positions = new Float32Array([
    // +X face
     w,  h,  d,   w, -h,  d,   w, -h, -d,   w,  h, -d,
    // -X face
    -w,  h, -d,  -w, -h, -d,  -w, -h,  d,  -w,  h,  d,
    // +Y face
    -w,  h, -d,  -w,  h,  d,   w,  h,  d,   w,  h, -d,
    // -Y face
    -w, -h,  d,  -w, -h, -d,   w, -h, -d,   w, -h,  d,
    // +Z face
    -w,  h,  d,  -w, -h,  d,   w, -h,  d,   w,  h,  d,
    // -Z face
     w,  h, -d,   w, -h, -d,  -w, -h, -d,  -w,  h, -d,
  ]);

  const normals = new Float32Array([
    // +X
    1,0,0,  1,0,0,  1,0,0,  1,0,0,
    // -X
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
    // +Y
    0,1,0,  0,1,0,  0,1,0,  0,1,0,
    // -Y
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
    // +Z
    0,0,1,  0,0,1,  0,0,1,  0,0,1,
    // -Z
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
  ]);

  const uvs = new Float32Array([
    // Same UV layout for every face
    0,0, 0,1, 1,1, 1,0,
    0,0, 0,1, 1,1, 1,0,
    0,0, 0,1, 1,1, 1,0,
    0,0, 0,1, 1,1, 1,0,
    0,0, 0,1, 1,1, 1,0,
    0,0, 0,1, 1,1, 1,0,
  ]);

  // Build indices (2 triangles per face, CCW winding = front face in RH system)
  const indices = new Uint16Array(36);
  for (let face = 0; face < 6; face++) {
    const base = face * 4;
    const i = face * 6;
    indices[i]     = base;
    indices[i + 1] = base + 1;
    indices[i + 2] = base + 2;
    indices[i + 3] = base;
    indices[i + 4] = base + 2;
    indices[i + 5] = base + 3;
  }

  return new Geometry3D({ positions, normals, textureCoordinates: [{ set: 0, data: uvs }], indices });
}
