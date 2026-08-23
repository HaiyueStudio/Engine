import { AnimationFormatError } from '../errors';
import {
  DEFORMABLE_MESH_2D_DATA_FORMAT,
  DEFORMABLE_MESH_2D_DATA_VERSION,
  DEFORMABLE_MESH_2D_MAX_MASK_REFERENCES,
  type DeformableMesh2DBlendMode,
  type DeformableMesh2DMaskMode,
  type DeformableMesh2DDataSource,
  type DeformableMesh2DDrawableSource,
  type DeformableMesh2DParseLimits,
  type ParsedDeformableMesh2DData,
  type ParsedDeformableMesh2DDrawable,
} from './types';

const MAGIC = 0x4d445948; // HYDM in little endian.
const HEADER_BYTES = 32;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 4 * 1024 * 1024,
  maxDrawables: 4096,
  maxVertices: 2_000_000,
  maxFrames: 36_000,
  maxMaskReferences: DEFORMABLE_MESH_2D_MAX_MASK_REFERENCES,
  maxTextures: 32,
});

type Range = readonly [number, number];

interface PackedDrawableMetadata {
  readonly id: string;
  readonly textureIndex: number;
  readonly blendMode: DeformableMesh2DBlendMode;
  readonly culling: boolean;
  readonly masks: readonly string[];
  readonly maskMode: DeformableMesh2DMaskMode;
  readonly uvs: Range;
  readonly indices: Range;
  readonly positions: Range;
  readonly opacities: Range;
  readonly renderOrders: Range;
  readonly multiplyColors?: Range;
  readonly screenColors?: Range;
}

interface PackedMetadata {
  readonly format: typeof DEFORMABLE_MESH_2D_DATA_FORMAT;
  readonly version: typeof DEFORMABLE_MESH_2D_DATA_VERSION;
  readonly canvas: readonly [number, number];
  readonly duration: number;
  readonly frameRate: number;
  readonly times: Range;
  readonly drawables: readonly PackedDrawableMetadata[];
}

class PoolBuilder<T extends Float32Array | Uint32Array> {
  private count = 0;
  private readonly blocks: T[] = [];

  get length(): number { return this.count; }

  add(values: T): Range {
    const range = [this.count, values.length] as const;
    this.count += values.length;
    this.blocks.push(values);
    return range;
  }

  build(create: (length: number) => T): T {
    const result = create(this.count);
    let offset = 0;
    for (const block of this.blocks) {
      result.set(block as T, offset);
      offset += block.length;
    }
    return result;
  }
}

export function isDeformableMesh2DBinary(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC;
}

