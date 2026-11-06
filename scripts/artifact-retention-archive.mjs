import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink, mkdir, link, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip, gunzipSync } from 'node:zlib';
import { safeArtifactPath } from './artifact-retention-policy.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const verifiedProofs = new WeakMap();

export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function validateArtifactRoot(root, workspace) {
  const base = resolve(root), allowed = resolve(workspace);
  const identity = relative(allowed, base);
  if (!identity || identity === '..' || identity.startsWith(`..${sep}`) || isAbsolute(identity)) {
    throw new Error('Artifact root escapes its workspace');
  }
  let current = base;
  for (;;) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Artifact root has a symlink/reparse ancestor');
    if (current === allowed) break;
    current = dirname(current);
  }
  const expected = resolve(await realpath(allowed), identity), physical = await realpath(base);
  if (process.platform === 'win32' ? expected.toLowerCase() !== physical.toLowerCase() : expected !== physical) {
    throw new Error('Artifact root was physically redirected');
  }
  return physical;
}

export async function durableJson(path, value, { exclusive = false } = {}) {
  const temporary = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  if (exclusive) {
    try { await lstat(path); throw new Error(`Refusing to replace durable record: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await rename(temporary, path);
}

export async function safeSource(root, identity, cache) {
  safeArtifactPath(identity);
  const base = resolve(root);
  if (!cache?.rootChecked) {
    if ((await lstat(base)).isSymbolicLink()) throw new Error('Artifact root is a symlink/reparse point');
    if (cache) cache.rootChecked = true;
  }
  const target = resolve(base, ...identity.split('/'));
  const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Artifact path escapes root');
  let current = base;
  for (const part of identity.split('/')) {
    current = resolve(current, part);
    if (!cache?.parents.has(current) || current === target) {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Reparse/symlink artifact path: ${identity}`);
      if (info.isDirectory()) cache?.parents.add(current);
    }
  }
  const physicalBase = cache?.base ?? await realpath(base);
  const physicalTarget = await realpath(target);
  const physicalRelative = relative(physicalBase, physicalTarget);
  if (physicalRelative.startsWith(`..${sep}`) || physicalRelative === '..' || isAbsolute(physicalRelative)) {
    throw new Error('Physical artifact path escapes root');
  }
  const expectedPhysical = resolve(physicalBase, ...identity.split('/'));
  if (process.platform === 'win32' ? physicalTarget.toLowerCase() !== expectedPhysical.toLowerCase() : physicalTarget !== expectedPhysical) {
    throw new Error('Artifact parent was redirected after validation');
  }
  return target;
}

