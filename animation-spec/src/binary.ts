import { AnimationFormatError } from './errors';
import type {
  AnimationComponent,
  AnimationComposite,
  AnimationCompositeLayer,
  AnimationDocument,
  AnimationLayerEffect,
  AnimationNode,
  AnimationParseOptions,
  AnimationPath2DComponent,
  AnimationResource,
  AnimationSprite2DComponent,
  AnimationTransform2D,
  AnimationText2DComponent,
  AnimationTextAnimator,
  AnimationVectorGradientPaint,
  AnimationVectorShapeComponent,
  AnimationVectorSolidPaint,
  AnimationVectorStrokePaint,
  AnimationVectorValueTrack,
  ParsedAnimation,
} from './types';
import { ANIMATION_VECTOR_SHAPE_EXTENSION_ID } from './types';
import { TEXT_SELECTOR_BASES, TEXT_SELECTOR_SHAPES } from './text-selector';
import {
  finalizeParsedAnimation,
  parseAnimationValue,
  parseBinaryComponentValue,
  parseBinaryEffectsValue,
  parseBinaryResourceValue,
  parseBinaryTrackValue,
  parseBinaryTransformValue,
  resolveAnimationParseLimits,
} from './validation';

const HEADER_BYTES = 24;
const MAGIC = 0x31415948;
const CONTAINER_MAJOR = 2;
const CONTAINER_MINOR = 0;
const LEGACY_CONTAINER_MAJOR = 1;
const DEFAULT_PARSE_OPTIONS: AnimationParseOptions = Object.freeze({});
const UTF8_DECODER = new TextDecoder();
const UTF8_ENCODER = new TextEncoder();

const TRACK_PROPERTIES = ['position', 'rotation', 'scale', 'opacity'] as const;
const INTERPOLATIONS = ['step', 'linear', 'cubic-bezier'] as const;
const END_BEHAVIORS = ['loop', 'hold', 'destroy'] as const;
const COMPOSITE_KINDS = ['mask', 'matte'] as const;
const COMPOSITE_MODES = ['alpha', 'alpha-inverted', 'luma', 'luma-inverted'] as const;
const COMPOSITE_OPERATIONS = ['add', 'subtract', 'intersect', 'difference'] as const;
const VECTOR_STROKE_EXTENSION = 'org.haiyue.vector-stroke@1';
const VECTOR_PATH_MORPH_EXTENSION = 'org.haiyue.vector-path-morph@1';
const VECTOR_STROKE_KEYS = new Set([
  'type', 'commands', 'values', 'sourceComponent', 'color', 'width',
  'lineCap', 'lineJoin', 'miterLimit', 'tolerance',
]);
const VECTOR_PATH_MORPH_KEYS = new Set([
  'type', 'commands', 'times', 'values', 'valueSize', 'interpolation',
  'easings', 'fill', 'fillRule', 'tolerance',
]);

interface BinaryFloatRange {
  offset: number;
  length: number;
}

interface LegacyBinaryTrackMetadata {
  node: string;
  property: string;
  interpolation: string;
  times: BinaryFloatRange;
  values: BinaryFloatRange;
  easings?: BinaryFloatRange;
}

interface BinaryFloatBlock {
  readonly range: readonly [number, number];
  readonly values: Float32Array;
}

class BinaryFloatPoolBuilder {
  readonly blocks: BinaryFloatBlock[] = [];
  private readonly _deduplicated = new Map<string, readonly [number, number]>();
  count = 0;

  add(values: readonly number[] | Float32Array, deduplicate = false): readonly [number, number] {
    const floats = values instanceof Float32Array ? values : new Float32Array(values);
    if (deduplicate) {
      const key = floatBlockKey(floats);
      const existing = this._deduplicated.get(key);
      if (existing) return existing;
      const range = this._append(floats);
      this._deduplicated.set(key, range);
      return range;
    }
    return this._append(floats);
  }

  private _append(values: Float32Array): readonly [number, number] {
    const result = [this.count, values.length] as const;
    this.count += values.length;
    this.blocks.push({ range: result, values });
    return result;
  }
}

class BinaryStringTableBuilder {
  readonly values: string[] = [];
  private readonly _indices = new Map<string, number>();

  add(value: string | undefined): number {
    if (value === undefined) return -1;
    const existing = this._indices.get(value);
    if (existing !== undefined) return existing;
    const index = this.values.length;
    this.values.push(value);
    this._indices.set(value, index);
    return index;
  }
}

export function isAnimationBinary(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === MAGIC;
}

/** Encodes compact indexed metadata plus one contiguous zero-copy Float32 track/path pool. */
export function encodeAnimationBinary(
  document: AnimationDocument | ParsedAnimation,
  options: AnimationParseOptions = DEFAULT_PARSE_OPTIONS,
): ArrayBuffer {
  const parsed = isParsedAnimation(document)
    ? document
    : parseAnimationValue(document, options, 'json');
  const strings = new BinaryStringTableBuilder();
  const floats = new BinaryFloatPoolBuilder();
  const nodeIndices = new Map(parsed.nodes.map((node, index) => [node.id, index]));

  const resources = parsed.resources.map(resource => encodeResource(resource, strings));
  const nodes = parsed.nodes.map(node => [
    strings.add(node.id),
    strings.add(node.name),
    node.parent === undefined ? -1 : requiredMapIndex(nodeIndices, node.parent, 'node parent'),
    node.start ?? -1,
    node.duration ?? -1,
    node.transform ? encodeTransform(node.transform) : 0,
    node.composite ? encodeComposite(node.composite, nodeIndices, floats) : 0,
    node.components ? node.components.map(component => encodeComponent(component, floats, strings)) : 0,
    node.extensions ?? 0,
    node.effects ? encodeLayerEffects(node.effects, floats) : 0,
  ]);
  const tracks = parsed.tracks.map(track => [
    requiredMapIndex(nodeIndices, track.node, 'track node'),
    TRACK_PROPERTIES.indexOf(track.property),
    INTERPOLATIONS.indexOf(track.interpolation),
    floats.add(track.times, true),
    floats.add(track.values),
    track.easings ? floats.add(track.easings, true) : 0,
    track.spatialTangents ? floats.add(track.spatialTangents) : 0,
  ]);
  const metadata = [
    strings.add(parsed.name),
    parsed.canvas.width,
    parsed.canvas.height,
    parsed.duration,
    parsed.frameRate ?? 0,
    END_BEHAVIORS.indexOf(parsed.endBehavior),
    strings.values,
    resources,
    nodes,
    tracks,
    parsed.extensionsUsed.map(value => strings.add(value)),
    parsed.extensionsRequired.map(value => strings.add(value)),
    Object.keys(parsed.extensions).length === 0 ? 0 : parsed.extensions,
  ];
  return writeBinary(JSON.stringify(metadata), floats, options);
}

export function decodeAnimationBinary(
  buffer: ArrayBuffer,
  options: AnimationParseOptions = DEFAULT_PARSE_OPTIONS,
): ParsedAnimation {
  if (buffer.byteLength < 4) invalidBinary('Header is truncated.');
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== MAGIC) invalidBinary('Magic must be HYA1.');
  return decodeAnimationBinaryHeader(buffer, header, options);
}

/** @internal Parser entry point that checks and consumes the magic with one DataView. */
export function tryDecodeAnimationBinary(buffer: ArrayBuffer, options: AnimationParseOptions): ParsedAnimation | undefined {
  if (buffer.byteLength < 4) return undefined;
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== MAGIC) return undefined;
  return decodeAnimationBinaryHeader(buffer, header, options);
}