export function encodeDeformableMesh2DData(source: DeformableMesh2DDataSource): ArrayBuffer {
  validateSource(source);
  const floats = new PoolBuilder<Float32Array>();
  const indices = new PoolBuilder<Uint32Array>();
  const times = floats.add(source.times);
  const drawables = source.drawables.map(drawable => {
    const multiplyColors = shouldStoreColorTrack(drawable.multiplyColors, [1, 1, 1, 1])
      ? floats.add(drawable.multiplyColors!)
      : undefined;
    const screenColors = shouldStoreColorTrack(drawable.screenColors, [0, 0, 0, 0])
      ? floats.add(drawable.screenColors!)
      : undefined;
    return {
      id: drawable.id,
      textureIndex: drawable.textureIndex,
      blendMode: drawable.blendMode,
      culling: drawable.culling,
      masks: [...drawable.masks],
      maskMode: drawable.maskMode ?? 'alpha',
      uvs: floats.add(drawable.uvs),
      indices: indices.add(drawable.indices),
      positions: floats.add(drawable.positions),
      opacities: floats.add(drawable.opacities),
      renderOrders: floats.add(drawable.renderOrders),
      ...(multiplyColors === undefined ? {} : { multiplyColors }),
      ...(screenColors === undefined ? {} : { screenColors }),
    };
  });
  const minor = drawables.some(drawable => drawable.multiplyColors !== undefined || drawable.screenColors !== undefined) ? 2 : 1;
  const metadata: PackedMetadata = {
    format: DEFORMABLE_MESH_2D_DATA_FORMAT,
    version: DEFORMABLE_MESH_2D_DATA_VERSION,
    canvas: [source.canvasWidth, source.canvasHeight],
    duration: source.duration,
    frameRate: source.frameRate,
    times,
    drawables,
  };
  const metadataBytes = UTF8_ENCODER.encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > DEFAULT_LIMITS.maxMetadataBytes) limit(`Metadata exceeds ${DEFAULT_LIMITS.maxMetadataBytes} bytes.`, '$binary.metadata');
  const metadataOffset = HEADER_BYTES;
  const floatOffset = align4(metadataOffset + metadataBytes.byteLength);
  const floatBytes = checkedBytes(floats.length, 4, '$binary.floats');
  const indexBytes = checkedBytes(indices.length, 4, '$binary.indices');
  const indexOffset = checkedAdd(floatOffset, floatBytes, '$binary.indices');
  const outputBytes = checkedAdd(indexOffset, indexBytes, '$binary');
  if (outputBytes > DEFAULT_LIMITS.maxInputBytes) limit(`Encoded output exceeds ${DEFAULT_LIMITS.maxInputBytes} bytes.`, '$binary');
  const floatPool = floats.build(length => new Float32Array(length));
  const indexPool = indices.build(length => new Uint32Array(length));
  const buffer = new ArrayBuffer(outputBytes);
  const header = new DataView(buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint16(4, 1, true);
  header.setUint16(6, minor, true);
  header.setUint32(8, metadataOffset, true);
  header.setUint32(12, metadataBytes.byteLength, true);
  header.setUint32(16, floatOffset, true);
  header.setUint32(20, floatPool.length, true);
  header.setUint32(24, indexOffset, true);
  header.setUint32(28, indexPool.length, true);
  new Uint8Array(buffer, metadataOffset, metadataBytes.byteLength).set(metadataBytes);
  new Float32Array(buffer, floatOffset, floatPool.length).set(floatPool);
  new Uint32Array(buffer, indexOffset, indexPool.length).set(indexPool);
  return buffer;
}

