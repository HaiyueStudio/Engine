import { gzipSync } from 'node:zlib';

/** Measure emitted files independently, preserving static versus dynamic edges. */
export function measureConsumerLoading(chunks, normalizeModule = value => value) {
  const files = chunks.map(chunk => ({
    fileName: chunk.fileName, isEntry: chunk.isEntry,
    imports: [...chunk.imports], dynamicImports: [...chunk.dynamicImports],
    modules: Object.keys(chunk.modules).map(normalizeModule).sort(),
    rawBytes: Buffer.byteLength(chunk.code),
    gzipBytes: gzipSync(chunk.code, { level: 9 }).byteLength,
  }));
  const initial = staticClosure(files);
  const sum = (selected, field) => selected.reduce((total, file) => total + file[field], 0);
  return {
    schemaVersion: 1, compression: 'per-file-gzip-level-9',
    initialFiles: [...initial].sort(),
    initialGzipBytes: sum(files.filter(file => initial.has(file.fileName)), 'gzipBytes'),
    deferredGzipBytes: sum(files.filter(file => !initial.has(file.fileName)), 'gzipBytes'),
    totalGzipBytes: sum(files, 'gzipBytes'), files,
  };
}

export function validateConsumerLoadingPolicy(policy, fullBudget) {
  const errors = [];
  if (!Number.isSafeInteger(fullBudget) || fullBudget <= 0) errors.push('loading policy requires the existing full consumer budget');
  if (!policy || policy.schemaVersion !== 1) errors.push('loading policy requires schemaVersion 1');
  for (const key of ['maxInitialGzipBytes', 'maxTotalGzipBytes']) {
    if (!Number.isInteger(policy?.[key]) || policy[key] <= 0) errors.push(`loading policy requires positive ${key}`);
  }
  if (policy?.maxInitialGzipBytes >= policy?.maxTotalGzipBytes || policy?.maxTotalGzipBytes > fullBudget) {
    errors.push('loading limits must preserve the full consumer budget and require a smaller initial payload');
  }
  if (!Array.isArray(policy?.deferredModuleMarkers) || !policy.deferredModuleMarkers.length
    || policy.deferredModuleMarkers.some(marker => typeof marker !== 'string' || !marker)) {
    errors.push('loading policy requires deferred module markers');
  }
  return errors;
}

export function validateConsumerLoading(result, policy, fullBudget) {
  const errors = validateConsumerLoadingPolicy(policy, fullBudget);
  if (errors.length) return errors;
  if (result?.schemaVersion !== 1 || result.compression !== 'per-file-gzip-level-9'
    || !Array.isArray(result.files) || !result.files.length) return ['missing split consumer loading evidence'];
  const files = result.files;
  if (files.some(file => !file || typeof file.fileName !== 'string' || !file.fileName
    || typeof file.isEntry !== 'boolean'
    || ['imports', 'dynamicImports', 'modules'].some(key => !Array.isArray(file[key])
      || file[key].some(value => typeof value !== 'string')))) return ['invalid split chunk metadata'];
  const names = new Set(files.map(file => file.fileName));
  if (names.size !== files.length) errors.push('duplicate emitted chunk');
  if (files.filter(file => file.isEntry).length !== 1) errors.push('expected one consumer entry');
  for (const file of files) {
    if (![file.rawBytes, file.gzipBytes].every(value => Number.isInteger(value) && value > 0)) errors.push('invalid chunk byte count');
    for (const dependency of [...file.imports, ...file.dynamicImports]) {
      if (!names.has(dependency)) errors.push(`unresolved chunk ${dependency}`);
    }
  }
  const initial = staticClosure(files);
  const reachable = staticClosure(files, true);
  if (reachable.size !== names.size) errors.push('unreachable emitted chunk');
  if (JSON.stringify([...initial].sort()) !== JSON.stringify(result.initialFiles)) errors.push('initial file closure mismatch');
  const sum = selected => selected.reduce((total, file) => total + file.gzipBytes, 0);
  const initialBytes = sum(files.filter(file => initial.has(file.fileName)));
  const totalBytes = sum(files);
  if (initialBytes !== result.initialGzipBytes || totalBytes !== result.totalGzipBytes
    || totalBytes - initialBytes !== result.deferredGzipBytes) errors.push('loading byte totals mismatch');
  if (initialBytes > policy.maxInitialGzipBytes) errors.push(`initial gzip ${initialBytes} exceeds ${policy.maxInitialGzipBytes}`);
  if (totalBytes > policy.maxTotalGzipBytes) errors.push(`total gzip ${totalBytes} exceeds ${policy.maxTotalGzipBytes}`);
  for (const marker of policy.deferredModuleMarkers) {
    const owners = files.filter(file => file.modules.some(module => module.includes(marker)));
    if (!owners.length) errors.push(`missing deferred capability ${marker}`);
    if (owners.some(file => initial.has(file.fileName))) errors.push(`eager capability ${marker}`);
  }
  return errors;
}

function staticClosure(files, dynamic = false) {
  const byName = new Map(files.map(file => [file.fileName, file]));
  const visited = new Set();
  const visit = name => {
    if (visited.has(name) || !byName.has(name)) return;
    visited.add(name);
    const file = byName.get(name);
    for (const dependency of [...file.imports, ...(dynamic ? file.dynamicImports : [])]) visit(dependency);
  };
  for (const file of files.filter(file => file.isEntry)) visit(file.fileName);
  return visited;
}
