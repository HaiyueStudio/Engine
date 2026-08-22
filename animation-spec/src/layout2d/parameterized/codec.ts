import { LayoutDiagnostic } from './diagnostics.js';
import { DEFAULT_LAYOUT_LIMITS } from './limits.js';
import { parseResponsiveLayoutDocument } from './parser.js';
import type { LayoutParseOptions, ResponsiveLayoutDocument } from './types.js';

const MAGIC = 0x414c5948; // HYLA little-endian.
const HEADER_BYTES = 40;
const MAJOR = 1;
const MINOR = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Range = readonly [number, number];

export function isResponsiveLayoutBinary(buffer: ArrayBuffer): boolean { return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC; }

export function encodeResponsiveLayoutDocument(source: ResponsiveLayoutDocument, options: LayoutParseOptions = {}): ArrayBuffer {
  const document = parseResponsiveLayoutDocument(source, options), blocks: ArrayLike<number>[] = []; let byteCount = 0;
  const metadata = { ...document, assets: document.assets.map(asset => asset.source?.kind === 'embedded' ? { ...asset, source: { ...asset.source, data: add(asset.source.data) } } : asset) };
  function add(data: ArrayLike<number>): Range { const range = [byteCount, data.length] as const; byteCount = checkedAdd(byteCount, data.length, '$binary.bytes'); blocks.push(data); return range; }
  const metadataBytes = encoder.encode(JSON.stringify(metadata)), limits = { ...DEFAULT_LAYOUT_LIMITS, ...options.limits };
  if (metadataBytes.byteLength > limits.maxMetadataBytes) limit('metadata exceeds limit', '$binary.metadata');
  const metadataOffset = HEADER_BYTES, byteOffset = checkedAdd(metadataOffset, metadataBytes.byteLength, '$binary.bytes'), totalBytes = checkedAdd(byteOffset, byteCount, '$binary');
  if (totalBytes > limits.maxInputBytes) limit('binary exceeds input limit', '$binary');
  const buffer = new ArrayBuffer(totalBytes), header = new DataView(buffer);
  header.setUint32(0, MAGIC, true); header.setUint16(4, MAJOR, true); header.setUint16(6, MINOR, true); header.setUint32(8, metadataOffset, true); header.setUint32(12, metadataBytes.byteLength, true); header.setUint32(16, byteOffset, true); header.setUint32(20, byteCount, true); header.setUint32(24, totalBytes, true); header.setUint32(28, 0, true); header.setUint32(32, 0, true); header.setUint32(36, 0, true);
  new Uint8Array(buffer, metadataOffset, metadataBytes.length).set(metadataBytes); const pool = new Uint8Array(buffer, byteOffset, byteCount); let cursor = 0; for (const block of blocks) { for (let index = 0; index < block.length; index++) pool[cursor + index] = block[index]!; cursor += block.length; }
  return buffer;
}

export function decodeResponsiveLayoutDocument(buffer: ArrayBuffer, options: LayoutParseOptions = {}): ResponsiveLayoutDocument {
  const limits = { ...DEFAULT_LAYOUT_LIMITS, ...options.limits }; if (buffer.byteLength > limits.maxInputBytes) limit('input exceeds limit', '$binary'); if (buffer.byteLength < HEADER_BYTES) binary('header is truncated', '$binary');
  const header = new DataView(buffer); if (header.getUint32(0, true) !== MAGIC) binary('magic must be HYLA', '$binary.magic'); const major = header.getUint16(4, true), minor = header.getUint16(6, true); if (major !== MAJOR || minor !== MINOR) binary(`unsupported version ${major}.${minor}`, '$binary.version');
  const metadataOffset = header.getUint32(8, true), metadataLength = header.getUint32(12, true), byteOffset = header.getUint32(16, true), byteCount = header.getUint32(20, true), totalBytes = header.getUint32(24, true), flags = header.getUint32(28, true), reserved0 = header.getUint32(32, true), reserved1 = header.getUint32(36, true);
  if (flags !== 0 || reserved0 !== 0 || reserved1 !== 0) binary('unknown flags or reserved bits', '$binary.flags'); if (totalBytes !== buffer.byteLength) binary('declared length mismatch', '$binary.length'); if (metadataOffset !== HEADER_BYTES || metadataLength > limits.maxMetadataBytes) binary('metadata range is invalid', '$binary.metadata'); checkedRange(metadataOffset, metadataLength, buffer.byteLength, '$binary.metadata'); if (byteOffset !== metadataOffset + metadataLength) binary('byte pool is non-canonical', '$binary.bytes'); checkedRange(byteOffset, byteCount, buffer.byteLength, '$binary.bytes'); if (byteOffset + byteCount !== buffer.byteLength) binary('trailing bytes are forbidden', '$binary');
  let metadata: unknown; try { metadata = JSON.parse(decoder.decode(new Uint8Array(buffer, metadataOffset, metadataLength))); } catch (error) { binary(`invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`, '$binary.metadata'); }
  const root = packedObject(metadata, '$binary.metadata'), assets = packedArray(root.assets, '$.assets'), ranges: Range[] = [];
  for (const [index, value] of assets.entries()) { const asset = packedObject(value, `$.assets[${index}]`); if (asset.source === undefined) continue; const source = packedObject(asset.source, `$.assets[${index}].source`); if (source.kind === 'embedded') ranges.push(packedRange(source.data, byteCount, `$.assets[${index}].source.data`)); }
  validateCanonicalRanges(ranges, byteCount); const pool = new Uint8Array(buffer, byteOffset, byteCount), reconstructed = structuredClone(root), outputAssets = packedArray(reconstructed.assets, '$.assets');
  for (const [index, value] of outputAssets.entries()) { const asset = packedObject(value, `$.assets[${index}]`); if (asset.source === undefined) continue; const source = packedObject(asset.source, `$.assets[${index}].source`); if (source.kind === 'embedded') { const range = packedRange(source.data, byteCount, `$.assets[${index}].source.data`); source.data = pool.subarray(range[0], range[0] + range[1]); } }
  return parseResponsiveLayoutDocument(reconstructed, options);
}

function validateCanonicalRanges(ranges: readonly Range[], count: number): void { let expected = 0; for (const [offset, length] of ranges) { if (offset !== expected) binary('byte ranges alias, overlap, or contain gaps', '$binary.bytes'); expected += length; } if (expected !== count) binary('byte pool has unreferenced data', '$binary.bytes'); }
function packedObject(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) binary('expected object', path); return value as Record<string, unknown>; }
function packedArray(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) binary('expected array', path); return value; }
function packedRange(value: unknown, count: number, path: string): Range { if (!Array.isArray(value) || value.length !== 2 || !value.every(entry => Number.isSafeInteger(entry) && entry >= 0)) binary('expected non-negative [offset,length]', path); const offset = value[0] as number, length = value[1] as number; if (offset > count || length > count - offset) binary('range exceeds byte pool', path); return [offset, length]; }
function checkedRange(offset: number, length: number, total: number, path: string): void { if (offset > total || length > total - offset) binary('range exceeds input', path); }
function checkedAdd(left: number, right: number, path: string): number { const result = left + right; if (!Number.isSafeInteger(result) || result > 0xffff_ffff) limit('offset overflow', path); return result; }
function binary(message: string, path: string): never { throw new LayoutDiagnostic('E_LAYOUT_BINARY', path, message); }
function limit(message: string, path: string): never { throw new LayoutDiagnostic('E_LAYOUT_LIMIT', path, message); }