export function decodeDeformableMesh2DData(
  buffer: ArrayBuffer,
  limits: DeformableMesh2DParseLimits = {},
): ParsedDeformableMesh2DData {
  const resolved = resolveLimits(limits);
  if (buffer.byteLength > resolved.maxInputBytes) limit(`Input exceeds ${resolved.maxInputBytes} bytes.`, '$binary');
  if (buffer.byteLength < HEADER_BYTES) invalid('Header is truncated.', '$binary');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== MAGIC) invalid('Magic must be HYDM.', '$binary.magic');
  const major = header.getUint16(4, true);
  const minor = header.getUint16(6, true);
  if (major !== 1 || minor > 2) invalid(`Unsupported sidecar version ${major}.${minor}.`, '$binary.version');
  const metadataOffset = header.getUint32(8, true);
  const metadataLength = header.getUint32(12, true);
  const floatOffset = header.getUint32(16, true);
  const floatCount = header.getUint32(20, true);
  const indexOffset = header.getUint32(24, true);
  const indexCount = header.getUint32(28, true);
  if (metadataLength > resolved.maxMetadataBytes) limit(`Metadata exceeds ${resolved.maxMetadataBytes} bytes.`, '$binary.metadata');
  checkedRange(metadataOffset, metadataLength, buffer.byteLength, '$binary.metadata');
  if (metadataOffset !== HEADER_BYTES) invalid('Metadata must immediately follow the header.', '$binary.metadata');
  if ((floatOffset & 3) !== 0 || floatOffset < metadataOffset + metadataLength) invalid('Float pool is unaligned or overlaps metadata.', '$binary.floats');
  checkedRange(floatOffset, checkedBytes(floatCount, 4, '$binary.floats'), buffer.byteLength, '$binary.floats');
  if ((indexOffset & 3) !== 0 || indexOffset !== floatOffset + floatCount * 4) invalid('Index pool is unaligned or does not follow floats.', '$binary.indices');
  const indexBytes = checkedBytes(indexCount, 4, '$binary.indices');
  checkedRange(indexOffset, indexBytes, buffer.byteLength, '$binary.indices');
  if (indexOffset + indexBytes !== buffer.byteLength) invalid('Sidecar has trailing or unaccounted bytes.', '$binary');
  let raw: unknown;
  try {
    raw = JSON.parse(UTF8_DECODER.decode(new Uint8Array(buffer, metadataOffset, metadataLength)));
  } catch (error) {
    invalid(`Metadata JSON cannot be decoded: ${error instanceof Error ? error.message : String(error)}.`, '$binary.metadata');
  }
  const metadata = parseMetadata(raw, resolved, minor);
  validatePackedRanges(metadata, floatCount, indexCount);
  const floatPool = new Float32Array(buffer, floatOffset, floatCount);
  const indexPool = new Uint32Array(buffer, indexOffset, indexCount);
  ensureFinite(floatPool, '$binary.floats');
  const times = floatRange(floatPool, metadata.times, '$.times');
  validateTimes(times, metadata.duration, resolved.maxFrames);
  const ids = new Set<string>();
  let vertexTotal = 0;
  let maskTotal = 0;
  const drawables = metadata.drawables.map((item, index): ParsedDeformableMesh2DDrawable => {
    const path = `$.drawables[${index}]`;
    if (!item.id || ids.has(item.id)) invalid('Drawable id must be non-empty and unique.', `${path}.id`);
    ids.add(item.id);
    if (item.textureIndex >= DEFAULT_LIMITS.maxTextures) limit(`Texture index exceeds ${DEFAULT_LIMITS.maxTextures - 1}.`, `${path}.textureIndex`);
    const uvs = floatRange(floatPool, item.uvs, `${path}.uvs`);
    if (uvs.length < 6 || (uvs.length & 1) !== 0) invalid('UVs require at least three xy pairs.', `${path}.uvs`);
    const vertexCount = uvs.length / 2;
    vertexTotal += vertexCount;
    if (vertexTotal > resolved.maxVertices) limit(`Vertex count exceeds ${resolved.maxVertices}.`, `${path}.uvs`);
    const positions = floatRange(floatPool, item.positions, `${path}.positions`);
    if (positions.length !== times.length * uvs.length) invalid('Position count must equal frameCount * vertexCount * 2.', `${path}.positions`);
    const opacities = floatRange(floatPool, item.opacities, `${path}.opacities`);
    const renderOrders = floatRange(floatPool, item.renderOrders, `${path}.renderOrders`);
    const multiplyColors = item.multiplyColors === undefined ? undefined : floatRange(floatPool, item.multiplyColors, `${path}.multiplyColors`);
    const screenColors = item.screenColors === undefined ? undefined : floatRange(floatPool, item.screenColors, `${path}.screenColors`);
    if (opacities.length !== times.length || renderOrders.length !== times.length) invalid('Opacity and render-order tracks require one value per frame.', path);
    if (multiplyColors !== undefined) validateColorTrack(multiplyColors, times.length, `${path}.multiplyColors`);
    if (screenColors !== undefined) validateColorTrack(screenColors, times.length, `${path}.screenColors`);
    for (let valueIndex = 0; valueIndex < opacities.length; valueIndex++) {
      if (opacities[valueIndex]! < 0 || opacities[valueIndex]! > 1) invalid('Opacity must stay inside [0, 1].', `${path}.opacities[${valueIndex}]`);
      if (!Number.isSafeInteger(renderOrders[valueIndex])) invalid('Render order must be a safe integer.', `${path}.renderOrders[${valueIndex}]`);
    }
    const drawableIndices = indexRange(indexPool, item.indices, `${path}.indices`);
    if (drawableIndices.length < 3 || drawableIndices.length % 3 !== 0) invalid('Indices must contain triangle triplets.', `${path}.indices`);
    for (let valueIndex = 0; valueIndex < drawableIndices.length; valueIndex++) {
      if (drawableIndices[valueIndex]! >= vertexCount) invalid('Index references a missing vertex.', `${path}.indices[${valueIndex}]`);
    }
    maskTotal += item.masks.length;
    if (maskTotal > resolved.maxMaskReferences) limit(`Mask reference count exceeds ${resolved.maxMaskReferences}.`, `${path}.masks`);
    return Object.freeze({
      id: item.id,
      textureIndex: item.textureIndex,
      blendMode: item.blendMode,
      culling: item.culling,
      masks: Object.freeze([...item.masks]),
      maskMode: item.maskMode,
      uvs,
      indices: drawableIndices,
      positions,
      opacities,
      renderOrders,
      ...(multiplyColors === undefined ? {} : { multiplyColors }),
      ...(screenColors === undefined ? {} : { screenColors }),
      vertexCount,
    });
  });
  for (let index = 0; index < drawables.length; index++) {
    for (let maskIndex = 0; maskIndex < drawables[index]!.masks.length; maskIndex++) {
      const mask = drawables[index]!.masks[maskIndex]!;
      if (mask === drawables[index]!.id || !ids.has(mask)) invalid('Mask must reference a different existing drawable.', `$.drawables[${index}].masks[${maskIndex}]`);
    }
  }
  validateMaskGraph(drawables);
  return Object.freeze({
    format: DEFORMABLE_MESH_2D_DATA_FORMAT,
    version: DEFORMABLE_MESH_2D_DATA_VERSION,
    canvasWidth: metadata.canvas[0],
    canvasHeight: metadata.canvas[1],
    duration: metadata.duration,
    frameRate: metadata.frameRate,
    times,
    drawables: Object.freeze(drawables),
    backingBuffer: buffer,
  });
}

