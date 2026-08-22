import { ParameterizedRigDiagnostic } from './diagnostics.js';
import { DEFAULT_PARAMETERIZED_RIG_LIMITS } from './limits.js';
import { parseParameterizedRigDocument } from './parser.js';
import type { ParameterizedRigDocument, ParameterizedRigParseOptions, RigIndexArray, RigNumericArray } from './types.js';

const MAGIC = 0x47525948; // HYRG little-endian.
const HEADER_BYTES = 40;
const MAJOR = 2;
const MINOR = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Range = readonly [number, number];

class PoolBuilder {
  private lengthValue = 0;
  private readonly blocks: ArrayLike<number>[] = [];
  get length(): number { return this.lengthValue; }
  add(values: ArrayLike<number>): Range { const range = [this.lengthValue, values.length] as const; this.lengthValue = checkedAdd(this.lengthValue, values.length, '$binary.pool'); this.blocks.push(values); return range; }
  write(target: Float32Array | Uint32Array): void { let offset = 0; for (const block of this.blocks) { for (let index = 0; index < block.length; index++) target[offset + index] = block[index]!; offset += block.length; } }
}

export function isParameterizedRigBinary(buffer: ArrayBuffer): boolean { return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC; }

export function encodeParameterizedRigDocument(source: ParameterizedRigDocument, options: ParameterizedRigParseOptions = {}): ArrayBuffer {
  const document = parseParameterizedRigDocument(source, options);
  const floats = new PoolBuilder(), indices = new PoolBuilder();
  const metadata = {
    ...document,
    rigs: document.rigs.map(rig => ({
      ...rig,
      paths: (rig.paths ?? []).map(path => ({ ...path, points: floats.add(path.points) })),
      meshes: rig.meshes.map(mesh => ({
        ...mesh,
        positions: floats.add(mesh.positions),
        uvs: floats.add(mesh.uvs),
        indices: indices.add(mesh.indices),
        influenceOffsets: indices.add(mesh.influenceOffsets),
        jointIndices: indices.add(mesh.jointIndices),
        weights: floats.add(mesh.weights),
      })),
    })),
  };
  const metadataBytes = encoder.encode(JSON.stringify(metadata));
  const limits = { ...DEFAULT_PARAMETERIZED_RIG_LIMITS, ...options.limits };
  if (metadataBytes.byteLength > limits.maxMetadataBytes) limit(`metadata exceeds ${limits.maxMetadataBytes} bytes`, '$binary.metadata');
  const metadataOffset = HEADER_BYTES;
  const floatOffset = align4(checkedAdd(metadataOffset, metadataBytes.byteLength, '$binary.floats'));
  const indexOffset = checkedAdd(floatOffset, checkedBytes(floats.length, 4, '$binary.floats'), '$binary.indices');
  const totalBytes = checkedAdd(indexOffset, checkedBytes(indices.length, 4, '$binary.indices'), '$binary');
  if (totalBytes > limits.maxInputBytes) limit(`encoded binary exceeds ${limits.maxInputBytes} bytes`, '$binary');
  const buffer = new ArrayBuffer(totalBytes), header = new DataView(buffer);
  header.setUint32(0, MAGIC, true); header.setUint16(4, MAJOR, true); header.setUint16(6, MINOR, true);
  header.setUint32(8, metadataOffset, true); header.setUint32(12, metadataBytes.byteLength, true);
  header.setUint32(16, floatOffset, true); header.setUint32(20, floats.length, true);
  header.setUint32(24, indexOffset, true); header.setUint32(28, indices.length, true);
  header.setUint32(32, totalBytes, true); header.setUint32(36, 0, true);
  new Uint8Array(buffer, metadataOffset, metadataBytes.byteLength).set(metadataBytes);
  floats.write(new Float32Array(buffer, floatOffset, floats.length));
  indices.write(new Uint32Array(buffer, indexOffset, indices.length));
  return buffer;
}

