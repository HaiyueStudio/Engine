/** Compact generated metadata while preserving keys and JSON-compatible values. */
export function compactArtifactLiteral(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(compactArtifactLiteral).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value).map(([key, entry]) => {
      const name = key === '__proto__' ? '["__proto__"]' : /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
      return `${name}:${compactArtifactLiteral(entry)}`;
    }).join(',')}}`;
  }
  throw new TypeError('Artifact metadata must contain plain JSON-compatible values.');
}