function validateSource(source: DeformableMesh2DDataSource): void {
  positive(source.canvasWidth, '$.canvasWidth');
  positive(source.canvasHeight, '$.canvasHeight');
  positive(source.duration, '$.duration');
  positive(source.frameRate, '$.frameRate');
  if (!(source.times instanceof Float32Array) || source.times.length === 0) invalid('Times must be a non-empty Float32Array.', '$.times');
  validateTimes(source.times, source.duration, DEFAULT_LIMITS.maxFrames);
  if (!Array.isArray(source.drawables) || source.drawables.length === 0) invalid('At least one drawable is required.', '$.drawables');
  if (source.drawables.length > DEFAULT_LIMITS.maxDrawables) limit(`Drawable count exceeds ${DEFAULT_LIMITS.maxDrawables}.`, '$.drawables');
  const ids = new Set(source.drawables.map(item => item.id));
  if (ids.size !== source.drawables.length || ids.has('')) invalid('Drawable ids must be non-empty and unique.', '$.drawables');
  let vertexTotal = 0;
  let maskTotal = 0;
  for (let index = 0; index < source.drawables.length; index++) {
    const drawable = source.drawables[index]!;
    validateSourceDrawable(drawable, source.times.length, ids, index);
    vertexTotal += drawable.uvs.length / 2;
    maskTotal += drawable.masks.length;
    if (vertexTotal > DEFAULT_LIMITS.maxVertices) limit(`Vertex count exceeds ${DEFAULT_LIMITS.maxVertices}.`, `$.drawables[${index}].uvs`);
    if (maskTotal > DEFAULT_LIMITS.maxMaskReferences) limit(`Mask reference count exceeds ${DEFAULT_LIMITS.maxMaskReferences}.`, `$.drawables[${index}].masks`);
  }
  validateMaskGraph(source.drawables);
}