function octal(buffer, number, offset, length) {
  const value = number.toString(8);
  if (value.length > length - 1) {
    // Positive GNU/base-256 numeric extension for captures larger than 8 GiB.
    let remaining = BigInt(number);
    for (let index = offset + length - 1; index >= offset; index--) { buffer[index] = Number(remaining & 255n); remaining >>= 8n; }
    if (remaining || buffer[offset] & 128) throw new Error('Artifact exceeds TAR numeric capacity');
    buffer[offset] |= 128;
    return;
  }
  buffer.write(value.padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function tarNumber(buffer) {
  if (!(buffer[0] & 128)) return Number.parseInt(buffer.toString('ascii').replace(/\0.*$/u, '').trim(), 8);
  let value = BigInt(buffer[0] & 127);
  for (const byte of buffer.subarray(1)) value = value * 256n + BigInt(byte);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe TAR numeric value');
  return Number(value);
}

function header(member, bytes) {
  const block = Buffer.alloc(512);
  block.write(member, 0, 100, 'ascii');
  octal(block, 0o644, 100, 8); octal(block, 0, 108, 8); octal(block, 0, 116, 8);
  octal(block, bytes, 124, 12); octal(block, 0, 136, 12);
  block.fill(32, 148, 156); block[156] = 48;
  block.write('ustar\0', 257, 6, 'ascii'); block.write('00', 263, 2, 'ascii');
  block.write(block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

function sameSnapshot(info, expected) {
  const bytes = typeof info.size === 'bigint' ? Number(info.size) : info.size;
  const milliseconds = typeof info.mtimeNs === 'bigint' ? Number(info.mtimeNs / 1000000n) : Math.floor(info.mtimeMs);
  return info.isFile() && bytes === expected.bytes && milliseconds === Math.floor(expected.mtimeMs);
}

function coalescedTarBlocks() {
  const capacity = 256 * 1024;
  let buffer = Buffer.allocUnsafe(capacity), used = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0;
      while (offset < chunk.length) {
        const length = Math.min(capacity - used, chunk.length - offset);
        chunk.copy(buffer, used, offset, offset + length);
        used += length; offset += length;
        if (used === capacity) { this.push(buffer); buffer = Buffer.allocUnsafe(capacity); used = 0; }
      }
      callback();
    },
    flush(callback) { if (used) this.push(buffer.subarray(0, used)); callback(); },
  });
}

export async function writeArchive(root, files, output, progress = () => {}) {
  const entries = [];
  const cache = { base: await realpath(root), parents: new Set() };
  let completedBytes = 0;
  const pending = new Map();
  async function prepare(index) {
    const expected = files[index];
    const source = await safeSource(root, expected.path, cache);
    if (!sameSnapshot(await lstat(source, { bigint: true }), expected)) throw new Error(`Source changed since plan: ${expected.path}`);
    if (expected.bytes > 128 * 1024) return { source };
    // Fixed-size, bounded reads cannot grow with a concurrently extended file.
    const contents = Buffer.allocUnsafe(expected.bytes);
    const handle = await open(source, 'r');
    let offset = 0;
    try {
      while (offset < contents.length) {
        const result = await handle.read(contents, offset, contents.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
    } finally { await handle.close(); }
    return { source, contents: contents.subarray(0, offset) };
  }
  function prefetch(index) {
    for (let next = index; next < Math.min(files.length, index + 4); next++) {
      if (!pending.has(next)) pending.set(next, prepare(next).catch(error => ({ error })));
    }
  }
  async function* tar() {
    try {
      prefetch(0);
      for (let index = 0; index < files.length; index++) {
        const expected = files[index];
        const prepared = await pending.get(index);
        pending.delete(index); prefetch(index + 1);
        if (prepared.error) throw prepared.error;
        const { source, contents } = prepared;
        const member = `files/${index.toString().padStart(8, '0')}`;
        yield header(member, expected.bytes);
        const hash = createHash('sha256'); let bytes = 0;
        const chunks = contents === undefined ? createReadStream(source, { highWaterMark: 1024 * 1024 }) : [contents];
        for await (const chunk of chunks) {
          bytes += chunk.length; hash.update(chunk); yield chunk;
          progress({ phase: 'compress', path: expected.path, bytes: completedBytes + bytes });
        }
        if (bytes !== expected.bytes || !sameSnapshot(await lstat(source, { bigint: true }), expected)) throw new Error(`Source changed while archiving: ${expected.path}`);
        const padding = (512 - bytes % 512) % 512;
        if (padding) yield Buffer.alloc(padding);
        entries.push({ ...expected, member, sha256: hash.digest('hex') });
        completedBytes += bytes;
      }
      yield Buffer.alloc(1024);
    } finally { await Promise.allSettled(pending.values()); }
  }
  const hash = createHash('sha256'); let archiveBytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); archiveBytes += chunk.length; callback(null, chunk); } });
  await pipeline(Readable.from(tar()), coalescedTarBlocks(), createGzip({ level: 1 }), meter, createWriteStream(output, { flags: 'wx' }));
  const handle = await open(output, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  return { archiveBytes, archiveSha256: hash.digest('hex'), files: entries };
}

