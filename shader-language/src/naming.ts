const WGSL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isWgslIdentifier(value: string): boolean {
  return WGSL_IDENTIFIER.test(value);
}

/** Code-point ordering avoids host-locale differences in hashes and bindings. */
export function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function modulePrefix(moduleId: string): string {
  return `hy_${sanitize(moduleId)}_${fnv1a32(moduleId)}`;
}

export function moduleSymbolName(moduleId: string, symbolId: string): string {
  return `${modulePrefix(moduleId)}_${sanitize(symbolId)}`;
}

export function resourceVariableName(resourceId: string): string {
  return `hy_res_${sanitize(resourceId)}_${fnv1a32(resourceId)}`;
}

export function uniformStructName(resourceId: string): string {
  return `hy_uniform_${sanitize(resourceId)}_${fnv1a32(resourceId)}`;
}

export function specializationName(specializationId: string): string {
  return `hy_spec_${sanitize(specializationId)}_${fnv1a32(specializationId)}`;
}

function sanitize(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `_${sanitized}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
