export type DeterministicSeed = number | string;

/** Small reproducible PRNG intended for gameplay simulation, never for security. */
export class DeterministicRandom {
  private readonly _initialState: number;
  private _state: number;

  constructor(seed: DeterministicSeed) {
    this._initialState = normalizeSeed(seed);
    this._state = this._initialState;
  }

  get state(): number { return this._state >>> 0; }

  reset(): this { this._state = this._initialState; return this; }

  restore(state: number): this {
    if (!Number.isSafeInteger(state) || state < 0 || state > 0xffff_ffff) throw new RangeError('Random state must be an unsigned 32-bit integer.');
    this._state = state >>> 0;
    return this;
  }

  nextUint32(): number {
    let value = this._state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    this._state >>>= 0;
    return (value ^ value >>> 14) >>> 0;
  }

  nextFloat(): number { return this.nextUint32() / 0x1_0000_0000; }

  nextInt(minimum: number, maximumExclusive: number): number {
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximumExclusive) || maximumExclusive <= minimum) {
      throw new RangeError('Random integer bounds must be safe integers with maximumExclusive greater than minimum.');
    }
    return minimum + Math.floor(this.nextFloat() * (maximumExclusive - minimum));
  }
}

function normalizeSeed(seed: DeterministicSeed): number {
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed)) throw new TypeError('Numeric deterministic seed must be a safe integer.');
    return (seed >>> 0) || 0x6d2b79f5;
  }
  if (typeof seed !== 'string' || seed.length < 1 || seed.length > 1_024) throw new TypeError('String deterministic seed must contain 1-1024 characters.');
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 0x6d2b79f5;
}