function decodeAnimationBinaryHeader(
  buffer: ArrayBuffer,
  header: DataView,
  options: AnimationParseOptions,
): ParsedAnimation {
  const limits = resolveAnimationParseLimits(options);
  if (buffer.byteLength > limits.maxInputBytes) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Binary input exceeds ${limits.maxInputBytes} bytes.`, '$binary');
  }
  if (buffer.byteLength < HEADER_BYTES) invalidBinary('Header is truncated.');
  const major = header.getUint16(4, true);
  const minor = header.getUint16(6, true);
  if (major !== LEGACY_CONTAINER_MAJOR && major !== CONTAINER_MAJOR) {
    invalidBinary(`Unsupported container version ${major}.${minor}.`);
  }
  if (minor !== 0) invalidBinary(`Unsupported container version ${major}.${minor}.`);
  const metadataOffset = header.getUint32(8, true);
  const metadataLength = header.getUint32(12, true);
  const floatOffset = header.getUint32(16, true);
  const floatCount = header.getUint32(20, true);
  if (metadataLength > limits.maxMetadataBytes) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Binary metadata exceeds ${limits.maxMetadataBytes} bytes.`, '$binary.metadata');
  }
  if (metadataOffset < HEADER_BYTES || metadataOffset + metadataLength > buffer.byteLength) invalidBinary('Metadata range is outside the buffer.');
  if ((floatOffset & 3) !== 0 || floatOffset < metadataOffset + metadataLength || floatOffset + floatCount * 4 > buffer.byteLength) {
    invalidBinary('Float pool range is invalid or unaligned.');
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(UTF8_DECODER.decode(new Uint8Array(buffer, metadataOffset, metadataLength)));
  } catch (error) {
    invalidBinary(`Metadata JSON cannot be decoded: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const floatPool = new Float32Array(buffer, floatOffset, floatCount);
  return major === LEGACY_CONTAINER_MAJOR
    ? decodeLegacyMetadata(metadata, floatPool, buffer, options)
    : decodeCompactMetadata(metadata, floatPool, buffer, options, limits);
}

function writeBinary(metadata: string, floatPool: BinaryFloatPoolBuilder, options: AnimationParseOptions): ArrayBuffer {
  const metadataBytes = UTF8_ENCODER.encode(metadata);
  const metadataOffset = HEADER_BYTES;
  const floatOffset = align4(metadataOffset + metadataBytes.byteLength);
  const totalBytes = floatOffset + floatPool.count * 4;
  const limits = resolveAnimationParseLimits(options);
  if (metadataBytes.byteLength > limits.maxMetadataBytes) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Binary metadata exceeds ${limits.maxMetadataBytes} bytes.`, '$binary.metadata');
  }
  if (totalBytes > limits.maxInputBytes) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `Binary output exceeds ${limits.maxInputBytes} bytes.`, '$binary');
  }
  const buffer = new ArrayBuffer(totalBytes);
  const header = new DataView(buffer);
  header.setUint32(0, MAGIC, true);
  header.setUint16(4, CONTAINER_MAJOR, true);
  header.setUint16(6, CONTAINER_MINOR, true);
  header.setUint32(8, metadataOffset, true);
  header.setUint32(12, metadataBytes.byteLength, true);
  header.setUint32(16, floatOffset, true);
  header.setUint32(20, floatPool.count, true);
  new Uint8Array(buffer, metadataOffset, metadataBytes.byteLength).set(metadataBytes);
  const output = new Float32Array(buffer, floatOffset, floatPool.count);
  for (const block of floatPool.blocks) output.set(block.values, block.range[0]);
  return buffer;
}

function encodeResource(resource: Readonly<AnimationResource>, strings: BinaryStringTableBuilder): unknown[] {
  return [
    resource.type === 'image' ? 0 : resource.type === 'audio' ? 1 : 2,
    strings.add(resource.id),
    strings.add(resource.uri),
    resource.type === 'image' ? resource.width ?? 0 : 0,
    resource.type === 'image' ? resource.height ?? 0 : 0,
    strings.add(resource.mimeType),
    strings.add(resource.integrity),
    resource.type === 'image' ? resource.colorSpace === undefined ? -1 : resource.colorSpace === 'srgb' ? 0 : 1 : -1,
  ];
}

function encodeTransform(transform: Readonly<AnimationTransform2D>): unknown[] {
  return [
    transform.position ?? 0,
    transform.rotation ?? null,
    transform.scale ?? 0,
    transform.anchor ?? 0,
    transform.opacity ?? -1,
  ];
}

function encodeComposite(
  composite: Readonly<AnimationComposite>,
  nodeIndices: ReadonlyMap<string, number>,
  floats: BinaryFloatPoolBuilder,
): unknown[] {
  const layers = 'layers' in composite ? composite.layers : [composite];
  // Keep the original three-field encoding for the common legacy-compatible case.
  if (layers.length === 1 && layers[0]!.operation === undefined
    && layers[0]!.feather === undefined && layers[0]!.expansion === undefined
    && layers[0]!.expansionTrack === undefined
    && (layers[0]!.mode === 'alpha' || layers[0]!.mode === 'alpha-inverted')) {
    const layer = layers[0]!;
    return [
      COMPOSITE_KINDS.indexOf(layer.kind),
      requiredMapIndex(nodeIndices, layer.source, 'composite source'),
      COMPOSITE_MODES.indexOf(layer.mode),
    ];
  }
  return layers.map(layer => [
    COMPOSITE_KINDS.indexOf(layer.kind),
    requiredMapIndex(nodeIndices, layer.source, 'composite source'),
    COMPOSITE_MODES.indexOf(layer.mode),
    COMPOSITE_OPERATIONS.indexOf(layer.operation ?? 'add'),
    layer.feather ?? 0,
    layer.expansion ?? 0,
    encodeOptionalVectorTrack(layer.expansionTrack, floats),
  ]);
}

function encodeComponent(
  component: Readonly<AnimationComponent>,
  floats: BinaryFloatPoolBuilder,
  strings: BinaryStringTableBuilder,
): unknown[] {
  if (component.type === 'shape2d') {
    return [
      0,
      component.shape === 'rect' ? 0 : 1,
      component.size,
      component.position ?? 0,
      component.fill,
    ];
  }
  if (isPath2DComponent(component)) {
    return [
      1,
      strings.add(component.commands),
      floats.add(component.values, true),
      component.fill,
      component.fillRule === 'evenodd' ? 1 : 0,
      component.tolerance ?? -1,
    ];
  }
  if (isCompactVectorStrokeComponent(component)) {
    return [
      3,
      strings.add(component.commands),
      component.values === undefined ? 0 : floats.add(component.values, true),
      component.sourceComponent ?? -1,
      component.color,
      component.width,
      component.lineCap === 'butt' ? 0 : component.lineCap === 'round' ? 1 : 2,
      component.lineJoin === 'miter' ? 0 : component.lineJoin === 'round' ? 1 : 2,
      component.miterLimit,
      component.tolerance ?? -1,
    ];
  }
  if (isCompactVectorPathMorphComponent(component)) {
    return [
      4,
      strings.add(component.commands),
      floats.add(component.times),
      floats.add(component.values, true),
      component.valueSize,
      component.interpolation === 'step' ? 0 : component.interpolation === 'linear' ? 1 : 2,
      component.easings === undefined ? 0 : floats.add(component.easings),
      component.fill,
      component.fillRule === 'evenodd' ? 1 : 0,
      component.tolerance ?? -1,
    ];
  }
  if (isAnimationVectorShapeComponent(component)) {
    return [
      5,
      strings.add(component.commands),
      floats.add(component.values, true),
      encodeOptionalVectorTrack(component.morph, floats, true),
      component.fill ? encodeVectorFill(component.fill, floats) : 0,
      component.stroke ? encodeVectorStroke(component.stroke, floats) : 0,
      component.fillRule === 'evenodd' ? 1 : 0,
      component.tolerance ?? -1,
      component.modifiers ? component.modifiers.map(modifier => encodeVectorModifier(modifier, floats)) : 0,
      component.morphRelative === true ? 1 : 0,
    ];
  }
  if (component.type === 'sprite2d') return encodeSpriteComponent(
    component as Readonly<AnimationSprite2DComponent>,
    floats,
    strings,
  );
  if (component.type === 'text2d') return encodeTextComponent(component as AnimationText2DComponent, floats, strings);
  return [2, component];
}

function encodeSpriteComponent(
  component: Readonly<AnimationSprite2DComponent>,
  floats: BinaryFloatPoolBuilder,
  strings: BinaryStringTableBuilder,
): unknown[] {
  return [
    7,
    strings.add(component.resource),
    component.size,
    component.position ?? 0,
    component.tint ?? 0,
    component.uvRect ?? 0,
    encodeOptionalVectorTrack(component.uvRectTrack, floats),
  ];
}

function encodeTextComponent(
  component: Readonly<AnimationText2DComponent>,
  floats: BinaryFloatPoolBuilder,
  strings: BinaryStringTableBuilder,
): unknown[] {
  return [
    6,
    strings.add(component.text), component.size, component.position ?? 0,
    strings.add(component.fontFamily), component.fontSize ?? 0,
    encodeFontWeight(component.fontWeight, strings),
    component.fontStyle === undefined ? -1 : component.fontStyle === 'normal' ? 0 : 1,
    strings.add(component.fontResource), component.lineHeight ?? 0, component.tracking ?? null,
    component.textAlign === undefined ? -1 : ['left', 'center', 'right'].indexOf(component.textAlign),
    component.verticalAlign === undefined ? -1 : ['top', 'middle', 'bottom'].indexOf(component.verticalAlign),
    component.color, component.backgroundColor ?? 0, component.padding ?? -1,
    component.resolutionScale ?? 0,
    component.documents?.map(document => [
      document.time, strings.add(document.text), strings.add(document.fontFamily), document.fontSize ?? 0,
      encodeFontWeight(document.fontWeight, strings),
      document.fontStyle === undefined ? -1 : document.fontStyle === 'normal' ? 0 : 1,
      strings.add(document.fontResource), document.lineHeight ?? 0, document.tracking ?? null,
      document.textAlign === undefined ? -1 : ['left', 'center', 'right'].indexOf(document.textAlign),
      document.color ?? 0,
    ]) ?? 0,
    component.animators?.map(animator => encodeTextAnimator(animator, floats)) ?? 0,
    component.expression ?? 0,
    [
      component.fit === 'shrink' ? 1 : 0,
      component.wrap === 'word' ? 1 : 0,
      component.lineBackground ? [
        component.lineBackground.fill,
        component.lineBackground.stroke ?? 0,
        component.lineBackground.strokeWidth ?? 0,
        component.lineBackground.cornerRadius ?? 0,
        component.lineBackground.padding ?? 0,
      ] : 0,
    ],
  ];
}

