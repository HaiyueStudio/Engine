import { createHash } from 'node:crypto';

export function validateReviewArchive(manifest, bytes) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  check(manifest?.schemaVersion === 1 && /^[a-z0-9-]+\.zip$/.test(manifest.archive ?? ''), 'Invalid review archive identity');
  check(/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '') && Buffer.isBuffer(bytes) &&
    bytes.length === manifest.archiveBytes && createHash('sha256').update(bytes).digest('hex') === manifest.sha256, 'Review archive bytes/hash mismatch');
  check(Array.isArray(manifest.files) && manifest.files.length > 0, 'Missing archived file inventory');
  const paths = new Set(); let total = 0;
  for (const file of manifest.files) {
    check(typeof file.path === 'string' && /^(?:Engine|milestones)\//.test(file.path) &&
      file.path.split('/').every(part => part && part !== '.' && part !== '..') &&
      !/[:\\\x00-\x1f]/.test(file.path) && !paths.has(file.path), 'Unsafe or duplicate archived path');
    check(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256 ?? ''), 'Invalid archived file binding');
    paths.add(file.path); total += file.bytes;
  }
  check(total === manifest.originalBytes, 'Archived inventory byte count mismatch');
  return { files: paths.size, compressedBytes: bytes.length, originalBytes: total };
}
