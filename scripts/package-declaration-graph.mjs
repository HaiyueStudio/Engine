import { posix } from 'node:path';

/** Returns the recursive declaration closure rooted at public `types` targets. */
export function collectReachablePackageDeclarations({ packageJson, declarations }) {
  const sources = new Map(Object.entries(declarations).map(([path, source]) => [normalizePackagePath(path), source]));
  const reachable = new Set();
  const pending = collectPackageTypeTargets(packageJson);

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current) || !sources.has(current)) continue;
    reachable.add(current);
    const source = sources.get(current);
    const specifierPattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)[`'"]([^`'"]+)[`'"]/gu;
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(current), specifier));
      const candidates = /\.[cm]?js$/u.test(resolved)
        ? [resolved.replace(/\.[cm]?js$/u, '.d.ts')]
        : resolved.endsWith('.d.ts')
          ? [resolved]
          : [`${resolved}.d.ts`, `${resolved}/index.d.ts`];
      const target = candidates.find(candidate => sources.has(candidate));
      if (target && !reachable.has(target)) pending.push(target);
    }
  }

  return reachable;
}

function collectPackageTypeTargets(packageJson) {
  const targets = new Set();
  if (typeof packageJson.types === 'string') targets.add(normalizePackagePath(packageJson.types));
  for (const target of Object.values(packageJson.exports ?? {})) {
    if (target && typeof target === 'object' && typeof target.types === 'string') {
      targets.add(normalizePackagePath(target.types));
    }
  }
  return [...targets];
}

function normalizePackagePath(path) {
  const normalized = path.startsWith('./') ? path.slice(2) : path;
  return normalized.replaceAll('\\', '/');
}