// Only our fixed, file-only USTAR subset is accepted; no archive paths are used as filesystem paths.
export async function verifyArchive(archive, manifest, { consume, progress = () => {} } = {}) {
  const originalInfo = await lstat(archive);
  const compressedHash = createHash('sha256'); let compressedBytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) { compressedHash.update(chunk); compressedBytes += chunk.length; callback(null, chunk); } });
  const input = createReadStream(archive);
  const gunzip = createGunzip();
  const complete = pipeline(input, meter, gunzip);
  complete.catch(() => {});
  const iterator = gunzip[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), position = 0, verifiedBytes = 0;
  async function take(maximum) {
    if (position === buffer.length) {
      const next = await iterator.next();
      if (next.done) return null;
      buffer = next.value; position = 0;
    }
    const result = buffer.subarray(position, position + maximum);
    position += result.length;
    return result;
  }
  async function exact(bytes) {
    const chunks = []; let left = bytes;
    while (left) { const chunk = await take(left); if (!chunk) throw new Error('Truncated retention archive'); chunks.push(chunk); left -= chunk.length; }
    return Buffer.concat(chunks, bytes);
  }
  try {
    const seen = new Set();
    for (const file of manifest.files) {
      safeArtifactPath(file.path);
      if (!/^files\/[0-9]{8}$/u.test(file.member) || seen.has(file.member)) throw new Error('Unsafe/duplicate archive member');
      seen.add(file.member);
      const block = await exact(512);
      const name = block.subarray(0, 100).toString('ascii').split('\0')[0];
      const bytes = tarNumber(block.subarray(124, 136));
      const checksum = Number.parseInt(block.subarray(148, 156).toString('ascii').trim(), 8);
      const checksumBlock = Buffer.from(block); checksumBlock.fill(32, 148, 156);
      if (name !== file.member || bytes !== file.bytes || block[156] !== 48 ||
          checksum !== checksumBlock.reduce((sum, byte) => sum + byte, 0)) throw new Error(`Archive header mismatch: ${file.path}`);
      const hash = createHash('sha256'); let remaining = bytes;
      while (remaining) {
        const chunk = await take(remaining); if (!chunk) throw new Error('Truncated archived file');
        hash.update(chunk); remaining -= chunk.length; verifiedBytes += chunk.length;
        if (consume) await consume(file, chunk);
        progress({ phase: 'verify', path: file.path, bytes: verifiedBytes });
      }
      if (hash.digest('hex') !== file.sha256) throw new Error(`Archived SHA-256 mismatch: ${file.path}`);
      const padding = (512 - bytes % 512) % 512;
      if (padding && (await exact(padding)).some(byte => byte !== 0)) throw new Error('Invalid archive padding');
    }
    if ((await exact(1024)).some(byte => byte !== 0) || await take(1)) throw new Error('Unexpected archive trailer/members');
    await complete;
    if (compressedBytes !== manifest.archiveBytes || compressedHash.digest('hex') !== manifest.archiveSha256) {
      throw new Error('Compressed archive bytes/SHA-256 mismatch');
    }
    const proof = { files: manifest.files.length, bytes: verifiedBytes, archiveBytes: compressedBytes };
    const info = await lstat(archive);
    if (info.size !== originalInfo.size || info.mtimeMs !== originalInfo.mtimeMs) throw new Error('Archive changed during readback');
    verifiedProofs.set(proof, { filesHash: sha256(JSON.stringify(manifest.files)), archive, bytes: info.size, mtimeMs: Math.floor(info.mtimeMs) });
    return proof;
  } finally {
    input.destroy(); meter.destroy(); gunzip.destroy();
  }
}

