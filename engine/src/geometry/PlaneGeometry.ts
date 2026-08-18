import { Geometry3D } from './Geometry3D';

export interface PlaneGeometryOptions {
  width?: number;
  height?: number;
  /** Which axis the plane's front face points along (default: 'z', faces +Z) */
  normal?: 'x' | 'y' | 'z';
}

/**
 * Creates a flat quad (2 triangles) with CCW winding.
 * UV: (0,0) at top-left corner, (1,1) at bottom-right corner.
 */
export function createPlane3D(options: PlaneGeometryOptions = {}): Geometry3D {
  const { width = 1, height = 1, normal = 'z' } = options;
  const hw = width  / 2;
  const hh = height / 2;

  //   v3(-,+) --- v2(+,+)
  //     |               |
  //   v0(-,-) --- v1(+,-)
  //
  // CCW front face: v0 v1 v2, v0 v2 v3

  let positions: Float32Array;
  let normals: Float32Array;

  if (normal === 'z') {
    // XY plane, front toward +Z
    positions = new Float32Array([
      -hw, -hh, 0,
       hw, -hh, 0,
       hw,  hh, 0,
      -hw,  hh, 0,
    ]);
    normals = new Float32Array([0,0,1, 0,0,1, 0,0,1, 0,0,1]);
  } else if (normal === 'y') {
    // XZ plane, front toward +Y
    positions = new Float32Array([
      -hw, 0,  hh,
       hw, 0,  hh,
       hw, 0, -hh,
      -hw, 0, -hh,
    ]);
    normals = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0]);
  } else {
    // YZ plane, front toward +X
    positions = new Float32Array([
      0, -hh, -hw,
      0, -hh,  hw,
      0,  hh,  hw,
      0,  hh, -hw,
    ]);
    normals = new Float32Array([1,0,0, 1,0,0, 1,0,0, 1,0,0]);
  }

  // UV: V=0 at top of quad (y=+hh), V=1 at bottom (y=-hh)
  const uvs = new Float32Array([
    0, 1,   // v0 bottom-left
    1, 1,   // v1 bottom-right
    1, 0,   // v2 top-right
    0, 0,   // v3 top-left
  ]);

  const indices = new Uint16Array([0, 1, 2,  0, 2, 3]);

  return new Geometry3D({ positions, normals, textureCoordinates: [{ set: 0, data: uvs }], indices });
}
