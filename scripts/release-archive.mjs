import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';

const BLOCK_SIZE = 512;

export function createDeterministicTar(outputPath, roots) {
  const descriptor = openSync(outputPath, 'w');
  try {
    for (const root of roots) {
      const source = resolve(root.source);
      const prefix = normalizeArchivePath(root.prefix ?? basename(source));
      appendPath(descriptor, source, prefix);
    }
    writeSync(descriptor, Buffer.alloc(BLOCK_SIZE * 2));
  } finally {
    closeSync(descriptor);
  }
  const contents = readFileSync(outputPath);
  return { bytes: contents.byteLength, sha256: createHash('sha256').update(contents).digest('hex') };
}

export function listScannableFiles(roots, maxBytes = 16 * 1024 * 1024) {
  const files = [];
  for (const root of roots) walk(root.source, normalizeArchivePath(root.prefix ?? basename(root.source)), files, maxBytes);
  return files;
}

function appendPath(descriptor, source, archivePath) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    writeHeader(descriptor, archivePath, { type: '2', mode: 0o777, size: 0, link: safeLinkTarget(source, archivePath) });
    return;
  }
  if (stat.isDirectory()) {
    writeHeader(descriptor, `${archivePath.replace(/\/$/u, '')}/`, { type: '5', mode: 0o755, size: 0 });
    for (const name of readdirSync(source).sort()) appendPath(descriptor, join(source, name), `${archivePath}/${name}`);
    return;
  }
  if (!stat.isFile()) throw new Error(`Unsupported release archive entry ${source}.`);
  const contents = readFileSync(source);
  writeHeader(descriptor, archivePath, {
    type: '0',
    mode: stat.mode & 0o111 ? 0o755 : 0o644,
    size: contents.byteLength,
  });
  writeSync(descriptor, contents);
  const padding = (BLOCK_SIZE - (contents.byteLength % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding > 0) writeSync(descriptor, Buffer.alloc(padding));
}

function writeHeader(descriptor, path, { type, mode, size, link = '' }) {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(BLOCK_SIZE);
  writeText(header, name, 0, 100);
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  writeText(header, type, 156, 1);
  writeText(header, link, 157, 100);
  writeText(header, 'ustar\0', 257, 6);
  writeText(header, '00', 263, 2);
  writeText(header, 'haiyue', 265, 32);
  writeText(header, 'haiyue', 297, 32);
  writeText(header, prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, '0')}\0 `;
  writeText(header, encoded, 148, 8);
  writeSync(descriptor, header);
}

function splitTarPath(path) {
  const normalized = normalizeArchivePath(path);
  if (Buffer.byteLength(normalized) <= 100) return { name: normalized, prefix: '' };
  for (let index = normalized.lastIndexOf('/'); index > 0; index = normalized.lastIndexOf('/', index - 1)) {
    const prefix = normalized.slice(0, index);
    const name = normalized.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  throw new Error(`Release archive path exceeds USTAR limits: ${normalized}`);
}

function writeText(buffer, value, offset, length) {
  const bytes = Buffer.from(value);
  if (bytes.byteLength > length) throw new Error(`USTAR field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, value, offset, length) {
  writeText(buffer, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
}

function normalizeArchivePath(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error(`Unsafe release archive path ${path}.`);
  return normalized;
}

function safeLinkTarget(source, archivePath) {
  const link = readlinkSync(source).replaceAll('\\', '/');
  if (!link || link.startsWith('/') || /^[A-Za-z]:\//u.test(link)) throw new Error(`Unsafe release archive symlink ${archivePath} -> ${link}.`);
  const destination = posix.normalize(posix.join(posix.dirname(archivePath), link));
  if (destination === '..' || destination.startsWith('../') || destination.startsWith('/')) {
    throw new Error(`Release archive symlink escapes its archive root: ${archivePath} -> ${link}.`);
  }
  return link;
}

function walk(source, archivePath, output, maxBytes) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) output.push({ path: archivePath, contents: null });
  if (stat.isDirectory()) {
    for (const name of readdirSync(source).sort()) walk(join(source, name), `${archivePath}/${name}`, output, maxBytes);
  } else if (stat.isFile()) {
    output.push({ path: archivePath, contents: stat.size <= maxBytes ? readFileSync(source) : null });
  }
}