export async function removeVerifiedSources(root, files, proof, progress = () => {}) {
  const binding = verifiedProofs.get(proof);
  if (!binding || binding.filesHash !== sha256(JSON.stringify(files)) || !sameSnapshot(await lstat(binding.archive), binding)) {
    throw new Error('Source removal requires a matching live archive-readback proof');
  }
  let removedFiles = 0, removedBytes = 0, alreadyAbsent = 0;
  const cache = { base: await realpath(root), parents: new Set() };
  for (const expected of files) {
    let source;
    try { source = await safeSource(root, expected.path, cache); }
    catch (error) { if (error.code === 'ENOENT') { alreadyAbsent++; continue; } throw error; }
    if (!sameSnapshot(await lstat(source, { bigint: true }), expected) || await hashFile(source) !== expected.sha256 ||
        !sameSnapshot(await lstat(source, { bigint: true }), expected)) throw new Error(`Refusing to remove changed source: ${expected.path}`);
    await unlink(source);
    removedFiles++; removedBytes += expected.bytes;
    progress({ phase: 'remove', files: removedFiles, bytes: removedBytes });
  }
  return { removedFiles, removedBytes, alreadyAbsent };
}

export async function readBoundJson(path, expectedHash) {
  const bytes = await readFile(path);
  if (expectedHash && sha256(bytes) !== expectedHash) throw new Error(`Record SHA-256 mismatch: ${path}`);
  return JSON.parse(path.endsWith('.gz') ? gunzipSync(bytes) : bytes);
}

export async function compactRecord(source) {
  const destination = `${source}.gz`;
  try { await lstat(source); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await lstat(destination);
    return destination;
  }
  const originalHash = await hashFile(source);
  let exists = false;
  try { await lstat(destination); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${destination}.tmp-${process.pid}`;
  if (!exists) {
    await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(temporary, { flags: 'wx' }));
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const compressed = exists ? destination : temporary;
  const hash = createHash('sha256'); let bytes = 0;
  await pipeline(createReadStream(compressed), createGunzip(), async chunks => {
    for await (const chunk of chunks) { hash.update(chunk); bytes += chunk.length; }
  });
  if (hash.digest('hex') !== originalHash || await hashFile(source) !== originalHash) {
    throw new Error('Record compaction readback/source hash mismatch; original retained');
  }
  if (!exists) { await link(temporary, destination); await unlink(temporary); }
  await durableJson(`${source}.compression.json`, { schemaVersion: 1, originalBytes: bytes, originalSha256: originalHash,
    gzip: destination, gzipBytes: (await lstat(destination)).size, gzipSha256: await hashFile(destination) });
  await unlink(source);
  return destination;
}

export async function pruneEmptyArtifactParents(root, files, progress = () => {}) {
  const identities = new Set();
  for (const file of files) {
    const parts = safeArtifactPath(file.path).split('/');
    while (parts.length > 1) { parts.pop(); identities.add(parts.join('/')); }
  }
  let removedDirectories = 0, checkedDirectories = 0;
  const ordered = [...identities].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b, 'en'));
  const cache = { base: await realpath(root), parents: new Set() };
  async function removeEmpty(identity) {
    try {
      const directory = await safeSource(root, identity, cache);
      await rmdir(directory); // Deliberately non-recursive: a single remaining file protects its directory.
      removedDirectories++;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code) && !/Reparse|symlink|redirected/u.test(error.message)) throw error;
    }
    progress({ phase: 'empty-directories', checked: ++checkedDirectories, total: ordered.length, removedDirectories });
  }
  // Same-depth directories cannot contain one another; finish each depth before its parents.
  let start = 0;
  while (start < ordered.length) {
    const depth = ordered[start].split('/').length;
    let end = start + 1;
    while (end < ordered.length && ordered[end].split('/').length === depth) end++;
    let next = start;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, end - start) }, async () => {
      while (next < end) { const identity = ordered[next++]; await removeEmpty(identity); }
    }));
    const failed = workers.find(worker => worker.status === 'rejected');
    if (failed) throw failed.reason;
    start = end;
  }
  return removedDirectories;
}
