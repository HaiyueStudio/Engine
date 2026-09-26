/** Emit lossless source assembly for variants whose specialization preserves line count. */
export function emitLineVariantExpression(baseIdentifier, base, variant) {
  if (!/^[A-Za-z_$][\w$]*$/.test(baseIdentifier)) throw new Error('Invalid source variable identifier.');
  const original = base.split(/(?<=\n)/), changed = variant.split(/(?<=\n)/);
  if (original.length !== changed.length) throw new Error('Shader variants must preserve source line count.');
  const parts = [];
  let offset = 0, start = 0;
  for (let index = 0; index < original.length; index++) {
    if (original[index] !== changed[index]) {
      if (offset > start) parts.push(`${baseIdentifier}.slice(${start}, ${offset})`);
      parts.push(JSON.stringify(changed[index]));
      start = offset + original[index].length;
    }
    offset += original[index].length;
  }
  if (start === 0 && parts.length === 0) return baseIdentifier;
  if (start < base.length) parts.push(`${baseIdentifier}.slice(${start})`);
  return parts.join(' + ');
}