function encodeFontWeight(value: string | number | undefined, strings: BinaryStringTableBuilder): unknown {
  if (value === undefined) return null;
  return typeof value === 'number' ? value : [-1, strings.add(value)];
}

function encodeTextAnimator(animator: Readonly<AnimationTextAnimator>, floats: BinaryFloatPoolBuilder): unknown[] {
  const selector = animator.selector;
  return [[
    selector.start, selector.end, selector.offset ?? 0,
    selector.units === 'index' ? 1 : 0, selector.amount ?? 1,
    TEXT_SELECTOR_SHAPES.indexOf(selector.shape ?? 'square'),
    encodeOptionalVectorTrack(selector.startTrack, floats),
    encodeOptionalVectorTrack(selector.endTrack, floats),
    encodeOptionalVectorTrack(selector.offsetTrack, floats),
    encodeOptionalVectorTrack(selector.amountTrack, floats),
    selector.basedOn === undefined ? -1 : TEXT_SELECTOR_BASES.indexOf(selector.basedOn),
    selector.easing ?? 0,
    selector.smoothness ?? -1,
    selector.randomSeed ?? null,
  ],
  animator.position ?? 0, animator.scale ?? 0, animator.rotation ?? null,
  animator.opacity ?? -1, animator.fillColor ?? 0, animator.tracking ?? null,
  encodeOptionalVectorTrack(animator.positionTrack, floats),
  encodeOptionalVectorTrack(animator.scaleTrack, floats),
  encodeOptionalVectorTrack(animator.rotationTrack, floats),
  encodeOptionalVectorTrack(animator.opacityTrack, floats),
  encodeOptionalVectorTrack(animator.fillColorTrack, floats),
  encodeOptionalVectorTrack(animator.trackingTrack, floats)];
}

function encodeLayerEffects(effects: readonly Readonly<AnimationLayerEffect>[], floats: BinaryFloatPoolBuilder): unknown[] {
  return effects.map(effect => {
    if (effect.kind === 'tint') return [
      0, effect.black, effect.white, effect.amount,
      encodeOptionalVectorTrack(effect.blackTrack, floats),
      encodeOptionalVectorTrack(effect.whiteTrack, floats),
      encodeOptionalVectorTrack(effect.amountTrack, floats),
    ];
    if (effect.kind === 'fill') return [
      1, effect.color, effect.opacity ?? 1,
      encodeOptionalVectorTrack(effect.colorTrack, floats),
      encodeOptionalVectorTrack(effect.opacityTrack, floats),
    ];
    if (effect.kind === 'opacity') return [2, effect.opacity, encodeOptionalVectorTrack(effect.opacityTrack, floats)];
    if (effect.kind === 'color-matrix') return [
      3, floats.add(effect.matrix), encodeOptionalVectorTrack(effect.matrixTrack, floats),
    ];
    if (effect.kind === 'blur') return [4, effect.radius, encodeOptionalVectorTrack(effect.radiusTrack, floats)];
    return [
      5, effect.color, effect.opacity, effect.offset, effect.blur,
      encodeOptionalVectorTrack(effect.colorTrack, floats),
      encodeOptionalVectorTrack(effect.opacityTrack, floats),
      encodeOptionalVectorTrack(effect.offsetTrack, floats),
      encodeOptionalVectorTrack(effect.blurTrack, floats),
    ];
  });
}

function encodeVectorModifier(
  modifier: Readonly<import('./types').AnimationVectorPathModifier>,
  floats: BinaryFloatPoolBuilder,
): unknown[] {
  if (modifier.kind === 'round-corners') return [
    1, modifier.radius, encodeOptionalVectorTrack(modifier.radiusTrack, floats),
  ];
  return [
    0, modifier.start, modifier.end, modifier.offset, modifier.mode === 'individual' ? 1 : 0,
    encodeOptionalVectorTrack(modifier.startTrack, floats),
    encodeOptionalVectorTrack(modifier.endTrack, floats),
    encodeOptionalVectorTrack(modifier.offsetTrack, floats),
  ];
}

function isAnimationVectorShapeComponent(component: AnimationComponent): component is AnimationVectorShapeComponent {
  return component.type === ANIMATION_VECTOR_SHAPE_EXTENSION_ID
    && typeof (component as Partial<AnimationVectorShapeComponent>).commands === 'string'
    && (Array.isArray((component as Partial<AnimationVectorShapeComponent>).values)
      || (component as Partial<AnimationVectorShapeComponent>).values instanceof Float32Array);
}

function encodeVectorTrack(
  track: Readonly<AnimationVectorValueTrack>,
  floats: BinaryFloatPoolBuilder,
  deduplicateValues = false,
): unknown[] {
  return [
    floats.add(track.times, true),
    floats.add(track.values, deduplicateValues),
    track.valueSize,
    INTERPOLATIONS.indexOf(track.interpolation),
    track.easings ? floats.add(track.easings, true) : 0,
  ];
}

function encodeOptionalVectorTrack(
  track: Readonly<AnimationVectorValueTrack> | undefined,
  floats: BinaryFloatPoolBuilder,
  deduplicateValues = false,
): unknown[] | 0 {
  return track ? encodeVectorTrack(track, floats, deduplicateValues) : 0;
}

function encodeVectorFill(
  fill: Readonly<AnimationVectorSolidPaint | AnimationVectorGradientPaint>,
  floats: BinaryFloatPoolBuilder,
): unknown[] {
  if (fill.kind === 'solid') return [
    0,
    fill.color,
    encodeOptionalVectorTrack(fill.colorTrack, floats),
    encodeOptionalVectorTrack(fill.opacityTrack, floats),
    fill.opacity ?? 1,
  ];
  return [
    fill.kind === 'linear-gradient' ? 1 : 2,
    fill.start,
    fill.end,
    floats.add(fill.stops),
    encodeOptionalVectorTrack(fill.startTrack, floats),
    encodeOptionalVectorTrack(fill.endTrack, floats),
    encodeOptionalVectorTrack(fill.stopsTrack, floats),
    encodeOptionalVectorTrack(fill.opacityTrack, floats),
    fill.opacity ?? 1,
  ];
}

function encodeVectorStroke(stroke: Readonly<AnimationVectorStrokePaint>, floats: BinaryFloatPoolBuilder): unknown[] {
  return [
    stroke.color,
    stroke.width,
    ['butt', 'round', 'square'].indexOf(stroke.lineCap),
    ['miter', 'round', 'bevel'].indexOf(stroke.lineJoin),
    stroke.miterLimit,
    stroke.dash ? floats.add(stroke.dash) : 0,
    stroke.dashOffset ?? 0,
    encodeOptionalVectorTrack(stroke.colorTrack, floats),
    encodeOptionalVectorTrack(stroke.opacityTrack, floats),
    encodeOptionalVectorTrack(stroke.widthTrack, floats),
    encodeOptionalVectorTrack(stroke.dashOffsetTrack, floats),
    stroke.gradient ? encodeVectorFill(stroke.gradient, floats) : 0,
    stroke.opacity ?? 1,
  ];
}

