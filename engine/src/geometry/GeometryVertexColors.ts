import type { Geometry3D } from './Geometry3D';

// Private G02 port. Public geometry/import APIs are reviewed in G07.
const colors = new WeakMap<Geometry3D, Float32Array>();

/** Linear, normalized RGBA; copied so changes must pass through this versioned port. */
export function setGeometryVertexColors(geometry: Geometry3D, rgba: Float32Array | null): void {
  if (rgba !== null) {
    if (rgba.length !== geometry.vertexCount * 4) throw new RangeError('Vertex RGBA count must match geometry.vertexCount');
    for (const value of rgba) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Vertex RGBA must be finite and within [0, 1]');
    }
    colors.set(geometry, rgba.slice());
  } else {
    if (!colors.delete(geometry)) return;
  }
  geometry.markDirty();
}

/** UV1 + RGBA share one slot, retaining the default eight-buffer WebGPU limit. */
export function packGeometryUv1Color(geometry: Geometry3D): Float32Array {
  const rgba = colors.get(geometry);
  if (rgba && rgba.length !== geometry.vertexCount * 4) throw new RangeError('Vertex RGBA count no longer matches geometry.vertexCount');
  const uv = geometry.getTextureCoordinatesForChannel(1) ?? geometry.getTextureCoordinatesForChannel(0);
  const data = new Float32Array(geometry.vertexCount * 6);
  for (let vertex = 0; vertex < geometry.vertexCount; vertex++) {
    const target = vertex * 6;
    data[target] = uv?.[vertex * 2] ?? 0;
    data[target + 1] = uv?.[vertex * 2 + 1] ?? 0;
    for (let channel = 0; channel < 4; channel++) data[target + 2 + channel] = rgba?.[vertex * 4 + channel] ?? 1;
  }
  return data;
}
