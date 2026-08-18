/** Narrow adapters for third-party packages that do not ship TypeScript declarations. */
declare module 'pako' {
  export function inflate(data: Uint8Array): Uint8Array;
}

declare module 'earcut' {
  function earcut(vertices: number[], holes?: number[], dimensions?: number): number[];
  export default earcut;
}