function decodeCompactMetadata(
  value: unknown,
  floatPool: Float32Array,
  buffer: ArrayBuffer,
  options: AnimationParseOptions,
  limits: ReturnType<typeof resolveAnimationParseLimits>,
): ParsedAnimation {
  const root = compactArray(value, '$binary.metadata', 13);
  const strings = compactArray(root[6], '$binary.metadata[6]').map((item, index) => (
    requiredString(item, `$binary.metadata[6][${index}]`)
  ));
  const encodedResources = compactArray(root[7], '$binary.metadata[7]');
  binaryLimit(encodedResources.length, limits.maxResources, 'resources', '$binary.metadata[7]');
  const resourceIds = new Set<string>();
  const resources = encodedResources.map((item, index) => parseBinaryResourceValue(
    decodeResource(item, strings, `$binary.metadata[7][${index}]`), index, resourceIds,
  ));
  const encodedNodeValues = compactArray(root[8], '$binary.metadata[8]');
  const encodedNodes = encodedNodeValues.map((item, index) => (
    compactArray(item, `$binary.metadata[8][${index}]`, 9)
  ));
  binaryLimit(encodedNodes.length, limits.maxNodes, 'nodes', '$binary.metadata[8]');
  const nodeIds = encodedNodes.map((node, index) => requiredNonEmptyString(
    indexedString(strings, node[0], `$binary.metadata[8][${index}][0]`),
    `$binary.metadata[8][${index}][0]`,
  ));
  const parsedNodeIds = new Set<string>();
  for (let index = 0; index < nodeIds.length; index++) {
    const id = nodeIds[index]!;
    if (parsedNodeIds.has(id)) invalidBinary(`Duplicate node id "${id}" at $binary.metadata[8][${index}][0].`);
    parsedNodeIds.add(id);
  }
  const parentIndices = validateCompactNodeGraph(encodedNodes, nodeIds.length);
  let componentCount = 0;
  let pathValueCount = 0;
  let textCharacterCount = 0;
  let particleCapacity = 0;
  const nodes = encodedNodes.map((item, index) => {
    const node = decodeNode(
      item, index, strings, nodeIds, parentIndices[index], floatPool, options,
      (kind, count) => {
        if (kind === 'path') {
          pathValueCount += count;
          binaryLimit(pathValueCount, limits.maxPathValues, 'path values', `$.nodes[${index}].components`);
        } else if (kind === 'text') {
          textCharacterCount += count;
          binaryLimit(textCharacterCount, limits.maxTextCharacters, 'text characters', `$.nodes[${index}].components`);
        } else {
          particleCapacity += count;
          binaryLimit(particleCapacity, limits.maxParticleCapacity, 'particle capacity', `$.nodes[${index}].components`);
        }
      },
    );
    componentCount += node.components?.length ?? 0;
    binaryLimit(componentCount, limits.maxComponents, 'components', `$.nodes[${index}].components`);
    return node;
  });
  const encodedTracks = compactArray(root[9], '$binary.metadata[9]');
  binaryLimit(encodedTracks.length, limits.maxTracks, 'tracks', '$binary.metadata[9]');
  const duration = positiveFiniteNumber(root[3], '$binary.metadata[3]');
  let keyframeCount = 0;
  const tracks = encodedTracks.map((item, index) => {
    const path = `$binary.metadata[9][${index}]`;
    const track = compactArray(item, path, 6);
    const nodeIndex = boundedIndex(track[0], nodeIds.length, `${path}[0]`);
    const parsed = parseBinaryTrackValue({
      node: nodeIds[nodeIndex]!,
      property: indexedLiteral(TRACK_PROPERTIES, track[1], `${path}[1]`),
      interpolation: indexedLiteral(INTERPOLATIONS, track[2], `${path}[2]`),
      times: compactFloatView(floatPool, track[3], `${path}[3]`),
      values: compactFloatView(floatPool, track[4], `${path}[4]`),
      ...(track[5] === 0 ? {} : { easings: compactFloatView(floatPool, track[5], `${path}[5]`) }),
      ...(track.length < 7 || track[6] === 0 ? {} : {
        spatialTangents: compactFloatView(floatPool, track[6], `${path}[6]`),
      }),
    }, index, parsedNodeIds, duration, options.copyFloatData === true);
    keyframeCount += parsed.times.length;
    binaryLimit(keyframeCount, limits.maxKeyframes, 'keyframes', `$.tracks[${index}].times`);
    return parsed;
  });
  const frameRate = finiteNumber(root[4], '$binary.metadata[4]');
  if (frameRate < 0) invalidBinary('Frame rate must be positive or zero when omitted.');
  const extensions = root[12] === 0 ? {} : binaryRecord(root[12], '$binary.metadata[12]');
  return finalizeParsedAnimation({
    ...(root[0] === -1 ? {} : { name: indexedString(strings, root[0], '$binary.metadata[0]') }),
    canvas: Object.freeze({
      width: positiveFiniteNumber(root[1], '$binary.metadata[1]'),
      height: positiveFiniteNumber(root[2], '$binary.metadata[2]'),
      coordinateSystem: 'screen-y-down',
    }),
    duration,
    ...(frameRate === 0 ? {} : { frameRate }),
    endBehavior: indexedLiteral(END_BEHAVIORS, root[5], '$binary.metadata[5]'),
    resources,
    nodes,
    tracks,
    extensionsUsed: decodeStringIndices(root[10], strings, '$binary.metadata[10]'),
    extensionsRequired: decodeStringIndices(root[11], strings, '$binary.metadata[11]'),
    extensions,
  }, options, 'binary', buffer, true);
}

function validateCompactNodeGraph(encodedNodes: readonly unknown[][], nodeCount: number): Array<number | undefined> {
  const compositeSources: number[][] = Array.from({ length: nodeCount }, () => []);
  const parents = encodedNodes.map((node, index) => {
    const parent = optionalBoundedIndex(node[2], nodeCount, `$binary.metadata[8][${index}][2]`);
    if (node[6] !== 0) {
      const composite = compactArray(node[6], `$binary.metadata[8][${index}][6]`);
      const layers = typeof composite[0] === 'number' ? [composite] : composite.map((value, layerIndex) => (
        compactArray(value, `$binary.metadata[8][${index}][6][${layerIndex}]`, 3)
      ));
      if (layers.length < 1 || layers.length > 8) invalidBinary(`Composite stack must contain between 1 and 8 layers at $binary.metadata[8][${index}][6].`);
      for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        const source = boundedIndex(layers[layerIndex]![1], nodeCount, `$binary.metadata[8][${index}][6][${layerIndex}][1]`);
        if (source === index) invalidBinary(`Composite source cannot reference its own node at $binary.metadata[8][${index}][6][${layerIndex}][1].`);
        compositeSources[index]!.push(source);
      }
    }
    return parent;
  });
  const states = new Uint8Array(nodeCount);
  for (let index = 0; index < nodeCount; index++) {
    if (states[index] !== 0) continue;
    let cursor: number | undefined = index;
    while (cursor !== undefined && states[cursor] === 0) {
      states[cursor] = 1;
      cursor = parents[cursor];
    }
    if (cursor !== undefined && states[cursor] === 1) {
      invalidBinary(`Node hierarchy contains a cycle at $binary.metadata[8][${index}][2].`);
    }
    cursor = index;
    while (cursor !== undefined && states[cursor] === 1) {
      states[cursor] = 2;
      cursor = parents[cursor];
    }
  }
  states.fill(0);
  const visitComposite = (index: number): void => {
    if (states[index] === 2) return;
    if (states[index] === 1) invalidBinary(`Composite graph contains a cycle at $binary.metadata[8][${index}][6].`);
    states[index] = 1;
    for (const source of compositeSources[index]!) visitComposite(source);
    states[index] = 2;
  };
  for (let index = 0; index < nodeCount; index++) visitComposite(index);
  return parents;
}

function decodeResource(value: unknown, strings: readonly string[], path: string): Record<string, unknown> {
  const resource = compactArray(value, path, 8);
  const type = indexedLiteral(['image', 'audio', 'binary'] as const, resource[0], `${path}[0]`);
  const id = indexedString(strings, resource[1], `${path}[1]`);
  const uri = indexedString(strings, resource[2], `${path}[2]`);
  const mimeType = optionalIndexedString(strings, resource[5], `${path}[5]`);
  const integrity = optionalIndexedString(strings, resource[6], `${path}[6]`);
  if (type === 'image') {
    const colorCode = finiteInteger(resource[7], `${path}[7]`);
    if (colorCode < -1 || colorCode > 1) invalidBinary(`Invalid image color-space code at ${path}[7].`);
    return {
      id, type, uri,
      ...(resource[3] === 0 ? {} : { width: resource[3] }),
      ...(resource[4] === 0 ? {} : { height: resource[4] }),
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(integrity === undefined ? {} : { integrity }),
      ...(colorCode === -1 ? {} : { colorSpace: colorCode === 0 ? 'srgb' : 'linear' }),
    };
  }
  return {
    id, type, uri,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(integrity === undefined ? {} : { integrity }),
  };
}