function validateSourceDrawable(drawable: DeformableMesh2DDrawableSource, frameCount: number, ids: ReadonlySet<string>, index: number): void {
  const path = `$.drawables[${index}]`;
  if (!Number.isSafeInteger(drawable.textureIndex) || drawable.textureIndex < 0) invalid('Texture index must be a non-negative safe integer.', `${path}.textureIndex`);
  if (drawable.textureIndex >= DEFAULT_LIMITS.maxTextures) limit(`Texture index exceeds ${DEFAULT_LIMITS.maxTextures - 1}.`, `${path}.textureIndex`);
  if (!['normal', 'additive', 'multiplicative'].includes(drawable.blendMode)) invalid('Blend mode is unsupported.', `${path}.blendMode`);
  if (!(drawable.uvs instanceof Float32Array) || drawable.uvs.length < 6 || (drawable.uvs.length & 1) !== 0) invalid('UVs require at least three xy pairs.', `${path}.uvs`);
  if (!(drawable.indices instanceof Uint32Array) || drawable.indices.length < 3 || drawable.indices.length % 3 !== 0) invalid('Indices require Uint32 triangle triplets.', `${path}.indices`);
  if (!(drawable.positions instanceof Float32Array) || drawable.positions.length !== frameCount * drawable.uvs.length) invalid('Positions do not match frame and vertex counts.', `${path}.positions`);
  if (!(drawable.opacities instanceof Float32Array) || drawable.opacities.length !== frameCount) invalid('Opacities require one value per frame.', `${path}.opacities`);
  if (!(drawable.renderOrders instanceof Float32Array) || drawable.renderOrders.length !== frameCount) invalid('Render orders require one value per frame.', `${path}.renderOrders`);
  if (drawable.multiplyColors !== undefined) validateSourceColorTrack(drawable.multiplyColors, frameCount, `${path}.multiplyColors`);
  if (drawable.screenColors !== undefined) validateSourceColorTrack(drawable.screenColors, frameCount, `${path}.screenColors`);
  ensureFinite(drawable.uvs, `${path}.uvs`);
  ensureFinite(drawable.positions, `${path}.positions`);
  ensureFinite(drawable.opacities, `${path}.opacities`);
  ensureFinite(drawable.renderOrders, `${path}.renderOrders`);
  const vertexCount = drawable.uvs.length / 2;
  for (let valueIndex = 0; valueIndex < drawable.indices.length; valueIndex++) {
    if (drawable.indices[valueIndex]! >= vertexCount) invalid('Index references a missing vertex.', `${path}.indices[${valueIndex}]`);
  }
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
    if (drawable.opacities[frameIndex]! < 0 || drawable.opacities[frameIndex]! > 1) invalid('Opacity must stay inside [0, 1].', `${path}.opacities[${frameIndex}]`);
    if (!Number.isSafeInteger(drawable.renderOrders[frameIndex])) invalid('Render order must be a safe integer.', `${path}.renderOrders[${frameIndex}]`);
  }
  if (!Array.isArray(drawable.masks)) invalid('Masks must be an array.', `${path}.masks`);
  if (drawable.maskMode !== undefined && drawable.maskMode !== 'alpha' && drawable.maskMode !== 'alpha-inverted') invalid('Mask mode is unsupported.', `${path}.maskMode`);
  for (let maskIndex = 0; maskIndex < drawable.masks.length; maskIndex++) {
    const mask = drawable.masks[maskIndex]!;
    if (!mask || mask === drawable.id || !ids.has(mask)) invalid('Mask must reference a different existing drawable.', `${path}.masks[${maskIndex}]`);
  }
}

