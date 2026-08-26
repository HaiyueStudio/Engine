export type SimulationStateValue = null | boolean | number | string | readonly SimulationStateValue[] | { readonly [key: string]: SimulationStateValue };

/** Stable non-cryptographic hash seam for deterministic replay comparisons. */
export function hashSimulationState(value: SimulationStateValue): string {
  const canonical = canonicalSimulationState(value);
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(canonical);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

export function canonicalSimulationState(value: SimulationStateValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Simulation state numbers must be finite.');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalSimulationState(item)).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Simulation state must contain JSON-compatible values.');
  const record = value as Readonly<Record<string, SimulationStateValue>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalSimulationState(record[key]!)}`).join(',')}}`;
}