export function decodeParameterizedRigDocument(buffer: ArrayBuffer, options: ParameterizedRigParseOptions = {}): ParameterizedRigDocument {
  const limits = { ...DEFAULT_PARAMETERIZED_RIG_LIMITS, ...options.limits };
  if (buffer.byteLength > limits.maxInputBytes) limit(`input exceeds ${limits.maxInputBytes} bytes`, '$binary');
  if (buffer.byteLength < HEADER_BYTES) binary('header is truncated', '$binary');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== MAGIC) binary('magic must be HYRG', '$binary.magic');
  const major = header.getUint16(4, true), minor = header.getUint16(6, true);
  if (major !== MAJOR || minor !== MINOR) binary(`unsupported binary version ${major}.${minor}`, '$binary.version');
  const metadataOffset = header.getUint32(8, true), metadataLength = header.getUint32(12, true), floatOffset = header.getUint32(16, true), floatCount = header.getUint32(20, true), indexOffset = header.getUint32(24, true), indexCount = header.getUint32(28, true), totalBytes = header.getUint32(32, true), flags = header.getUint32(36, true);
  if (flags !== 0) binary('unknown binary flags', '$binary.flags');
  if (totalBytes !== buffer.byteLength) binary('declared byte length does not match input', '$binary.length');
  if (metadataOffset !== HEADER_BYTES || metadataLength > limits.maxMetadataBytes) binary('metadata range is invalid or excessive', '$binary.metadata');
  checkedRange(metadataOffset, metadataLength, buffer.byteLength, '$binary.metadata');
  if ((floatOffset & 3) !== 0 || floatOffset !== align4(metadataOffset + metadataLength)) binary('float pool is unaligned or non-canonical', '$binary.floats');
  const floatBytes = checkedBytes(floatCount, 4, '$binary.floats'); checkedRange(floatOffset, floatBytes, buffer.byteLength, '$binary.floats');
  if ((indexOffset & 3) !== 0 || indexOffset !== floatOffset + floatBytes) binary('index pool is unaligned or non-canonical', '$binary.indices');
  const indexBytes = checkedBytes(indexCount, 4, '$binary.indices'); checkedRange(indexOffset, indexBytes, buffer.byteLength, '$binary.indices');
  if (indexOffset + indexBytes !== buffer.byteLength) binary('binary contains trailing or unaccounted bytes', '$binary');
  let metadata: unknown;
  try { metadata = JSON.parse(decoder.decode(new Uint8Array(buffer, metadataOffset, metadataLength))); } catch (error) { binary(`metadata JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, '$binary.metadata'); }
  const root = packedObject(metadata, '$binary.metadata');
  const rigs = packedArray(root.rigs, '$binary.metadata.rigs');
  const floatRanges: Range[] = [], indexRanges: Range[] = [];
  for (let rigIndex = 0; rigIndex < rigs.length; rigIndex++) {
    const rig = packedObject(rigs[rigIndex], `$.rigs[${rigIndex}]`);
    const paths = rig.paths === undefined ? [] : packedArray(rig.paths, `$.rigs[${rigIndex}].paths`);
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) floatRanges.push(packedRange(packedObject(paths[pathIndex], `$.rigs[${rigIndex}].paths[${pathIndex}]`).points, floatCount, `$.rigs[${rigIndex}].paths[${pathIndex}].points`));
    const meshes = packedArray(rig.meshes, `$.rigs[${rigIndex}].meshes`);
    for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
      const path = `$.rigs[${rigIndex}].meshes[${meshIndex}]`, mesh = packedObject(meshes[meshIndex], path);
      floatRanges.push(packedRange(mesh.positions, floatCount, `${path}.positions`), packedRange(mesh.uvs, floatCount, `${path}.uvs`));
      indexRanges.push(packedRange(mesh.indices, indexCount, `${path}.indices`), packedRange(mesh.influenceOffsets, indexCount, `${path}.influenceOffsets`), packedRange(mesh.jointIndices, indexCount, `${path}.jointIndices`));
      floatRanges.push(packedRange(mesh.weights, floatCount, `${path}.weights`));
    }
  }
  validateCanonicalRanges(floatRanges, floatCount, '$binary.floats'); validateCanonicalRanges(indexRanges, indexCount, '$binary.indices');
  const floatPool = new Float32Array(buffer, floatOffset, floatCount), indexPool = new Uint32Array(buffer, indexOffset, indexCount);
  for (let index = 0; index < floatPool.length; index++) if (!Number.isFinite(floatPool[index])) binary('float pool contains a non-finite value', `$binary.floats[${index}]`);
  const reconstructed = structuredClone(root);
  const outputRigs = packedArray(reconstructed.rigs, '$.rigs');
  for (let rigIndex = 0; rigIndex < outputRigs.length; rigIndex++) {
    const rig = packedObject(outputRigs[rigIndex], `$.rigs[${rigIndex}]`), paths = rig.paths === undefined ? [] : packedArray(rig.paths, `$.rigs[${rigIndex}].paths`);
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) { const path = packedObject(paths[pathIndex], `$.rigs[${rigIndex}].paths[${pathIndex}]`); path.points = floatView(floatPool, packedRange(path.points, floatCount, 'path.points')); }
    const meshes = packedArray(rig.meshes, `$.rigs[${rigIndex}].meshes`);
    for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) { const mesh = packedObject(meshes[meshIndex], `$.rigs[${rigIndex}].meshes[${meshIndex}]`); mesh.positions = floatView(floatPool, packedRange(mesh.positions, floatCount, 'mesh.positions')); mesh.uvs = floatView(floatPool, packedRange(mesh.uvs, floatCount, 'mesh.uvs')); mesh.indices = indexView(indexPool, packedRange(mesh.indices, indexCount, 'mesh.indices')); mesh.influenceOffsets = indexView(indexPool, packedRange(mesh.influenceOffsets, indexCount, 'mesh.influenceOffsets')); mesh.jointIndices = indexView(indexPool, packedRange(mesh.jointIndices, indexCount, 'mesh.jointIndices')); mesh.weights = floatView(floatPool, packedRange(mesh.weights, floatCount, 'mesh.weights')); }
  }
  return parseParameterizedRigDocument(reconstructed, options);
}

function validateCanonicalRanges(ranges: readonly Range[], poolCount: number, path: string): void { let expected = 0; for (const range of ranges) { if (range[0] !== expected) binary('pool ranges overlap, alias, or contain gaps', path); expected += range[1]; } if (expected !== poolCount) binary('pool has unreferenced entries', path); }
function packedObject(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) binary('expected object', path); return value as Record<string, unknown>; }
function packedArray(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) binary('expected array', path); return value; }
function packedRange(value: unknown, poolCount: number, path: string): Range { if (!Array.isArray(value) || value.length !== 2 || !value.every(item => Number.isSafeInteger(item) && item >= 0)) binary('expected non-negative [offset,length] range', path); const offset = value[0] as number, length = value[1] as number; if (offset + length > poolCount) binary('range exceeds pool', path); return [offset, length]; }
function floatView(pool: Float32Array, range: Range): RigNumericArray { return pool.subarray(range[0], range[0] + range[1]); }
function indexView(pool: Uint32Array, range: Range): RigIndexArray { return pool.subarray(range[0], range[0] + range[1]); }
function align4(value: number): number { return (value + 3) & ~3; }
function checkedBytes(count: number, stride: number, path: string): number { const value = count * stride; if (!Number.isSafeInteger(value) || value > 0xffff_ffff) limit('byte count overflow', path); return value; }
function checkedAdd(left: number, right: number, path: string): number { const value = left + right; if (!Number.isSafeInteger(value) || value > 0xffff_ffff) limit('offset overflow', path); return value; }
function checkedRange(offset: number, length: number, total: number, path: string): void { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > total || length > total - offset) binary('range exceeds binary', path); }
function binary(message: string, path: string): never { throw new ParameterizedRigDiagnostic('E_RIG_BINARY', path, message); }
function limit(message: string, path: string): never { throw new ParameterizedRigDiagnostic('E_RIG_LIMIT', path, message); }