function parseMetadata(value: unknown, limits: Required<DeformableMesh2DParseLimits>, minor: number): PackedMetadata {
  const root = record(value, '$');
  if (root.format !== DEFORMABLE_MESH_2D_DATA_FORMAT || root.version !== DEFORMABLE_MESH_2D_DATA_VERSION) invalid('Metadata format/version is unsupported.', '$.format');
  const canvas = numberPair(root.canvas, '$.canvas');
  positive(canvas[0], '$.canvas[0]');
  positive(canvas[1], '$.canvas[1]');
  const duration = finite(root.duration, '$.duration'); positive(duration, '$.duration');
  const frameRate = finite(root.frameRate, '$.frameRate'); positive(frameRate, '$.frameRate');
  const drawablesRaw = array(root.drawables, '$.drawables');
  if (drawablesRaw.length === 0 || drawablesRaw.length > limits.maxDrawables) limit(`Drawable count must be 1-${limits.maxDrawables}.`, '$.drawables');
  return {
    format: DEFORMABLE_MESH_2D_DATA_FORMAT,
    version: DEFORMABLE_MESH_2D_DATA_VERSION,
    canvas,
    duration,
    frameRate,
    times: range(root.times, '$.times'),
    drawables: drawablesRaw.map((entry, index) => {
      const item = record(entry, `$.drawables[${index}]`);
      if (minor === 0 && item.maskMode !== undefined) invalid('HYDM 1.0 must not contain maskMode.', `$.drawables[${index}].maskMode`);
      if (minor < 2 && (item.multiplyColors !== undefined || item.screenColors !== undefined)) invalid(`HYDM 1.${minor} must not contain drawable color tracks.`, `$.drawables[${index}]`);
      return {
        id: string(item.id, `$.drawables[${index}].id`),
        textureIndex: nonNegativeInteger(item.textureIndex, `$.drawables[${index}].textureIndex`),
        blendMode: literal(item.blendMode, ['normal', 'additive', 'multiplicative'] as const, `$.drawables[${index}].blendMode`),
        culling: boolean(item.culling, `$.drawables[${index}].culling`),
        masks: array(item.masks, `$.drawables[${index}].masks`).map((mask, maskIndex) => string(mask, `$.drawables[${index}].masks[${maskIndex}]`)),
        maskMode: minor === 0
          ? 'alpha'
          : literal(item.maskMode, ['alpha', 'alpha-inverted'] as const, `$.drawables[${index}].maskMode`),
        uvs: range(item.uvs, `$.drawables[${index}].uvs`),
        indices: range(item.indices, `$.drawables[${index}].indices`),
        positions: range(item.positions, `$.drawables[${index}].positions`),
        opacities: range(item.opacities, `$.drawables[${index}].opacities`),
        renderOrders: range(item.renderOrders, `$.drawables[${index}].renderOrders`),
        ...(minor < 2 || item.multiplyColors === undefined ? {} : { multiplyColors: range(item.multiplyColors, `$.drawables[${index}].multiplyColors`) }),
        ...(minor < 2 || item.screenColors === undefined ? {} : { screenColors: range(item.screenColors, `$.drawables[${index}].screenColors`) }),
      };
    }),
  };
}

function resolveLimits(limits: DeformableMesh2DParseLimits): Required<DeformableMesh2DParseLimits> {
  return {
    maxInputBytes: positiveLimit(limits.maxInputBytes, DEFAULT_LIMITS.maxInputBytes, 'maxInputBytes'),
    maxMetadataBytes: positiveLimit(limits.maxMetadataBytes, DEFAULT_LIMITS.maxMetadataBytes, 'maxMetadataBytes'),
    maxDrawables: positiveLimit(limits.maxDrawables, DEFAULT_LIMITS.maxDrawables, 'maxDrawables'),
    maxVertices: positiveLimit(limits.maxVertices, DEFAULT_LIMITS.maxVertices, 'maxVertices'),
    maxFrames: positiveLimit(limits.maxFrames, DEFAULT_LIMITS.maxFrames, 'maxFrames'),
    maxMaskReferences: positiveLimit(limits.maxMaskReferences, DEFAULT_LIMITS.maxMaskReferences, 'maxMaskReferences'),
  };
}

