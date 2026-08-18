export class ZeroVectorCache {
  private readonly maxEntries: number;
  private readonly vec3Cache = new Map<number, Float32Array>();
  private readonly vec2Cache = new Map<number, Float32Array>();

  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  /**
   * Returns a shared read-only zero-filled vec3 buffer for upload paths.
   * Callers must not mutate the returned array.
   */
  vec3(vertexCount: number): Readonly<Float32Array> {
    return this.getOrCreate(this.vec3Cache, vertexCount, 3);
  }

  /**
   * Returns a shared read-only zero-filled vec2 buffer for upload paths.
   * Callers must not mutate the returned array.
   */
  vec2(vertexCount: number): Readonly<Float32Array> {
    return this.getOrCreate(this.vec2Cache, vertexCount, 2);
  }

  clear(): void {
    this.vec3Cache.clear();
    this.vec2Cache.clear();
  }

  private getOrCreate(cache: Map<number, Float32Array>, vertexCount: number, components: number): Readonly<Float32Array> {
    const key = Math.max(0, Math.floor(vertexCount));
    let data = cache.get(key);
    if (data) {
      cache.delete(key);
      cache.set(key, data);
      return data;
    }
    data = new Float32Array(key * components);
    cache.set(key, data);
    this.evictOldest(cache);
    return data;
  }

  private evictOldest(cache: Map<number, Float32Array>): void {
    while (cache.size > this.maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) return;
      cache.delete(oldest);
    }
  }
}

export const sharedZeroVectorCache = new ZeroVectorCache();
