import { basename, dirname, extname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

export function resolveRetentionContext(repositoryPath, options = {}) {
  const repository = resolve(repositoryPath);
  const workspace = dirname(repository);
  const root = resolve(options['artifact-root'] ?? resolve(repository, 'artifacts'));
  const identity = relative(workspace, root);
  if (!identity || identity === '..' || identity.startsWith(`..${sep}`) || isAbsolute(identity) ||
      basename(root) !== 'artifacts' || identity.split(sep).some(part => part.toLowerCase() === '.git')) {
    throw new Error('Retention root must be an artifacts directory inside this workspace');
  }
  if (options['artifact-root'] && !options.policy) throw new Error('An alternate artifact root requires its own explicit policy');
  return { root, stateRoot: resolve(root, '.retention'),
    ownerRoot: resolve(workspace, identity.split(sep)[0]),
    policyPath: resolve(options.policy ?? resolve(repository, 'config/artifact-retention.json')) };
}

export function safeArtifactPath(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f]/u.test(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe artifact identity: ${value}`);
  }
  return value;
}

export function validateRetentionPolicy(value) {
  if (value?.schemaVersion !== 1) throw new Error('Unsupported artifact retention policy');
  for (const key of ['targetBytes', 'lowWaterBytes', 'minimumAgeHours', 'batchBytes', 'batchFiles', 'metadataMaximumBytes', 'summaryMaximumBytes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new Error(`Invalid retention ${key}`);
  }
  if (value.lowWaterBytes >= value.targetBytes) throw new Error('Low-water mark must be below target');
  for (const key of ['protectedPrefixes', 'metadataExtensions', 'cacheDirectoryNames', 'summaryNames']) {
    if (!Array.isArray(value[key]) || !value[key].length || new Set(value[key]).size !== value[key].length) {
      throw new Error(`Invalid retention ${key}`);
    }
  }
  for (const prefix of value.protectedPrefixes) {
    if (!prefix.endsWith('/')) throw new Error('Protected prefixes must name directories');
    safeArtifactPath(prefix.slice(0, -1));
  }
  if (!value.protectedPrefixes.includes('.retention/')) throw new Error('Retention journal must be protected');
  for (const extension of value.metadataExtensions) {
    if (!/^\.[a-z0-9]+$/u.test(extension)) throw new Error('Invalid metadata extension');
  }
  for (const directory of value.cacheDirectoryNames) {
    if (safeArtifactPath(directory).includes('/')) throw new Error('Cache identity must be a directory name');
  }
  for (const name of value.summaryNames) {
    if (safeArtifactPath(name).includes('/')) throw new Error('Summary identity must be a filename');
  }
  return value;
}

export function classifyArtifact(file, policy, nowMs, pinnedPaths = new Set()) {
  const name = safeArtifactPath(file.path);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) {
    throw new Error(`Invalid artifact inventory: ${name}`);
  }
  if (file.link) return 'link';
  if (policy.protectedPrefixes.some(prefix => name.startsWith(prefix)) || pinnedPaths.has(name)) return 'pinned';
  if (nowMs - file.mtimeMs < policy.minimumAgeHours * 3600000) return 'recent';
  const parts = name.split('/');
  // Metadata inside disposable execution trees is archived with that tree.
  const inCache = parts.slice(0, -1).some(part => policy.cacheDirectoryNames.includes(part));
  if (!inCache && file.bytes <= policy.summaryMaximumBytes && policy.summaryNames.includes(posix.basename(name).toLowerCase())) return 'metadata';
  if (!inCache && file.bytes <= policy.metadataMaximumBytes &&
      (policy.metadataExtensions.includes(extname(name).toLowerCase()) || posix.basename(name).startsWith('ARCHIVED-'))) {
    return 'metadata';
  }
  return inCache ? 'archive-cache' : 'archive-evidence';
}

export function createRetentionPlan(files, policyInput, options = {}) {
  const policy = validateRetentionPolicy(policyInput);
  const nowMs = options.nowMs ?? Date.now();
  const pinnedPaths = new Set((options.pinnedPaths ?? []).map(safeArtifactPath));
  const seen = new Set();
  const counts = {};
  let beforeBytes = 0;
  const candidates = [];
  for (const file of files) {
    const identity = safeArtifactPath(file.path).toLowerCase();
    if (seen.has(identity)) throw new Error(`Duplicate artifact identity: ${file.path}`);
    seen.add(identity);
    const kind = classifyArtifact(file, policy, nowMs, pinnedPaths);
    beforeBytes += file.bytes;
    counts[kind] ??= { files: 0, bytes: 0 };
    counts[kind].files++;
    counts[kind].bytes += file.bytes;
    if (kind.startsWith('archive-')) candidates.push({ ...file, kind });
  }
  // Largest objects first releases space early and avoids touching thousands of tiny files unnecessarily.
  candidates.sort((a, b) => b.bytes - a.bytes || a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path, 'en'));
  const selected = [];
  let projectedBytes = beforeBytes;
  if (beforeBytes > policy.targetBytes) {
    for (const file of candidates) {
      if (projectedBytes <= policy.lowWaterBytes) break;
      selected.push(file);
      projectedBytes -= file.bytes;
    }
  }
  // Large captures release space first; directory order for the remainder avoids random seeks
  // through hundreds of thousands of dependency files on a rotating source disk.
  selected.sort((a, b) => {
    const largeA = a.bytes >= 32 * 1024 * 1024;
    const largeB = b.bytes >= 32 * 1024 * 1024;
    return largeA !== largeB ? Number(largeB) - Number(largeA) : largeA ? b.bytes - a.bytes || a.path.localeCompare(b.path, 'en') : a.path.localeCompare(b.path, 'en');
  });
  const batches = [];
  let batch = { files: [], bytes: 0 };
  for (const file of selected) {
    if (batch.files.length && (batch.bytes + file.bytes > policy.batchBytes || batch.files.length >= policy.batchFiles)) {
      batches.push(batch);
      batch = { files: [], bytes: 0 };
    }
    batch.files.push(file);
    batch.bytes += file.bytes;
  }
  if (batch.files.length) batches.push(batch);
  return {
    schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(), targetBytes: policy.targetBytes,
    lowWaterBytes: policy.lowWaterBytes, beforeBytes, projectedBytes,
    targetBlocked: projectedBytes > policy.targetBytes, counts, selectedFiles: selected.length,
    selectedBytes: beforeBytes - projectedBytes, batches,
  };
}