function floatRange(pool: Float32Array, value: Range, path: string): Float32Array {
  validatePoolRange(value, pool.length, path);
  return pool.subarray(value[0], value[0] + value[1]);
}

function indexRange(pool: Uint32Array, value: Range, path: string): Uint32Array {
  validatePoolRange(value, pool.length, path);
  return pool.subarray(value[0], value[0] + value[1]);
}

function validatePoolRange(value: Range, length: number, path: string): void {
  if (value[0] > length || value[1] > length - value[0]) invalid('Pool range is outside its backing array.', path);
}

function validateTimes(times: Float32Array, duration: number, maxFrames: number): void {
  if (times.length === 0 || times.length > maxFrames) limit(`Frame count must be 1-${maxFrames}.`, '$.times');
  let previous = -1;
  for (let index = 0; index < times.length; index++) {
    const value = times[index]!;
    if (!Number.isFinite(value) || value < 0 || value <= previous || value > Math.max(duration, Math.fround(duration))) invalid('Times must be finite, increasing and inside duration.', `$.times[${index}]`);
    previous = value;
  }
}

function checkedBytes(count: number, stride: number, path: string): number {
  const bytes = count * stride;
  if (!Number.isSafeInteger(bytes)) invalid('Byte count overflows safe integer range.', path);
  return bytes;
}

function checkedAdd(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) invalid('Byte offset overflows safe integer range.', path);
  return sum;
}

function checkedRange(offset: number, length: number, total: number, path: string): void {
  if (offset > total || length > total - offset) invalid('Byte range is outside the buffer.', path);
}

function ensureFinite(values: Float32Array, path: string): void {
  for (let index = 0; index < values.length; index++) if (!Number.isFinite(values[index])) invalid('Float data must be finite.', `${path}[${index}]`);
}

function validatePackedRanges(metadata: PackedMetadata, floatCount: number, indexCount: number): void {
  const floatRanges: { readonly range: Range; readonly path: string }[] = [{ range: metadata.times, path: '$.times' }];
  const indexRanges: { readonly range: Range; readonly path: string }[] = [];
  const expectedColorValues = checkedProduct(metadata.times[1], 4, '$.times');
  for (let index = 0; index < metadata.drawables.length; index++) {
    const drawable = metadata.drawables[index]!;
    const path = `$.drawables[${index}]`;
    floatRanges.push(
      { range: drawable.uvs, path: `${path}.uvs` },
      { range: drawable.positions, path: `${path}.positions` },
      { range: drawable.opacities, path: `${path}.opacities` },
      { range: drawable.renderOrders, path: `${path}.renderOrders` },
    );
    if (drawable.multiplyColors !== undefined) {
      if (drawable.multiplyColors[1] !== expectedColorValues) invalid('Multiply-color track requires four values per frame.', `${path}.multiplyColors`);
      floatRanges.push({ range: drawable.multiplyColors, path: `${path}.multiplyColors` });
    }
    if (drawable.screenColors !== undefined) {
      if (drawable.screenColors[1] !== expectedColorValues) invalid('Screen-color track requires four values per frame.', `${path}.screenColors`);
      floatRanges.push({ range: drawable.screenColors, path: `${path}.screenColors` });
    }
    indexRanges.push({ range: drawable.indices, path: `${path}.indices` });
  }
  validatePackedPool(floatRanges, floatCount, '$binary.floats');
  validatePackedPool(indexRanges, indexCount, '$binary.indices');
}

function validatePackedPool(entries: readonly { readonly range: Range; readonly path: string }[], poolLength: number, poolPath: string): void {
  const ordered = [...entries].sort((left, right) => left.range[0] - right.range[0] || left.range[1] - right.range[1]);
  let cursor = 0;
  for (const entry of ordered) {
    validatePoolRange(entry.range, poolLength, entry.path);
    if (entry.range[0] !== cursor) invalid(entry.range[0] < cursor ? 'Packed ranges overlap.' : 'Packed pool contains an unreferenced gap.', entry.path);
    cursor = checkedAdd(entry.range[0], entry.range[1], entry.path);
  }
  if (cursor !== poolLength) invalid('Packed pool contains trailing unreferenced values.', poolPath);
}

