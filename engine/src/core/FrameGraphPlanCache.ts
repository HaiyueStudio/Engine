/** Private bounded cache. Values must contain structural data only, never GPU objects or callbacks. */
export class FrameGraphPlanCache<T> {
  enabled = true;
  private readonly entries = new Map<string, T>();
  private generation: object | undefined;
  readonly stats = { hits: 0, misses: 0, evictions: 0, invalidations: 0, size: 0, lastReason: 'cold', lastInvalidationReason: 'none' };
  constructor(private readonly capacity = 16) {}
  selectGeneration(generation: object | undefined): void {
    if (generation === this.generation) return;
    this.clear('device-generation'); this.generation = generation;
  }
  get(key: string): T | undefined {
    const value = this.enabled ? this.entries.get(key) : undefined;
    if (value === undefined) {
      this.stats.misses++;
      this.stats.lastReason = !this.enabled ? 'disabled' : this.entries.size ? 'structure-or-scope' : this.stats.lastReason;
    } else {
      this.entries.delete(key); this.entries.set(key, value);
      this.stats.hits++; this.stats.lastReason = 'hit';
    }
    return value;
  }
  set(key: string, value: T): void {
    if (!this.enabled) return;
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) { this.entries.delete(this.entries.keys().next().value!); this.stats.evictions++; }
    this.entries.set(key, value); this.stats.size = this.entries.size;
  }
  clear(reason = 'owner-reset'): void {
    this.entries.clear(); this.stats.size = 0; this.stats.invalidations++; this.stats.lastReason = reason; this.stats.lastInvalidationReason = reason;
  }
}