function decodeNode(
  node: unknown[],
  index: number,
  strings: readonly string[],
  nodeIds: readonly string[],
  parentIndex: number | undefined,
  floatPool: Float32Array,
  options: AnimationParseOptions,
  countBudget: (kind: 'path' | 'text' | 'particle', count: number) => void,
): Readonly<AnimationNode> {
  const path = `$binary.metadata[8][${index}]`;
  const name = optionalIndexedString(strings, node[1], `${path}[1]`);
  const start = node[3] === -1 ? undefined : nonNegativeFiniteNumber(node[3], `${path}[3]`);
  const duration = node[4] === -1 ? undefined : positiveFiniteNumber(node[4], `${path}[4]`);
  const composite = node[6] === 0 ? undefined : decodeComposite(node[6], nodeIds, floatPool, `${path}[6]`);
  const components = node[7] === 0 ? undefined : compactArray(node[7], `${path}[7]`).map((component, componentIndex) => (
    decodeComponent(
      component, strings, floatPool, `${path}[7][${componentIndex}]`,
      `$.nodes[${index}].components[${componentIndex}]`, options, countBudget,
    )
  ));
  const effects = node.length < 10 || node[9] === 0 ? undefined : parseBinaryEffectsValue(
    decodeLayerEffects(node[9], floatPool, `${path}[9]`),
    `$.nodes[${index}].effects`,
    options.copyFloatData === true,
  );
  return Object.freeze({
    id: nodeIds[index]!,
    ...(name === undefined ? {} : { name }),
    ...(parentIndex === undefined ? {} : { parent: nodeIds[parentIndex]! }),
    ...(start === undefined || start === 0 ? {} : { start }),
    ...(duration === undefined ? {} : { duration }),
    ...(node[5] === 0 ? {} : { transform: parseBinaryTransformValue(decodeTransform(node[5], `${path}[5]`), `$.nodes[${index}].transform`) }),
    ...(composite === undefined ? {} : { composite }),
    ...(effects === undefined ? {} : { effects }),
    ...(components === undefined ? {} : { components: Object.freeze(components) }),
    ...(node[8] === 0 ? {} : { extensions: Object.freeze({ ...binaryRecord(node[8], `${path}[8]`) }) }),
  });
}

function decodeTransform(value: unknown, path: string): Record<string, unknown> {
  const transform = compactArray(value, path, 5);
  return {
    ...(transform[0] === 0 ? {} : { position: transform[0] }),
    ...(transform[1] === null ? {} : { rotation: transform[1] }),
    ...(transform[2] === 0 ? {} : { scale: transform[2] }),
    ...(transform[3] === 0 ? {} : { anchor: transform[3] }),
    ...(transform[4] === -1 ? {} : { opacity: transform[4] }),
  };
}

function decodeComponent(
  value: unknown,
  strings: readonly string[],
  floatPool: Float32Array,
  path: string,
  validationPath: string,
  options: AnimationParseOptions,
  countBudget: (kind: 'path' | 'text' | 'particle', count: number) => void,
): AnimationComponent {
  const component = compactArray(value, path, 2);
  const code = finiteInteger(component[0], `${path}[0]`);
  if (code === 0) {
    if (component.length < 5) invalidBinary(`Compact shape component is truncated at ${path}.`);
    return Object.freeze({
      type: 'shape2d',
      shape: indexedLiteral(['rect', 'ellipse'] as const, component[1], `${path}[1]`),
      size: positiveFiniteTuple(component[2], 2, `${path}[2]`) as unknown as readonly [number, number],
      ...(component[3] === 0 ? {} : { position: finiteTuple(component[3], 2, `${path}[3]`) as unknown as readonly [number, number] }),
      fill: unitFiniteTuple(component[4], 4, `${path}[4]`) as unknown as readonly [number, number, number, number],
    });
  }
  if (code === 1) {
    if (component.length < 6) invalidBinary(`Compact path component is truncated at ${path}.`);
    return parseBinaryComponentValue({
      type: 'path2d',
      commands: indexedString(strings, component[1], `${path}[1]`),
      values: compactFloatView(floatPool, component[2], `${path}[2]`),
      fill: component[3],
      fillRule: indexedLiteral(['nonzero', 'evenodd'] as const, component[4], `${path}[4]`),
      ...(component[5] === -1 ? {} : { tolerance: component[5] }),
    }, validationPath, options, countBudget);
  }
  if (code === 2) {
    return parseBinaryComponentValue(binaryRecord(component[1], `${path}[1]`), validationPath, options, countBudget);
  }
  if (code === 3) {
    if (component.length < 10) invalidBinary(`Compact Lottie stroke component is truncated at ${path}.`);
    const commands = optionalIndexedString(strings, component[1], `${path}[1]`);
    const sourceComponent = finiteInteger(component[3], `${path}[3]`);
    return parseBinaryComponentValue({
      type: VECTOR_STROKE_EXTENSION,
      ...(commands === undefined ? {} : { commands }),
      // The versioned Lottie stroke extension currently defines runtime values as an ordinary
      // number array; keep the on-disk Float32 packing without changing that extension contract.
      ...(component[2] === 0 ? {} : { values: Array.from(compactFloatView(floatPool, component[2], `${path}[2]`)) }),
      ...(sourceComponent === -1 ? {} : { sourceComponent }),
      color: component[4],
      width: component[5],
      lineCap: indexedLiteral(['butt', 'round', 'square'] as const, component[6], `${path}[6]`),
      lineJoin: indexedLiteral(['miter', 'round', 'bevel'] as const, component[7], `${path}[7]`),
      miterLimit: component[8],
      ...(component[9] === -1 ? {} : { tolerance: component[9] }),
    }, validationPath, options, countBudget);
  }
  if (code === 4) {
    if (component.length < 10) invalidBinary(`Compact Lottie path morph component is truncated at ${path}.`);
    return parseBinaryComponentValue({
      type: VECTOR_PATH_MORPH_EXTENSION,
      commands: indexedString(strings, component[1], `${path}[1]`),
      times: Array.from(compactFloatView(floatPool, component[2], `${path}[2]`)),
      values: Array.from(compactFloatView(floatPool, component[3], `${path}[3]`)),
      valueSize: finiteInteger(component[4], `${path}[4]`),
      interpolation: indexedLiteral(INTERPOLATIONS, component[5], `${path}[5]`),
      ...(component[6] === 0 ? {} : { easings: Array.from(compactFloatView(floatPool, component[6], `${path}[6]`)) }),
      fill: component[7],
      fillRule: indexedLiteral(['nonzero', 'evenodd'] as const, component[8], `${path}[8]`),
      ...(component[9] === -1 ? {} : { tolerance: component[9] }),
    }, validationPath, options, countBudget);
  }
  if (code === 5) {
    if (component.length < 8) invalidBinary(`Compact vector shape component is truncated at ${path}.`);
    return parseBinaryComponentValue({
      type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
      commands: indexedString(strings, component[1], `${path}[1]`),
      values: compactFloatView(floatPool, component[2], `${path}[2]`),
      ...decodeVectorTrackField(component, 3, 'morph', floatPool, path),
      ...(component[4] === 0 ? {} : { fill: decodeVectorFill(component[4], floatPool, `${path}[4]`) }),
      ...(component[5] === 0 ? {} : { stroke: decodeVectorStroke(component[5], floatPool, `${path}[5]`) }),
      fillRule: indexedLiteral(['nonzero', 'evenodd'] as const, component[6], `${path}[6]`),
      ...(component[7] === -1 ? {} : { tolerance: component[7] }),
      ...(component.length < 9 || component[8] === 0 ? {} : {
        modifiers: compactArray(component[8], `${path}[8]`).map((modifier, index) => (
          decodeVectorModifier(modifier, floatPool, `${path}[8][${index}]`)
        )),
      }),
      ...(component.length < 10 || component[9] !== 1 ? {} : { morphRelative: true }),
    }, validationPath, options, countBudget);
  }
  if (code === 6) {
    if (component.length < 19) invalidBinary(`Compact text component is truncated at ${path}.`);
    return parseBinaryComponentValue({
      type: 'text2d',
      text: indexedString(strings, component[1], `${path}[1]`),
      size: component[2],
      ...(component[3] === 0 ? {} : { position: component[3] }),
      ...decodeOptionalStringField(component[4], 'fontFamily', strings, `${path}[4]`),
      ...(component[5] === 0 ? {} : { fontSize: component[5] }),
      ...decodeFontWeightField(component[6], strings, `${path}[6]`),
      ...(component[7] === -1 ? {} : { fontStyle: indexedLiteral(['normal', 'italic'] as const, component[7], `${path}[7]`) }),
      ...decodeOptionalStringField(component[8], 'fontResource', strings, `${path}[8]`),
      ...(component[9] === 0 ? {} : { lineHeight: component[9] }),
      ...(component[10] === null ? {} : { tracking: component[10] }),
      ...(component[11] === -1 ? {} : { textAlign: indexedLiteral(['left', 'center', 'right'] as const, component[11], `${path}[11]`) }),
      ...(component[12] === -1 ? {} : { verticalAlign: indexedLiteral(['top', 'middle', 'bottom'] as const, component[12], `${path}[12]`) }),
      color: component[13],
      ...(component[14] === 0 ? {} : { backgroundColor: component[14] }),
      ...(component[15] === -1 ? {} : { padding: component[15] }),
      ...(component[16] === 0 ? {} : { resolutionScale: component[16] }),
      ...(component[17] === 0 ? {} : {
        documents: compactArray(component[17], `${path}[17]`).map((document, index) => (
          decodeTextDocument(document, strings, `${path}[17][${index}]`)
        )),
      }),
      ...(component[18] === 0 ? {} : {
        animators: compactArray(component[18], `${path}[18]`).map((animator, index) => (
          decodeTextAnimator(animator, floatPool, `${path}[18][${index}]`)
        )),
      }),
      ...(component.length < 20 || component[19] === 0 ? {} : { expression: component[19] }),
      ...(component.length < 21 ? {} : decodeTextLayoutFields(component[20], `${path}[20]`)),
    }, validationPath, options, countBudget);
  }
  if (code === 7) {
    if (component.length < 7) invalidBinary(`Compact sprite component is truncated at ${path}.`);
    return parseBinaryComponentValue({
      type: 'sprite2d',
      resource: indexedString(strings, component[1], `${path}[1]`),
      size: component[2],
      ...(component[3] === 0 ? {} : { position: component[3] }),
      ...(component[4] === 0 ? {} : { tint: component[4] }),
      ...(component[5] === 0 ? {} : { uvRect: component[5] }),
      ...decodeVectorTrackField(component, 6, 'uvRectTrack', floatPool, path),
    }, validationPath, options, countBudget);
  }
  invalidBinary(`Unknown compact component code ${code} at ${path}[0].`);
}