function validateMaskGraph(drawables: readonly { readonly id: string; readonly masks: readonly string[] }[]): void {
  const byId = new Map(drawables.map(drawable => [drawable.id, drawable] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: string): void => {
    if (visiting.has(id)) invalid('Mask dependency graph contains a cycle.', path);
    if (visited.has(id)) return;
    visiting.add(id);
    const drawable = byId.get(id);
    if (drawable) {
      for (let maskIndex = 0; maskIndex < drawable.masks.length; maskIndex++) {
        visit(drawable.masks[maskIndex]!, `${path}.masks[${maskIndex}]`);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (let index = 0; index < drawables.length; index++) visit(drawables[index]!.id, `$.drawables[${index}]`);
}

function align4(value: number): number { return (value + 3) & ~3; }
function checkedProduct(left: number, right: number, path: string): number { const product = left * right; if (!Number.isSafeInteger(product)) invalid('Value count overflows safe integer range.', path); return product; }
function shouldStoreColorTrack(values: Float32Array | undefined, defaults: readonly [number, number, number, number]): boolean {
  if (values === undefined) return false;
  for (let index = 0; index < values.length; index++) if (values[index] !== defaults[index & 3]) return true;
  return false;
}
function validateSourceColorTrack(values: Float32Array, frameCount: number, path: string): void {
  if (!(values instanceof Float32Array) || values.length !== checkedProduct(frameCount, 4, path)) invalid('Drawable color track requires four Float32 values per frame.', path);
  validateUnitColorValues(values, path);
}
function validateColorTrack(values: Float32Array, frameCount: number, path: string): void {
  if (values.length !== checkedProduct(frameCount, 4, path)) invalid('Drawable color track requires four values per frame.', path);
  validateUnitColorValues(values, path);
}
function validateUnitColorValues(values: Float32Array, path: string): void {
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!Number.isFinite(value) || value < 0 || value > 1) invalid('Drawable color values must be finite and inside [0, 1].', `${path}[${index}]`);
  }
}
function positive(value: number, path: string): void { if (!Number.isFinite(value) || value <= 0) invalid('Expected a positive finite number.', path); }
function positiveLimit(value: number | undefined, fallback: number, label: string): number { const result = value ?? fallback; if (!Number.isSafeInteger(result) || result < 1) throw new RangeError(`${label} must be a positive safe integer.`); return result; }
function record(value: unknown, path: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object.', path); return value as Record<string, unknown>; }
function array(value: unknown, path: string): unknown[] { if (!Array.isArray(value)) invalid('Expected an array.', path); return value; }
function string(value: unknown, path: string): string { if (typeof value !== 'string' || value.length === 0) invalid('Expected a non-empty string.', path); return value; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') invalid('Expected a boolean.', path); return value; }
function finite(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Expected a finite number.', path); return value; }
function nonNegativeInteger(value: unknown, path: string): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid('Expected a non-negative safe integer.', path); return value; }
function numberPair(value: unknown, path: string): readonly [number, number] { const values = array(value, path); if (values.length !== 2) invalid('Expected two numbers.', path); return [finite(values[0], `${path}[0]`), finite(values[1], `${path}[1]`)]; }
function range(value: unknown, path: string): Range { const values = array(value, path); if (values.length !== 2) invalid('Expected an offset/length pair.', path); return [nonNegativeInteger(values[0], `${path}[0]`), nonNegativeInteger(values[1], `${path}[1]`)]; }
function literal<T extends string>(value: unknown, allowed: readonly T[], path: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`Expected one of ${allowed.join(', ')}.`, path); return value as T; }
function invalid(message: string, path: string): never { throw new AnimationFormatError('E_ANIMATION_INVALID_FORMAT', message, path); }
function limit(message: string, path: string): never { throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', message, path); }
