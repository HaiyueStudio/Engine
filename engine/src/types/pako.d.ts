declare module 'pako' {
  export function inflate(data: Uint8Array, options?: { raw?: boolean; to?: 'string' }): Uint8Array;
}