function decodeOptionalStringField(
  value: unknown,
  key: string,
  strings: readonly string[],
  path: string,
): Record<string, unknown> {
  const decoded = optionalIndexedString(strings, value, path);
  return decoded === undefined ? {} : { [key]: decoded };
}

function decodeTextLayoutFields(value: unknown, path: string): Record<string, unknown> {
  const fields = compactArray(value, path);
  if (fields.length < 3) invalidBinary(`Compact text layout fields are truncated at ${path}.`);
  const background = fields[2] === 0 ? undefined : compactArray(fields[2], `${path}[2]`);
  if (background !== undefined && background.length < 5) {
    invalidBinary(`Compact text line background is truncated at ${path}[2].`);
  }
  return {
    ...(fields[0] === 1 ? { fit: 'shrink' } : {}),
    ...(fields[1] === 1 ? { wrap: 'word' } : {}),
    ...(background === undefined ? {} : {
      lineBackground: {
        fill: background[0],
        ...(background[1] === 0 ? {} : { stroke: background[1] }),
        ...(background[2] === 0 ? {} : { strokeWidth: background[2] }),
        ...(background[3] === 0 ? {} : { cornerRadius: background[3] }),
        ...(background[4] === 0 ? {} : { padding: background[4] }),
      },
    }),
  };
}

function decodeFontWeightField(value: unknown, strings: readonly string[], path: string): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value === 'number') return { fontWeight: value };
  const encoded = compactArray(value, path, 2);
  if (encoded[0] !== -1) invalidBinary(`Invalid compact font weight tag at ${path}[0].`);
  return { fontWeight: indexedString(strings, encoded[1], `${path}[1]`) };
}

function decodeTextDocument(value: unknown, strings: readonly string[], path: string): Record<string, unknown> {
  const document = compactArray(value, path, 11);
  return {
    time: document[0], text: indexedString(strings, document[1], `${path}[1]`),
    ...decodeOptionalStringField(document[2], 'fontFamily', strings, `${path}[2]`),
    ...(document[3] === 0 ? {} : { fontSize: document[3] }),
    ...decodeFontWeightField(document[4], strings, `${path}[4]`),
    ...(document[5] === -1 ? {} : { fontStyle: indexedLiteral(['normal', 'italic'] as const, document[5], `${path}[5]`) }),
    ...decodeOptionalStringField(document[6], 'fontResource', strings, `${path}[6]`),
    ...(document[7] === 0 ? {} : { lineHeight: document[7] }),
    ...(document[8] === null ? {} : { tracking: document[8] }),
    ...(document[9] === -1 ? {} : { textAlign: indexedLiteral(['left', 'center', 'right'] as const, document[9], `${path}[9]`) }),
    ...(document[10] === 0 ? {} : { color: document[10] }),
  };
}

