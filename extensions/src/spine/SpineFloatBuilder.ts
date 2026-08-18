export class SpineFloatBuilder {
  data: Float32Array;
  length = 0;

  constructor(initialCapacity = 1024) {
    this.data = new Float32Array(initialCapacity);
  }

  clear(): void {
    this.length = 0;
  }

  get byteLength(): number {
    return this.length * 4;
  }

  get(index: number): number {
    return this.data[index] ?? 0;
  }

  push(...values: number[]): void {
    this.ensureCapacity(this.length + values.length);
    this.data.set(values, this.length);
    this.length += values.length;
  }

  push8(a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): void {
    this.ensureCapacity(this.length + 8);
    const offset = this.length;
    this.data[offset] = a;
    this.data[offset + 1] = b;
    this.data[offset + 2] = c;
    this.data[offset + 3] = d;
    this.data[offset + 4] = e;
    this.data[offset + 5] = f;
    this.data[offset + 6] = g;
    this.data[offset + 7] = h;
    this.length += 8;
  }

  appendArray(values: ArrayLike<number>, length = values.length): void {
    this.ensureCapacity(this.length + length);
    for (let i = 0; i < length; i++) this.data[this.length + i] = values[i] ?? 0;
    this.length += length;
  }

  truncate(length: number): void {
    this.length = Math.max(0, Math.min(this.length, length));
  }

  /** Grows storage if needed and exposes a reusable writable region without allocating a temporary array. */
  reserveLength(length: number): void {
    const nextLength = Math.max(0, length);
    this.ensureCapacity(nextLength);
    this.length = nextLength;
  }

  private ensureCapacity(required: number): void {
    if (this.data.length >= required) return;
    let nextCapacity = Math.max(1, this.data.length);
    while (nextCapacity < required) nextCapacity *= 2;
    const next = new Float32Array(nextCapacity);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}
