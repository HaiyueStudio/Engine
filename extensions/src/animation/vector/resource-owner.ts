export interface OwnedResource<T> { readonly value: T; readonly pixels: number; readonly destroy: (value: T) => void; }

export class VectorResourceOwner<T> {
  private readonly live = new Map<string, OwnedResource<T>>();
  private readonly retired: OwnedResource<T>[] = [];
  private isDisposed = false;

  get size(): number { return this.live.size; }
  get retiredSize(): number { return this.retired.length; }

  acquire(key: string, pixels: number, create: () => T, destroy: (value: T) => void): T {
    if (this.isDisposed) throw new Error('E_VECTOR_OWNER_DISPOSED');
    const current = this.live.get(key);
    if (current) return current.value;
    const value = create();
    this.live.set(key, { value, pixels, destroy });
    return value;
  }

  retire(key: string): void {
    const current = this.live.get(key);
    if (!current) return;
    this.live.delete(key);
    this.retired.push(current);
  }

  retireAll(): void {
    for (const resource of this.live.values()) this.retired.push(resource);
    this.live.clear();
  }

  flushRetired(): void {
    for (const resource of this.retired.splice(0)) resource.destroy(resource.value);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.retireAll();
    this.flushRetired();
  }
}