function decodeTextAnimator(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown> {
  const animator = compactArray(value, path, 13);
  const selector = compactArray(animator[0], `${path}[0]`, 10);
  return {
    selector: {
      start: selector[0], end: selector[1], offset: selector[2],
      units: indexedLiteral(['percent', 'index'] as const, selector[3], `${path}[0][3]`),
      amount: selector[4],
      shape: indexedLiteral(TEXT_SELECTOR_SHAPES, selector[5], `${path}[0][5]`),
      ...decodeVectorTrackField(selector, 6, 'startTrack', floatPool, `${path}[0]`),
      ...decodeVectorTrackField(selector, 7, 'endTrack', floatPool, `${path}[0]`),
      ...decodeVectorTrackField(selector, 8, 'offsetTrack', floatPool, `${path}[0]`),
      ...decodeVectorTrackField(selector, 9, 'amountTrack', floatPool, `${path}[0]`),
      basedOn: selector.length < 11 || selector[10] === -1
        ? undefined
        : indexedLiteral(TEXT_SELECTOR_BASES, selector[10], `${path}[0][10]`),
      easing: selector[11] === 0 ? undefined : selector[11],
      smoothness: selector[12] === -1 ? undefined : selector[12],
      randomSeed: selector[13] === null ? undefined : selector[13],
    },
    ...(animator[1] === 0 ? {} : { position: animator[1] }),
    ...(animator[2] === 0 ? {} : { scale: animator[2] }),
    ...(animator[3] === null ? {} : { rotation: animator[3] }),
    ...(animator[4] === -1 ? {} : { opacity: animator[4] }),
    ...(animator[5] === 0 ? {} : { fillColor: animator[5] }),
    ...(animator[6] === null ? {} : { tracking: animator[6] }),
    ...decodeVectorTrackField(animator, 7, 'positionTrack', floatPool, path),
    ...decodeVectorTrackField(animator, 8, 'scaleTrack', floatPool, path),
    ...decodeVectorTrackField(animator, 9, 'rotationTrack', floatPool, path),
    ...decodeVectorTrackField(animator, 10, 'opacityTrack', floatPool, path),
    ...decodeVectorTrackField(animator, 11, 'fillColorTrack', floatPool, path),
    ...decodeVectorTrackField(animator, 12, 'trackingTrack', floatPool, path),
  };
}

function decodeLayerEffects(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown>[] {
  return compactArray(value, path).map((value, index) => {
    const effectPath = `${path}[${index}]`;
    const effect = compactArray(value, effectPath, 2);
    const kind = indexedLiteral(['tint', 'fill', 'opacity', 'color-matrix', 'blur', 'drop-shadow'] as const, effect[0], `${effectPath}[0]`);
    if (kind === 'tint') {
      if (effect.length < 7) invalidBinary(`Compact tint effect is truncated at ${effectPath}.`);
      return {
        kind, black: effect[1], white: effect[2], amount: effect[3],
        ...decodeVectorTrackField(effect, 4, 'blackTrack', floatPool, effectPath),
        ...decodeVectorTrackField(effect, 5, 'whiteTrack', floatPool, effectPath),
        ...decodeVectorTrackField(effect, 6, 'amountTrack', floatPool, effectPath),
      };
    }
    if (kind === 'fill') {
      if (effect.length < 5) invalidBinary(`Compact fill effect is truncated at ${effectPath}.`);
      return {
        kind, color: effect[1], opacity: effect[2],
        ...decodeVectorTrackField(effect, 3, 'colorTrack', floatPool, effectPath),
        ...decodeVectorTrackField(effect, 4, 'opacityTrack', floatPool, effectPath),
      };
    }
    if (kind === 'opacity') return {
      kind, opacity: effect[1], ...decodeVectorTrackField(effect, 2, 'opacityTrack', floatPool, effectPath),
    };
    if (kind === 'color-matrix') return {
      kind,
      matrix: compactFloatView(floatPool, effect[1], `${effectPath}[1]`),
      ...decodeVectorTrackField(effect, 2, 'matrixTrack', floatPool, effectPath),
    };
    if (kind === 'blur') return {
      kind, radius: effect[1], ...decodeVectorTrackField(effect, 2, 'radiusTrack', floatPool, effectPath),
    };
    if (effect.length < 9) invalidBinary(`Compact drop-shadow effect is truncated at ${effectPath}.`);
    return {
      kind, color: effect[1], opacity: effect[2], offset: effect[3], blur: effect[4],
      ...decodeVectorTrackField(effect, 5, 'colorTrack', floatPool, effectPath),
      ...decodeVectorTrackField(effect, 6, 'opacityTrack', floatPool, effectPath),
      ...decodeVectorTrackField(effect, 7, 'offsetTrack', floatPool, effectPath),
      ...decodeVectorTrackField(effect, 8, 'blurTrack', floatPool, effectPath),
    };
  });
}

function decodeVectorModifier(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown> {
  const modifier = compactArray(value, path, 3);
  const kind = indexedLiteral(['trim-path', 'round-corners'] as const, modifier[0], `${path}[0]`);
  if (kind === 'round-corners') return {
    kind,
    radius: modifier[1],
    ...decodeVectorTrackField(modifier, 2, 'radiusTrack', floatPool, path),
  };
  if (modifier.length < 8) invalidBinary(`Truncated trim-path at ${path}.`);
  return {
    kind,
    start: modifier[1], end: modifier[2], offset: modifier[3],
    mode: indexedLiteral(['simultaneous', 'individual'] as const, modifier[4], `${path}[4]`),
    ...decodeVectorTrackField(modifier, 5, 'startTrack', floatPool, path),
    ...decodeVectorTrackField(modifier, 6, 'endTrack', floatPool, path),
    ...decodeVectorTrackField(modifier, 7, 'offsetTrack', floatPool, path),
  };
}

function decodeVectorTrackField(
  owner: unknown[],
  index: number,
  key: string,
  floatPool: Float32Array,
  path: string,
): Record<string, unknown> {
  return owner[index] === 0 ? {} : { [key]: decodeVectorTrack(owner[index], floatPool, `${path}[${index}]`) };
}

function decodeVectorTrack(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown> {
  const track = compactArray(value, path, 5);
  return {
    times: compactFloatView(floatPool, track[0], `${path}[0]`),
    values: compactFloatView(floatPool, track[1], `${path}[1]`),
    valueSize: track[2],
    interpolation: indexedLiteral(INTERPOLATIONS, track[3], `${path}[3]`),
    ...(track[4] === 0 ? {} : { easings: compactFloatView(floatPool, track[4], `${path}[4]`) }),
  };
}

function decodeVectorFill(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown> {
  const fill = compactArray(value, path, 4);
  const kind = indexedLiteral(['solid', 'linear-gradient', 'radial-gradient'] as const, fill[0], `${path}[0]`);
  if (kind === 'solid') return {
    kind,
    color: fill[1],
    ...decodeVectorTrackField(fill, 2, 'colorTrack', floatPool, path),
    ...decodeVectorTrackField(fill, 3, 'opacityTrack', floatPool, path),
    ...(fill.length < 5 || fill[4] === 1 ? {} : { opacity: fill[4] }),
  };
  if (fill.length < 8) invalidBinary(`Compact vector gradient is truncated at ${path}.`);
  return {
    kind,
    start: fill[1],
    end: fill[2],
    stops: compactFloatView(floatPool, fill[3], `${path}[3]`),
    ...decodeVectorTrackField(fill, 4, 'startTrack', floatPool, path),
    ...decodeVectorTrackField(fill, 5, 'endTrack', floatPool, path),
    ...decodeVectorTrackField(fill, 6, 'stopsTrack', floatPool, path),
    ...decodeVectorTrackField(fill, 7, 'opacityTrack', floatPool, path),
    ...(fill.length < 9 || fill[8] === 1 ? {} : { opacity: fill[8] }),
  };
}

function decodeVectorStroke(value: unknown, floatPool: Float32Array, path: string): Record<string, unknown> {
  const stroke = compactArray(value, path, 11);
  return {
    color: stroke[0],
    width: stroke[1],
    lineCap: indexedLiteral(['butt', 'round', 'square'] as const, stroke[2], `${path}[2]`),
    lineJoin: indexedLiteral(['miter', 'round', 'bevel'] as const, stroke[3], `${path}[3]`),
    miterLimit: stroke[4],
    ...(stroke[5] === 0 ? {} : { dash: compactFloatView(floatPool, stroke[5], `${path}[5]`) }),
    ...(stroke[6] === 0 ? {} : { dashOffset: stroke[6] }),
    ...decodeVectorTrackField(stroke, 7, 'colorTrack', floatPool, path),
    ...decodeVectorTrackField(stroke, 8, 'opacityTrack', floatPool, path),
    ...decodeVectorTrackField(stroke, 9, 'widthTrack', floatPool, path),
    ...decodeVectorTrackField(stroke, 10, 'dashOffsetTrack', floatPool, path),
    ...(stroke.length < 12 || stroke[11] === 0 ? {} : { gradient: decodeVectorFill(stroke[11], floatPool, `${path}[11]`) }),
    ...(stroke.length < 13 || stroke[12] === 1 ? {} : { opacity: stroke[12] }),
  };
}

function decodeComposite(
  value: unknown,
  nodeIds: readonly string[],
  floatPool: Float32Array,
  path: string,
): NonNullable<AnimationNode['composite']> {
  const composite = compactArray(value, path);
  if (typeof composite[0] === 'number') return decodeCompositeLayer(composite, nodeIds, floatPool, path);
  if (composite.length < 1 || composite.length > 8) invalidBinary(`Composite stack must contain between 1 and 8 layers at ${path}.`);
  return Object.freeze({
    layers: Object.freeze(composite.map((layer, index) => decodeCompositeLayer(
      compactArray(layer, `${path}[${index}]`, 3), nodeIds, floatPool, `${path}[${index}]`,
    ))),
  });
}

function decodeCompositeLayer(
  composite: unknown[],
  nodeIds: readonly string[],
  floatPool: Float32Array,
  path: string,
): Readonly<AnimationCompositeLayer> {
  const source = boundedIndex(composite[1], nodeIds.length, `${path}[1]`);
  return Object.freeze({
    kind: indexedLiteral(COMPOSITE_KINDS, composite[0], `${path}[0]`),
    source: nodeIds[source]!,
    mode: indexedLiteral(COMPOSITE_MODES, composite[2], `${path}[2]`),
    ...(composite.length < 4 ? {} : { operation: indexedLiteral(COMPOSITE_OPERATIONS, composite[3], `${path}[3]`) }),
    ...(composite.length < 5 || composite[4] === 0 ? {} : {
      feather: nonNegativeFiniteTuple(composite[4], 2, `${path}[4]`) as unknown as readonly [number, number],
    }),
    ...(composite.length < 6 || composite[5] === 0 ? {} : { expansion: finiteNumber(composite[5], `${path}[5]`) }),
    ...(composite.length < 7 ? {} : decodeVectorTrackField(composite, 6, 'expansionTrack', floatPool, path)),
  });
}

function decodeLegacyMetadata(
  metadata: unknown,
  floatPool: Float32Array,
  buffer: ArrayBuffer,
  options: AnimationParseOptions,
): ParsedAnimation {
  const root = binaryRecord(metadata, '$binary.metadata');
  const tracks = binaryArray(root.tracks, '$binary.metadata.tracks');
  const nodes = binaryArray(root.nodes, '$binary.metadata.nodes').map((value, nodeIndex) => {
    const node = binaryRecord(value, `$.nodes[${nodeIndex}]`);
    if (node.components === undefined) return node;
    const components = binaryArray(node.components, `$.nodes[${nodeIndex}].components`).map((componentValue, componentIndex) => {
      const component = binaryRecord(componentValue, `$.nodes[${nodeIndex}].components[${componentIndex}]`);
      if (component.type !== 'path2d') return component;
      return {
        ...component,
        values: legacyFloatView(floatPool, component.values, `$.nodes[${nodeIndex}].components[${componentIndex}].values`),
      };
    });
    return { ...node, components };
  });
  const hydratedTracks = tracks.map((value, index) => {
    const track = binaryRecord(value, `$.tracks[${index}]`) as unknown as LegacyBinaryTrackMetadata;
    return {
      node: track.node,
      property: track.property,
      interpolation: track.interpolation,
      times: legacyFloatView(floatPool, track.times, `$.tracks[${index}].times`),
      values: legacyFloatView(floatPool, track.values, `$.tracks[${index}].values`),
      ...(track.easings === undefined ? {} : { easings: legacyFloatView(floatPool, track.easings, `$.tracks[${index}].easings`) }),
    };
  });
  return parseAnimationValue({ ...root, nodes, tracks: hydratedTracks }, options, 'binary', buffer);
}

function compactFloatView(pool: Float32Array, value: unknown, path: string): Float32Array {
  const descriptor = compactArray(value, path, 2);
  const offset = safeUint(descriptor[0], `${path}[0]`);
  const length = safeUint(descriptor[1], `${path}[1]`);
  if (offset + length > pool.length) invalidBinary(`Float range is outside the pool at ${path}.`);
  return pool.subarray(offset, offset + length);
}

function legacyFloatView(pool: Float32Array, value: unknown, path: string): Float32Array {
  const descriptor = binaryRecord(value, path);
  const offset = safeUint(descriptor.offset, `${path}.offset`);
  const length = safeUint(descriptor.length, `${path}.length`);
  if (offset + length > pool.length) invalidBinary(`Float range is outside the pool at ${path}.`);
  return pool.subarray(offset, offset + length);
}

function floatBlockKey(values: Float32Array): string {
  let result = `${values.length}:`;
  for (let index = 0; index < values.length; index++) result += `${values[index]},`;
  return result;
}

function decodeStringIndices(value: unknown, strings: readonly string[], path: string): string[] {
  const seen = new Set<string>();
  return compactArray(value, path).map((item, index) => {
    const result = indexedString(strings, item, `${path}[${index}]`);
    if (!result.trim()) invalidBinary(`Expected a non-empty string at ${path}[${index}].`);
    if (seen.has(result)) invalidBinary(`Duplicate string-table value at ${path}[${index}].`);
    seen.add(result);
    return result;
  });
}

function optionalIndexedString(strings: readonly string[], value: unknown, path: string): string | undefined {
  const index = finiteInteger(value, path);
  return index === -1 ? undefined : indexedString(strings, index, path);
}

function indexedString(strings: readonly string[], value: unknown, path: string): string {
  const index = boundedIndex(value, strings.length, path);
  return strings[index]!;
}

function indexedLiteral<const T extends readonly string[]>(values: T, value: unknown, path: string): T[number] {
  const index = boundedIndex(value, values.length, path);
  return values[index]!;
}

function optionalBoundedIndex(value: unknown, length: number, path: string): number | undefined {
  const index = finiteInteger(value, path);
  return index === -1 ? undefined : boundedIndex(index, length, path);
}

function boundedIndex(value: unknown, length: number, path: string): number {
  const index = finiteInteger(value, path);
  if (index < 0 || index >= length) invalidBinary(`Index is outside its table at ${path}.`);
  return index;
}

function requiredMapIndex(map: ReadonlyMap<string, number>, key: string, label: string): number {
  const value = map.get(key);
  if (value === undefined) invalidBinary(`Missing ${label} "${key}" while encoding.`);
  return value;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function isParsedAnimation(value: AnimationDocument | ParsedAnimation): value is ParsedAnimation {
  return 'source' in value && Array.isArray(value.tracks) && value.tracks.every(track => track.times instanceof Float32Array);
}

function isPath2DComponent(component: AnimationComponent): component is AnimationPath2DComponent {
  return component.type === 'path2d' && typeof (component as Partial<AnimationPath2DComponent>).commands === 'string';
}

interface CompactVectorStrokeComponent {
  readonly [key: string]: unknown;
  readonly type: typeof VECTOR_STROKE_EXTENSION;
  readonly commands?: string;
  readonly values?: readonly number[] | Float32Array;
  readonly sourceComponent?: number;
  readonly color: readonly [number, number, number, number];
  readonly width: number;
  readonly lineCap: 'butt' | 'round' | 'square';
  readonly lineJoin: 'miter' | 'round' | 'bevel';
  readonly miterLimit: number;
  readonly tolerance?: number;
}

interface CompactVectorPathMorphComponent {
  readonly [key: string]: unknown;
  readonly type: typeof VECTOR_PATH_MORPH_EXTENSION;
  readonly commands: string;
  readonly times: readonly number[] | Float32Array;
  readonly values: readonly number[] | Float32Array;
  readonly valueSize: number;
  readonly interpolation: typeof INTERPOLATIONS[number];
  readonly easings?: readonly number[] | Float32Array;
  readonly fill: readonly [number, number, number, number];
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly tolerance?: number;
}

function isCompactVectorStrokeComponent(component: AnimationComponent): component is CompactVectorStrokeComponent {
  if (component.type !== VECTOR_STROKE_EXTENSION || !Object.keys(component).every(key => VECTOR_STROKE_KEYS.has(key))) return false;
  const candidate = component as Partial<CompactVectorStrokeComponent>;
  const inlinePath = typeof candidate.commands === 'string'
    && (Array.isArray(candidate.values) || candidate.values instanceof Float32Array)
    && Array.from(candidate.values).every(Number.isFinite);
  const sourcePath = Number.isSafeInteger(candidate.sourceComponent) && candidate.sourceComponent! >= 0;
  return (inlinePath || sourcePath)
    && Array.isArray(candidate.color)
    && candidate.color.length === 4
    && candidate.color.every(value => Number.isFinite(value))
    && typeof candidate.width === 'number' && Number.isFinite(candidate.width)
    && (candidate.lineCap === 'butt' || candidate.lineCap === 'round' || candidate.lineCap === 'square')
    && (candidate.lineJoin === 'miter' || candidate.lineJoin === 'round' || candidate.lineJoin === 'bevel')
    && typeof candidate.miterLimit === 'number' && Number.isFinite(candidate.miterLimit)
    && (candidate.tolerance === undefined || (typeof candidate.tolerance === 'number' && Number.isFinite(candidate.tolerance)));
}

function isCompactVectorPathMorphComponent(component: AnimationComponent): component is CompactVectorPathMorphComponent {
  if (component.type !== VECTOR_PATH_MORPH_EXTENSION || !Object.keys(component).every(key => VECTOR_PATH_MORPH_KEYS.has(key))) return false;
  const candidate = component as Partial<CompactVectorPathMorphComponent>;
  const times = candidate.times;
  const values = candidate.values;
  const easings = candidate.easings;
  return typeof candidate.commands === 'string'
    && (Array.isArray(times) || times instanceof Float32Array)
    && Array.from(times).every(Number.isFinite)
    && (Array.isArray(values) || values instanceof Float32Array)
    && Array.from(values).every(Number.isFinite)
    && Number.isSafeInteger(candidate.valueSize) && candidate.valueSize! > 0
    && values.length === times.length * candidate.valueSize!
    && INTERPOLATIONS.includes(candidate.interpolation as typeof INTERPOLATIONS[number])
    && (easings === undefined || Array.isArray(easings) || easings instanceof Float32Array)
    && Array.isArray(candidate.fill) && candidate.fill.length === 4
    && (candidate.fillRule === 'nonzero' || candidate.fillRule === 'evenodd')
    && (candidate.tolerance === undefined || (typeof candidate.tolerance === 'number' && Number.isFinite(candidate.tolerance)));
}

function safeUint(value: unknown, path: string): number {
  const result = finiteInteger(value, path);
  if (result < 0 || result > 0xffffffff) invalidBinary(`Expected an unsigned integer at ${path}.`);
  return result;
}

function finiteInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidBinary(`Expected an integer at ${path}.`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidBinary(`Expected a finite number at ${path}.`);
  return value;
}

function positiveFiniteNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result <= 0) invalidBinary(`Expected a positive number at ${path}.`);
  return result;
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) invalidBinary(`Expected a non-negative number at ${path}.`);
  return result;
}

function finiteTuple(value: unknown, length: number, path: string): number[] {
  const tuple = compactArray(value, path, length);
  if (tuple.length !== length) invalidBinary(`Expected exactly ${length} entries at ${path}.`);
  return tuple.map((item, index) => finiteNumber(item, `${path}[${index}]`));
}

function positiveFiniteTuple(value: unknown, length: number, path: string): readonly number[] {
  const tuple = finiteTuple(value, length, path);
  for (let index = 0; index < tuple.length; index++) {
    if (tuple[index]! <= 0) invalidBinary(`Expected positive tuple values at ${path}[${index}].`);
  }
  return Object.freeze(tuple);
}

function nonNegativeFiniteTuple(value: unknown, length: number, path: string): readonly number[] {
  const tuple = finiteTuple(value, length, path);
  for (let index = 0; index < tuple.length; index++) {
    if (tuple[index]! < 0) invalidBinary(`Expected non-negative tuple values at ${path}[${index}].`);
  }
  return Object.freeze(tuple);
}

function unitFiniteTuple(value: unknown, length: number, path: string): readonly number[] {
  const tuple = finiteTuple(value, length, path);
  for (let index = 0; index < tuple.length; index++) {
    if (tuple[index]! < 0 || tuple[index]! > 1) invalidBinary(`Expected tuple values in [0, 1] at ${path}[${index}].`);
  }
  return Object.freeze(tuple);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string') invalidBinary(`Expected a string at ${path}.`);
  return value;
}

function requiredNonEmptyString(value: string, path: string): string {
  if (!value.trim()) invalidBinary(`Expected a non-empty string at ${path}.`);
  return value;
}

function compactArray(value: unknown, path: string, minimumLength = 0): unknown[] {
  const result = binaryArray(value, path);
  if (result.length < minimumLength) invalidBinary(`Expected at least ${minimumLength} entries at ${path}.`);
  return result;
}

function binaryRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidBinary(`Expected an object at ${path}.`);
  return value as Record<string, unknown>;
}

function binaryArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalidBinary(`Expected an array at ${path}.`);
  return value;
}

function binaryLimit(actual: number, maximum: number, label: string, path: string): void {
  if (actual > maximum) {
    throw new AnimationFormatError('E_ANIMATION_LIMIT_EXCEEDED', `${label} count ${actual} exceeds limit ${maximum}.`, path);
  }
}

function invalidBinary(message: string): never {
  throw new AnimationFormatError('E_ANIMATION_INVALID_BINARY', message, '$binary');
}
