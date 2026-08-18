declare module 'earcut' {
  export default function earcut(
    vertices: ArrayLike<number>,
    holeIndices?: ArrayLike<number> | null,
    dimensions?: number,
  ): number[];
}
