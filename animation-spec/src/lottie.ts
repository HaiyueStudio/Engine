import {
  ANIMATION_FORMAT,
  ANIMATION_VERSION,
  type AnimationComponent,
  type AnimationCompositeLayer,
  type AnimationDocument,
  type AnimationLayerEffect,
  type AnimationNode,
  type AnimationPath2DComponent,
  type AnimationResource,
  type AnimationTrack,
  type AnimationTrackProperty,
  type AnimationText2DComponent,
  type AnimationTextAnimator,
  type AnimationTextDocumentKeyframe,
  ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
  type AnimationVectorGradientPaint,
  type AnimationVectorPathModifier,
  type AnimationVectorShapeComponent,
  type AnimationVectorSolidPaint,
  type AnimationVectorStrokePaint,
  type AnimationVectorValueTrack,
} from './types';
import {
  identityMatrix,
  mergeStaticVectorPaths,
  transformMatrix,
  transformStaticPath,
  translationMatrix,
} from './lottie-merge-path';

export interface LottieConversionDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface LottieFontMetrics {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap?: number;
  readonly capHeight?: number;
  readonly xHeight?: number;
}

export interface LottieWebFontMapping {
  readonly uri: string;
  readonly family?: string;
  readonly style?: 'normal' | 'italic';
  readonly weight?: string | number;
  readonly mimeType?: string;
  /** Stable content hash used by loaders and import tooling. */
  readonly integrity?: string;
  /** Optional measured font metrics recorded by the importer for fidelity review. */
  readonly metrics?: LottieFontMetrics;
}

export interface LottieFontRequirement {
  readonly name: string;
  readonly authoredFamily: string;
  readonly authoredStyle: string;
  readonly authoredAscent?: number;
  readonly usageCount: number;
  readonly mapped: boolean;
  readonly resolvedFamily: string;
  readonly resolvedStyle: 'normal' | 'italic';
  readonly resolvedWeight: string | number;
  readonly uri?: string;
  readonly mimeType?: string;
  readonly integrity?: string;
  readonly metrics?: LottieFontMetrics;
}

export interface LottieConversionOptions {
  name?: string;
  imageBaseUrl?: string;
  /** Optional build-time mapping from Lottie fName to a loadable web-font resource. */
  fonts?: Readonly<Record<string, string | Readonly<LottieWebFontMapping>>>;
  /** Converts warnings to errors and throws after conversion. */
  strict?: boolean;
}

export interface LottieConversionResult {
  readonly document: AnimationDocument;
  readonly diagnostics: readonly LottieConversionDiagnostic[];
  readonly convertedLayerCount: number;
  readonly skippedLayerCount: number;
  /** Import-time font inventory; unresolved entries retain actionable diagnostics. */
  readonly fonts: readonly LottieFontRequirement[];
}

interface ConversionState {
  readonly frameRate: number;
  readonly duration: number;
  readonly diagnostics: LottieConversionDiagnostic[];
  readonly tracks: AnimationTrack[];
  timeline: LottieTimeline;
  shapeCounter: number;
  convertedLayerCount: number;
  skippedLayerCount: number;
  usesStrokeExtension: boolean;
  usesPathMorphExtension: boolean;
  usesVectorShapeExtension: boolean;
  usesDataLayerExtension: boolean;
  readonly fonts: ReadonlyMap<string, LottieFontDescriptor>;
  readonly warnedFontSubstitutions: Set<string>;
}

interface LottieTimeline {
  /** Frame rate of the composition whose properties are currently converted. */
  readonly frameRate: number;
  /** Root-animation seconds represented by local frame zero. */
  readonly secondsOffset: number;
  /** Root-animation seconds advanced by one local composition frame. */
  readonly secondsPerFrame: number;
  /** Optional inverse time-remap baked by the converter; runtime tracks stay ordinary HYA tracks. */
  readonly mapFrameToSeconds?: (frame: number) => number;
}

type LottieInlineTrack = AnimationVectorValueTrack & {
  readonly spatialTangents?: readonly number[];
};

interface LottieAssetEntry {
  readonly value: Record<string, unknown>;
  readonly index: number;
}

interface LottieFontDescriptor {
  readonly name: string;
  readonly family: string;
  readonly style: 'normal' | 'italic';
  readonly weight: string | number;
  readonly resourceId?: string;
}

interface LottieLayerListContext {
  readonly listPath: string;
  readonly idPrefix: string;
  readonly fallbackParent?: string;
  readonly timeline: LottieTimeline;
  readonly compositionWidth: number;
  readonly compositionHeight: number;
  readonly precompStack: readonly string[];
}

const VECTOR_STROKE_EXTENSION = 'org.haiyue.vector-stroke@1';
const VECTOR_PATH_MORPH_EXTENSION = 'org.haiyue.vector-path-morph@1';
const DATA_LAYER_EXTENSION = 'org.haiyue.data-layer@1';
// Animated paths dominate compressed delivery because arbitrary Float32 mantissas
// defeat gzip even when neighbouring keyframes are visually almost identical.
// A 1/64 canvas-unit grid bounds source error to 1/128 px while making the pool
// substantially more compressible. Static paths keep their authored precision.
const ANIMATED_PATH_QUANTIZATION = 1 / 64;

interface LottieStrokeStyle {
  readonly color: readonly [number, number, number, number];
  readonly width: number;
  readonly opacity: number;
  readonly lineCap: 1 | 2 | 3;
  readonly lineJoin: 1 | 2 | 3;
  readonly miterLimit: number;
  readonly colorTrack?: AnimationVectorValueTrack;
  readonly opacityTrack?: AnimationVectorValueTrack;
  readonly widthTrack?: AnimationVectorValueTrack;
  readonly dash?: readonly number[];
  readonly dashOffset?: number;
  readonly dashOffsetTrack?: AnimationVectorValueTrack;
  readonly gradient?: AnimationVectorGradientPaint;
}

type LottieFillStyle = AnimationVectorSolidPaint | AnimationVectorGradientPaint;
type LottiePaint = Readonly<{ kind: 'fill'; fill: LottieFillStyle; fillRule: 'nonzero' | 'evenodd' }>
  | Readonly<{ kind: 'stroke'; stroke: LottieStrokeStyle }>;

interface LottieTintEffect {
  readonly black: readonly [number, number, number];
  readonly white: readonly [number, number, number];
  readonly amount: number;
}

interface LottieAnimatedPathData {
  readonly commands: string;
  readonly times: number[];
  readonly values: number[];
  readonly valueSize: number;
  readonly interpolation: 'step' | 'linear' | 'cubic-bezier';
  readonly easings?: number[];
  readonly tolerance: number;
}

type LottiePoint = readonly [number, number];

interface LottieCubicSegment {
  readonly start: LottiePoint;
  readonly control1: LottiePoint;
  readonly control2: LottiePoint;
  readonly end: LottiePoint;
}

interface LottieCubicContour {
  readonly closed: boolean;
  readonly segments: readonly LottieCubicSegment[];
}

const MAX_ANIMATED_PATH_SEGMENTS = 256;

/** Converts the runtime-relevant Lottie subset without importing a Lottie player. */
export function convertLottie(
  source: string | Readonly<Record<string, unknown>>,
  options: LottieConversionOptions = {},
): LottieConversionResult {
  const root = typeof source === 'string' ? parseLottieJson(source) : source;
  const frameRate = positive(root.fr, '$.fr');
  const inFrame = finite(root.ip ?? 0, '$.ip');
  const outFrame = finite(root.op, '$.op');
  if (outFrame <= inFrame) throw new TypeError('Lottie op must be greater than ip.');
  const width = positive(root.w, '$.w');
  const height = positive(root.h, '$.h');
  const duration = (outFrame - inFrame) / frameRate;
  const rootTimeline: LottieTimeline = {
    frameRate,
    secondsOffset: -inFrame / frameRate,
    secondsPerFrame: 1 / frameRate,
  };
  const fontInventory = inspectLottieFonts(root, options.fonts);
  const fontConversion = convertFonts(root.fonts, options);
  const state: ConversionState = {
    frameRate,
    duration,
    diagnostics: [],
    tracks: [],
    timeline: rootTimeline,
    shapeCounter: 0,
    convertedLayerCount: 0,
    skippedLayerCount: 0,
    usesStrokeExtension: false,
    usesPathMorphExtension: false,
    usesVectorShapeExtension: false,
    usesDataLayerExtension: false,
    fonts: fontConversion.fonts,
    warnedFontSubstitutions: new Set(),
  };
  const layerValues = list(root.layers);
  const assetValues = list(root.assets);
  const assetsById = new Map<string, LottieAssetEntry>();
  for (let index = 0; index < assetValues.length; index++) {
    const value = object(assetValues[index]);
    if (typeof value.id === 'string') assetsById.set(value.id, { value, index });
  }
  const audioResourceIds = collectReferencedAssetIds(
    [layerValues, ...assetValues.map(asset => list(object(asset).layers))],
    6,
  );
  const dataResourceIds = collectReferencedAssetIds(
    [layerValues, ...assetValues.map(asset => list(object(asset).layers))],
    15,
  );
  const resources = [...convertAssets(root.assets, options, audioResourceIds, dataResourceIds), ...fontConversion.resources];

  const nodes: AnimationNode[] = [];
  convertLayerList(layerValues, {
    listPath: '$.layers',
    idPrefix: '',
    timeline: rootTimeline,
    compositionWidth: width,
    compositionHeight: height,
    precompStack: [],
  });

  const document: AnimationDocument = {
    format: ANIMATION_FORMAT,
    version: ANIMATION_VERSION,
    name: options.name ?? (typeof root.nm === 'string' ? root.nm : 'Converted Lottie'),
    canvas: { width, height, coordinateSystem: 'screen-y-down' },
    duration,
    frameRate,
    endBehavior: 'loop',
    resources,
    nodes,
    tracks: state.tracks,
    ...((state.usesStrokeExtension || state.usesPathMorphExtension || state.usesVectorShapeExtension || state.usesDataLayerExtension) ? {
      extensionsUsed: [
        ...(state.usesStrokeExtension ? [VECTOR_STROKE_EXTENSION] : []),
        ...(state.usesPathMorphExtension ? [VECTOR_PATH_MORPH_EXTENSION] : []),
        ...(state.usesVectorShapeExtension ? [ANIMATION_VECTOR_SHAPE_EXTENSION_ID] : []),
        ...(state.usesDataLayerExtension ? [DATA_LAYER_EXTENSION] : []),
      ],
    } : {}),
  };
  if (options.strict && state.diagnostics.length > 0) {
    const first = state.diagnostics[0]!;
    throw new TypeError(`Lottie conversion failed: ${first.message} (${first.path})`);
  }
  return Object.freeze({
    document,
    diagnostics: Object.freeze(state.diagnostics),
    convertedLayerCount: state.convertedLayerCount,
    skippedLayerCount: state.skippedLayerCount,
    fonts: fontInventory,
  });

  function convertLayerList(layerList: unknown[], context: LottieLayerListContext): void {
    const previousTimeline = state.timeline;
    state.timeline = context.timeline;
    try {
      const retainedLayerIndices = collectRetainedLayerIndices(layerList, context.listPath);
      const layerIds = new Map<number, string>();
      for (let index = 0; index < layerList.length; index++) {
        const layer = object(layerList[index]);
        const layerIndex = integer(layer.ind ?? index + 1, `${context.listPath}[${index}].ind`);
        if (!retainedLayerIndices.has(layerIndex)) continue;
        layerIds.set(layerIndex, `${context.idPrefix}layer:${layerIndex}`);
      }

      for (let sourceIndex = layerList.length - 1; sourceIndex >= 0; sourceIndex--) {
        const layer = object(layerList[sourceIndex]);
        const path = `${context.listPath}[${sourceIndex}]`;
        const layerIndex = integer(layer.ind ?? sourceIndex + 1, `${path}.ind`);
        if (!retainedLayerIndices.has(layerIndex)) continue;
        const id = layerIds.get(layerIndex)!;
        const type = integer(layer.ty, `${path}.ty`);
        const transformOnly = layer.hd === true;
        const parentIndex = layer.parent === undefined ? undefined : integer(layer.parent, `${path}.parent`);
        const localParent = parentIndex === undefined ? undefined : layerIds.get(parentIndex);
        if (parentIndex !== undefined && !localParent) {
          warn(state, 'W_LOTTIE_MISSING_PARENT', `${path}.parent`, `Parent layer ${parentIndex} was not found.`);
        }
        const parent = localParent ?? context.fallbackParent;
        const layerTimeline = type === 0
          ? context.timeline
          : createOrdinaryLayerTimeline(layer, path, context.timeline, state);
        state.timeline = layerTimeline;
        try {
        const effects = transformOnly ? [] : convertLayerEffects(layer.ef, path, state);
        const tint = null;
        if (!transformOnly) diagnoseUnsupportedLayerFeatures(layer, path, type, state);
        const transform = convertTransform(layer.ks, path, id, state);
        const startFrame = finite(layer.ip ?? 0, `${path}.ip`);
        const endFrame = finite(layer.op ?? startFrame + context.timeline.frameRate * state.duration, `${path}.op`);
        const timing = convertNodeTiming(startFrame, endFrame, context.timeline, state.duration);
        const composite = transformOnly
          ? { nodes: [] }
          : convertLayerComposite(
            layer,
            sourceIndex,
            layerList,
            layerIds,
            id,
            path,
            context.listPath,
            state,
            context.compositionWidth,
            context.compositionHeight,
          );
        const baseNode: AnimationNode = {
          id,
          name: typeof layer.nm === 'string' ? layer.nm : id,
          start: timing.start,
          duration: timing.duration,
          transform,
          ...(parent ? { parent } : {}),
          ...(composite.value ? { composite: composite.value } : {}),
          ...(effects.length > 0 ? { effects } : {}),
        };

        // Bodymovin may hide a null/shape layer while still using it as a
        // transform parent. Preserve that hierarchy node, but never convert
        // the hidden layer's visual content, effects or composites.
        if (transformOnly) {
          nodes.push(baseNode);
          state.convertedLayerCount++;
          continue;
        }

        if (type === 0) {
          nodes.push(baseNode);
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          expandPrecomp(layer, id, path, context);
          continue;
        }
        if (type === 1) {
          const solidWidth = positive(layer.sw, `${path}.sw`);
          const solidHeight = positive(layer.sh, `${path}.sh`);
          nodes.push({
            ...baseNode,
            components: [{
              type: 'shape2d', shape: 'rect', size: [solidWidth, solidHeight],
              position: [solidWidth / 2, solidHeight / 2], fill: applyTint(parseHexColor(layer.sc, `${path}.sc`), tint),
            }],
          });
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          continue;
        }
        if (type === 2) {
          const refId = typeof layer.refId === 'string' ? layer.refId : '';
          const resource = resources.find(candidate => candidate.id === refId);
          if (!resource || resource.type !== 'image') {
            warn(state, 'W_LOTTIE_MISSING_IMAGE', `${path}.refId`, `Image asset "${refId}" was not found.`);
            nodes.push(baseNode);
          } else {
            const size: [number, number] = [
              resource.width ?? context.compositionWidth,
              resource.height ?? context.compositionHeight,
            ];
            nodes.push({ ...baseNode, components: [{ type: 'sprite2d', resource: refId, size, position: [size[0] / 2, size[1] / 2] }] });
          }
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          continue;
        }
        if (type === 3) {
          nodes.push(baseNode);
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          continue;
        }
        if (type === 4) {
          nodes.push(baseNode);
          const shapes = convertShapes(layer.shapes, id, path, state, tint);
          nodes.push(...shapes);
          nodes.push(...composite.nodes);
          if (!shapes.some(node => (node.components?.length ?? 0) > 0)
            && !hasOnlyIntentionallyInvisiblePaints(layer.shapes)
            && !hasOnlyIntentionallyEmptyPaths(layer.shapes)) {
            warn(state, 'W_LOTTIE_EMPTY_SHAPE', `${path}.shapes`, 'No supported filled vector shape was found.');
          }
          state.convertedLayerCount++;
          continue;
        }
        if (type === 5) {
          const text = convertText(layer.t, path, context.compositionWidth, state, tint);
          nodes.push(text ? { ...baseNode, components: [text] } : baseNode);
          nodes.push(...composite.nodes);
          if (!text) state.skippedLayerCount++;
          else state.convertedLayerCount++;
          continue;
        }
        if (type === 6) {
          const refId = typeof layer.refId === 'string' ? layer.refId : '';
          const resource = resources.find(candidate => candidate.id === refId);
          if (!resource || resource.type !== 'audio') {
            warn(state, 'W_LOTTIE_MISSING_AUDIO', `${path}.refId`, `Audio asset "${refId}" was not found.`);
            nodes.push(baseNode);
          } else {
            nodes.push({ ...baseNode, components: [{ type: 'audio', resource: refId, volume: 1, loop: false }] });
          }
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          continue;
        }
        if (type === 15) {
          const refId = typeof layer.refId === 'string' ? layer.refId : '';
          const resource = resources.find(candidate => candidate.id === refId);
          if (!resource || resource.type !== 'binary') {
            warn(state, 'W_LOTTIE_MISSING_DATA', `${path}.refId`, `Data asset "${refId}" was not found.`);
            nodes.push(baseNode);
          } else {
            state.usesDataLayerExtension = true;
            nodes.push({
              ...baseNode,
              extensions: {
                [DATA_LAYER_EXTENSION]: {
                  resource: refId,
                  mediaType: resource.mimeType ?? 'application/octet-stream',
                },
              },
            });
          }
          nodes.push(...composite.nodes);
          state.convertedLayerCount++;
          continue;
        }
        nodes.push(baseNode);
        nodes.push(...composite.nodes);
        state.skippedLayerCount++;
        warn(state, 'W_LOTTIE_UNSUPPORTED_LAYER', `${path}.ty`, `Layer type ${type} is preserved as a transform-only node.`);
        } finally {
          state.timeline = context.timeline;
        }
      }
    } finally {
      state.timeline = previousTimeline;
    }
  }

  function expandPrecomp(
    layer: Record<string, unknown>,
    layerId: string,
    path: string,
    parentContext: LottieLayerListContext,
  ): void {
    const refId = typeof layer.refId === 'string' ? layer.refId : '';
    const entry = assetsById.get(refId);
    if (!entry || !Array.isArray(entry.value.layers)) {
      state.skippedLayerCount++;
      warn(state, 'W_LOTTIE_MISSING_PRECOMP', `${path}.refId`, `Precomposition asset "${refId}" was not found.`);
      return;
    }
    if (parentContext.precompStack.includes(refId)) {
      state.skippedLayerCount++;
      warn(state, 'W_LOTTIE_PRECOMP_CYCLE', `${path}.refId`, `Precomposition cycle detected for asset "${refId}".`);
      return;
    }
    const stretch = finite(layer.sr ?? 1, `${path}.sr`);
    if (stretch <= 0) {
      state.skippedLayerCount++;
      warn(state, 'W_LOTTIE_INVALID_TIME_STRETCH', `${path}.sr`, 'Precomposition time stretch must be greater than zero.');
      return;
    }
    const startFrame = finite(layer.st ?? 0, `${path}.st`);
    const assetFrameRate = positive(entry.value.fr ?? parentContext.timeline.frameRate, `$.assets[${entry.index}].fr`);
    const timeline: LottieTimeline = {
      frameRate: assetFrameRate,
      secondsOffset: frameToSeconds(parentContext.timeline, startFrame),
      secondsPerFrame: parentContext.timeline.secondsPerFrame
        * parentContext.timeline.frameRate / assetFrameRate * stretch,
    };
    const contentTimeline = layer.tm === undefined || !isAnimated(layer.tm)
      ? timeline
      : createTimeRemappedTimeline(
        layer.tm,
        parentContext.timeline,
        assetFrameRate,
        `${path}.tm`,
        state,
      ) ?? timeline;
    convertLayerList(list(entry.value.layers), {
      listPath: `$.assets[${entry.index}].layers`,
      idPrefix: `${layerId}/`,
      fallbackParent: layerId,
      timeline: contentTimeline,
      compositionWidth: positive(entry.value.w ?? layer.w ?? parentContext.compositionWidth, `$.assets[${entry.index}].w`),
      compositionHeight: positive(entry.value.h ?? layer.h ?? parentContext.compositionHeight, `$.assets[${entry.index}].h`),
      precompStack: [...parentContext.precompStack, refId],
    });
  }
}

/** Returns the complete authored-font delivery inventory without converting geometry. */
export function inspectLottieFonts(
  source: string | Readonly<Record<string, unknown>>,
  mappings: LottieConversionOptions['fonts'] = {},
): readonly LottieFontRequirement[] {
  const root = typeof source === 'string' ? parseLottieJson(source) : source;
  const usage = new Map<string, number>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.f === 'string' && typeof record.t === 'string') {
      usage.set(record.f, (usage.get(record.f) ?? 0) + 1);
    }
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(root.layers);
  visit(root.assets);
  const entries = list(object(root.fonts).list).map(object);
  const declared = new Set(entries.map(entry => typeof entry.fName === 'string' ? entry.fName : '').filter(Boolean));
  for (const used of usage.keys()) {
    if (!declared.has(used)) entries.push({ fName: used, fFamily: used, fStyle: 'Regular' });
  }
  return Object.freeze(entries.flatMap(entry => {
    if (typeof entry.fName !== 'string' || !entry.fName) return [];
    const configured = mappings?.[entry.fName];
    const mapping: LottieWebFontMapping | undefined = typeof configured === 'string' ? { uri: configured } : configured;
    const authoredFamily = typeof entry.fFamily === 'string' && entry.fFamily ? entry.fFamily : entry.fName;
    const authoredStyle = typeof entry.fStyle === 'string' ? entry.fStyle : 'Regular';
    const normalizedStyle = authoredStyle.toLowerCase();
    return [Object.freeze({
      name: entry.fName,
      authoredFamily,
      authoredStyle,
      ...(typeof entry.ascent === 'number' && Number.isFinite(entry.ascent) ? { authoredAscent: entry.ascent } : {}),
      usageCount: usage.get(entry.fName) ?? 0,
      mapped: mapping !== undefined,
      resolvedFamily: mapping?.family ?? authoredFamily,
      resolvedStyle: mapping?.style ?? (normalizedStyle.includes('italic') ? 'italic' as const : 'normal' as const),
      resolvedWeight: mapping?.weight ?? (normalizedStyle.includes('bold') || normalizedStyle.includes('demi') ? 700 : 400),
      ...(mapping ? { uri: mapping.uri, mimeType: mapping.mimeType ?? 'font/woff2' } : {}),
      ...(mapping?.integrity === undefined ? {} : { integrity: mapping.integrity }),
      ...(mapping?.metrics === undefined ? {} : { metrics: Object.freeze({ ...mapping.metrics }) }),
    })];
  }));
}

export function convertLottieDocument(
  source: string | Readonly<Record<string, unknown>>,
  options: LottieConversionOptions = {},
): AnimationDocument {
  return convertLottie(source, options).document;
}

function convertFonts(
  value: unknown,
  options: LottieConversionOptions,
): { fonts: ReadonlyMap<string, LottieFontDescriptor>; resources: AnimationResource[] } {
  const fonts = new Map<string, LottieFontDescriptor>();
  const resources: AnimationResource[] = [];
  for (const entry of list(object(value).list).map(object)) {
    if (typeof entry.fName !== 'string' || !entry.fName) continue;
    const configured = options.fonts?.[entry.fName];
    const configuration = typeof configured === 'string' ? { uri: configured } : configured;
    const authoredStyle = typeof entry.fStyle === 'string' ? entry.fStyle.toLowerCase() : '';
    const descriptor: LottieFontDescriptor = {
      name: entry.fName,
      family: configuration?.family ?? (typeof entry.fFamily === 'string' && entry.fFamily ? entry.fFamily : entry.fName),
      style: configuration?.style ?? (authoredStyle.includes('italic') ? 'italic' : 'normal'),
      weight: configuration?.weight ?? (authoredStyle.includes('bold') ? 700 : 400),
      ...(configuration ? { resourceId: `font:${entry.fName}` } : {}),
    };
    fonts.set(entry.fName, descriptor);
    if (configuration) resources.push({
      id: descriptor.resourceId!, type: 'binary', uri: configuration.uri,
      mimeType: configuration.mimeType ?? 'font/woff2',
      ...(configuration.integrity === undefined ? {} : { integrity: configuration.integrity }),
    });
  }
  return { fonts, resources };
}

function convertAssets(
  value: unknown,
  options: LottieConversionOptions,
  audioResourceIds: ReadonlySet<string>,
  dataResourceIds: ReadonlySet<string>,
): AnimationResource[] {
  const assets: AnimationResource[] = [];
  const values = list(value);
  for (let index = 0; index < values.length; index++) {
    const asset = object(values[index]);
    if (typeof asset.id !== 'string' || typeof asset.p !== 'string') continue;
    const prefix = typeof asset.u === 'string' ? asset.u : '';
    const uri = asset.p.startsWith('data:') ? asset.p : resolveUri(options.imageBaseUrl ?? '', `${prefix}${asset.p}`);
    if (audioResourceIds.has(asset.id)) {
      assets.push({ id: asset.id, type: 'audio', uri });
    } else if (dataResourceIds.has(asset.id)) {
      const mimeType = asset.t === 3 || /\.json(?:$|[?#])/i.test(asset.p) ? 'application/json' : 'application/octet-stream';
      assets.push({ id: asset.id, type: 'binary', uri, mimeType });
    } else {
      assets.push({
        id: asset.id,
        type: 'image',
        uri,
        ...(typeof asset.w === 'number' && asset.w > 0 ? { width: asset.w } : {}),
        ...(typeof asset.h === 'number' && asset.h > 0 ? { height: asset.h } : {}),
      });
    }
  }
  return assets;
}

function collectReferencedAssetIds(
  layerLists: readonly (readonly unknown[])[],
  layerType: number,
): ReadonlySet<string> {
  const result = new Set<string>();
  for (const layerList of layerLists) {
    for (const layerValue of layerList) {
      const layer = object(layerValue);
      if (layer.ty === layerType && typeof layer.refId === 'string') result.add(layer.refId);
    }
  }
  return result;
}

function convertText(value: unknown, path: string, canvasWidth: number, state: ConversionState, tint: LottieTintEffect | null): AnimationComponent | null {
  const textRoot = object(value);
  const textExpression = object(textRoot.d).x;
  if (typeof textExpression === 'string' && textExpression.trim().length > 0) {
    warn(state, 'W_LOTTIE_TEXT_EXPRESSION', `${path}.t.d.x`, 'Text document expressions are preserved as a precise diagnostic; HYA does not execute source scripts at runtime.');
  }
  const keyframes = list(object(textRoot.d).k).map(object);
  const documents: AnimationTextDocumentKeyframe[] = [];
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index]!;
    const document = object(keyframe.s);
    if (typeof document.t !== 'string') {
      warn(state, 'W_LOTTIE_INVALID_TEXT', `${path}.t.d.k[${index}].s`, 'Text document has no string value.');
      continue;
    }
    const converted = convertTextDocument(document, frameToSeconds(state.timeline, finite(keyframe.t ?? 0, `${path}.t.d.k[${index}].t`)), state, tint, `${path}.t.d.k[${index}].s`);
    if (documents.length > 0 && converted.time <= documents[documents.length - 1]!.time) {
      warn(state, 'W_LOTTIE_TEXT_DOCUMENT_TIME', `${path}.t.d.k[${index}].t`, 'Duplicate or reversed text document time was omitted.');
      continue;
    }
    documents.push(converted);
  }
  const first = documents[0];
  if (!first) {
    warn(state, 'W_LOTTIE_INVALID_TEXT', `${path}.t.d`, 'Text layer has no usable text document.');
    return null;
  }
  const source = object(keyframes[0]?.s);
  const declaredSize = numberList(source.sz);
  const width = declaredSize[0] && declaredSize[0] > 0
    ? declaredSize[0]
    : Math.min(canvasWidth, Math.max(64, Math.max(...documents.map(document => document.text.length)) * (first.fontSize ?? 32) * 0.7));
  const height = declaredSize[1] && declaredSize[1] > 0 ? declaredSize[1] : (first.lineHeight ?? (first.fontSize ?? 32) * 1.2) * 1.35;
  const animators = convertTextAnimators(textRoot.a, first.fontSize ?? 32, `${path}.t.a`, state);
  return {
    type: 'text2d', text: first.text, size: [width, height],
    ...(first.fontFamily === undefined ? {} : { fontFamily: first.fontFamily }),
    ...(first.fontSize === undefined ? {} : { fontSize: first.fontSize }),
    ...(first.fontWeight === undefined ? {} : { fontWeight: first.fontWeight }),
    ...(first.fontStyle === undefined ? {} : { fontStyle: first.fontStyle }),
    ...(first.fontResource === undefined ? {} : { fontResource: first.fontResource }),
    ...(first.lineHeight === undefined ? {} : { lineHeight: first.lineHeight }),
    ...(first.tracking === undefined ? {} : { tracking: first.tracking }),
    ...(first.textAlign === undefined ? {} : { textAlign: first.textAlign }),
    verticalAlign: 'middle', color: first.color ?? [1, 1, 1, 1],
    ...(documents.length > 1 ? { documents } : {}),
    ...(animators.length > 0 ? { animators } : {}),
  } satisfies AnimationText2DComponent;
}

function convertTextDocument(
  document: Record<string, unknown>,
  time: number,
  state: ConversionState,
  tint: LottieTintEffect | null,
  path: string,
): AnimationTextDocumentKeyframe {
  const fontSize = typeof document.s === 'number' && document.s > 0 ? document.s : 32;
  const authoredFont = typeof document.f === 'string' ? document.f : '';
  const font = state.fonts.get(authoredFont);
  if (authoredFont && !font?.resourceId && !state.warnedFontSubstitutions.has(authoredFont)) {
    state.warnedFontSubstitutions.add(authoredFont);
    warn(state, 'W_LOTTIE_FONT_SUBSTITUTION', `${path}.f`, `Font "${authoredFont}" has no mapped web-font resource; runtime fallback metrics may differ.`);
  }
  const fill = numberList(document.fc);
  const justification = typeof document.j === 'number' ? document.j : 2;
  return {
    time: Math.max(0, time), text: document.t as string,
    fontFamily: font?.family ?? (authoredFont || 'sans-serif'), fontSize,
    fontWeight: font?.weight ?? 400, fontStyle: font?.style ?? 'normal',
    ...(font?.resourceId === undefined ? {} : { fontResource: font.resourceId }),
    lineHeight: typeof document.lh === 'number' && document.lh > 0 ? document.lh : fontSize * 1.2,
    tracking: finite(document.tr ?? 0, `${path}.tr`) * fontSize / 1000,
    textAlign: justification === 0 ? 'left' : justification === 1 ? 'right' : 'center',
    color: applyTint([
      clamp(fill[0] ?? 1, 0, 1), clamp(fill[1] ?? 1, 0, 1), clamp(fill[2] ?? 1, 0, 1), 1,
    ], tint),
  };
}

function convertTextAnimators(value: unknown, fontSize: number, path: string, state: ConversionState): AnimationTextAnimator[] {
  const result: AnimationTextAnimator[] = [];
  const animators = list(value).map(object);
  for (let index = 0; index < animators.length; index++) {
    const source = animators[index]!;
    const animatorPath = `${path}[${index}]`;
    const selector = object(source.s);
    const selectorType = selector.t === undefined ? 0 : integer(selector.t, `${animatorPath}.s.t`);
    const basedOn = selector.b === undefined ? 1 : integer(selector.b, `${animatorPath}.s.b`);
    if (selectorType !== 0) {
      warn(state, 'W_LOTTIE_TEXT_SELECTOR', `${animatorPath}.s.t`, 'Expression text selectors are not executed; use an offline bake or a range selector.');
      continue;
    }
    const basedOnValue = [undefined, 'characters', 'characters-excluding-spaces', 'words', 'lines'][basedOn] as AnimationTextAnimator['selector']['basedOn'] | undefined;
    if (!basedOnValue) {
      warn(state, 'W_LOTTIE_TEXT_SELECTOR', `${animatorPath}.s.b`, `Text selector based-on mode ${basedOn} is not supported.`);
      continue;
    }
    const animatedSelectorControl = [
      ['xe', selector.xe], ['ne', selector.ne], ['sm', selector.sm],
    ].find(([, property]) => isAnimated(property));
    if (animatedSelectorControl) {
      warn(state, 'W_LOTTIE_TEXT_SELECTOR', `${animatorPath}.s.${animatedSelectorControl[0]}`, 'Animated selector easing or smoothness requires offline baking.');
      continue;
    }
    const units = selector.r === 2 ? 'index' as const : 'percent' as const;
    const normalizeSelector = (values: readonly number[]) => [units === 'percent' ? (values[0] ?? 0) / 100 : values[0] ?? 0];
    const startProperty = selector.s;
    const endProperty = selector.e;
    const offsetProperty = selector.o;
    const amountProperty = selector.a;
    const start = normalizeSelector([readStaticScalar(startProperty, 0)])[0]!;
    const end = normalizeSelector([readStaticScalar(endProperty, units === 'percent' ? 100 : 0)])[0]!;
    const offset = normalizeSelector([readStaticScalar(offsetProperty, 0)])[0]!;
    const amount = clamp(readStaticScalar(amountProperty, 100) / 100, -1, 1);
    const shapeCode = selector.sh === undefined ? 1 : integer(selector.sh, `${animatorPath}.s.sh`);
    const shape = ['square', 'square', 'ramp-up', 'ramp-down', 'triangle', 'round', 'smooth'][shapeCode] as AnimationTextAnimator['selector']['shape'] | undefined;
    if (!shape) {
      warn(state, 'W_LOTTIE_TEXT_SELECTOR', `${animatorPath}.s.sh`, `Range selector shape ${shapeCode} is not supported.`);
      continue;
    }
    const easeHigh = clamp(readStaticScalar(selector.xe, 0), -100, 100) / 100;
    const easeLow = clamp(readStaticScalar(selector.ne, 0), -100, 100) / 100;
    const easing = [
      easeLow > 0 ? easeLow : 0,
      easeLow < 0 ? -easeLow : 0,
      easeHigh > 0 ? 1 - easeHigh : 1,
      easeHigh < 0 ? 1 + easeHigh : 1,
    ] as const;
    const smoothness = clamp(readStaticScalar(selector.sm, 100) / 100, 0, 1);
    const randomSeed = selector.rn === 1 ? stableUint32(animatorPath) : undefined;
    const animator = object(source.a);
    const position = readStaticVector(animator.p, [0, 0]);
    const scale = readStaticVector(animator.s, [100, 100]);
    const fill = readStaticVector(animator.fc, [1, 1, 1]);
    const startTrack = createInlineTrack(startProperty, state, `${animatorPath}.s.s`, normalizeSelector);
    const endTrack = createInlineTrack(endProperty, state, `${animatorPath}.s.e`, normalizeSelector);
    const offsetTrack = createInlineTrack(offsetProperty, state, `${animatorPath}.s.o`, normalizeSelector);
    const amountTrack = createInlineTrack(amountProperty, state, `${animatorPath}.s.a`, values => [clamp((values[0] ?? 100) / 100, -1, 1)]);
    const positionTrack = createInlineTrack(animator.p, state, `${animatorPath}.a.p`, values => [values[0] ?? 0, values[1] ?? 0]);
    const scaleTrack = createInlineTrack(animator.s, state, `${animatorPath}.a.s`, values => [(values[0] ?? 100) / 100, (values[1] ?? 100) / 100]);
    const rotationTrack = createInlineTrack(animator.r, state, `${animatorPath}.a.r`, values => [degreesToRadians(values[0] ?? 0)]);
    const opacityTrack = createInlineTrack(animator.o, state, `${animatorPath}.a.o`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
    const fillColorTrack = createInlineTrack(animator.fc, state, `${animatorPath}.a.fc`, values => [
      clamp(values[0] ?? 1, 0, 1), clamp(values[1] ?? 1, 0, 1), clamp(values[2] ?? 1, 0, 1), 1,
    ]);
    const trackingTrack = createInlineTrack(animator.t, state, `${animatorPath}.a.t`, values => [(values[0] ?? 0) * fontSize / 1000]);
    result.push({
      selector: {
        start, end, offset, units, amount, shape, basedOn: basedOnValue,
        ...(easing[0] === 0 && easing[1] === 0 && easing[2] === 1 && easing[3] === 1 ? {} : { easing }),
        ...(smoothness === 1 ? {} : { smoothness }),
        ...(randomSeed === undefined ? {} : { randomSeed }),
        ...(startTrack ? { startTrack } : {}),
        ...(endTrack ? { endTrack } : {}),
        ...(offsetTrack ? { offsetTrack } : {}),
        ...(amountTrack ? { amountTrack } : {}),
      },
      ...(animator.p === undefined ? {} : { position: [position[0] ?? 0, position[1] ?? 0] as [number, number] }),
      ...(animator.s === undefined ? {} : { scale: [(scale[0] ?? 100) / 100, (scale[1] ?? 100) / 100] as [number, number] }),
      ...(animator.r === undefined ? {} : { rotation: degreesToRadians(readStaticScalar(animator.r, 0)) }),
      ...(animator.o === undefined ? {} : { opacity: clamp(readStaticScalar(animator.o, 100) / 100, 0, 1) }),
      ...(animator.fc === undefined ? {} : { fillColor: [clamp(fill[0] ?? 1, 0, 1), clamp(fill[1] ?? 1, 0, 1), clamp(fill[2] ?? 1, 0, 1), 1] as [number, number, number, number] }),
      ...(animator.t === undefined ? {} : { tracking: readStaticScalar(animator.t, 0) * fontSize / 1000 }),
      ...(positionTrack ? { positionTrack } : {}),
      ...(scaleTrack ? { scaleTrack } : {}),
      ...(rotationTrack ? { rotationTrack } : {}),
      ...(opacityTrack ? { opacityTrack } : {}),
      ...(fillColorTrack ? { fillColorTrack } : {}),
      ...(trackingTrack ? { trackingTrack } : {}),
    });
  }
  return result;
}

function convertTransform(value: unknown, path: string, node: string, state: ConversionState) {
  return convertTransformProperties(object(value), `${path}.ks`, node, state);
}

function collectRetainedLayerIndices(layerList: readonly unknown[], listPath: string): ReadonlySet<number> {
  const layersByIndex = new Map<number, { readonly layer: Record<string, unknown>; readonly sourceIndex: number }>();
  const retained = new Set<number>();
  for (let sourceIndex = 0; sourceIndex < layerList.length; sourceIndex++) {
    const layer = object(layerList[sourceIndex]);
    const layerIndex = integer(layer.ind ?? sourceIndex + 1, `${listPath}[${sourceIndex}].ind`);
    layersByIndex.set(layerIndex, { layer, sourceIndex });
    if (layer.hd !== true) retained.add(layerIndex);
  }

  // A hidden layer may still be the authored transform parent of a visible
  // layer. Retain the complete ancestor chain; unrelated hidden visual layers
  // remain omitted from the HYA document.
  const pending = [...retained];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const layerIndex = pending[cursor]!;
    const record = layersByIndex.get(layerIndex);
    if (!record || record.layer.parent === undefined) continue;
    const parentIndex = integer(record.layer.parent, `${listPath}[${record.sourceIndex}].parent`);
    if (!layersByIndex.has(parentIndex) || retained.has(parentIndex)) continue;
    retained.add(parentIndex);
    pending.push(parentIndex);
  }
  return retained;
}

function convertTransformProperties(ks: Record<string, unknown>, path: string, node: string, state: ConversionState) {
  const position = readStaticVector(ks.p, [0, 0]);
  const scale = readStaticVector(ks.s, [100, 100]);
  const anchor = readStaticVector(ks.a, [0, 0]);
  const rotation = readStaticScalar(ks.r ?? ks.rz, 0);
  const opacity = readStaticScalar(ks.o, 100);
  appendTrack(ks.p, node, 'position', state, values => [values[0] ?? 0, values[1] ?? 0], `${path}.p`);
  appendTrack(ks.s, node, 'scale', state, values => [(values[0] ?? 100) / 100, (values[1] ?? 100) / 100], `${path}.s`);
  appendTrack(ks.r ?? ks.rz, node, 'rotation', state, values => [degreesToRadians(values[0] ?? 0)], `${path}.r`);
  appendTrack(ks.o, node, 'opacity', state, values => [clamp((values[0] ?? 100) / 100, 0, 1)], `${path}.o`);
  if (isAnimated(ks.a)) warn(state, 'W_LOTTIE_ANIMATED_ANCHOR', `${path}.a`, 'Animated anchor points are sampled at their initial value.');
  return {
    position: [position[0] ?? 0, position[1] ?? 0] as [number, number],
    rotation: degreesToRadians(rotation),
    scale: [(scale[0] ?? 100) / 100, (scale[1] ?? 100) / 100] as [number, number],
    anchor: [anchor[0] ?? 0, anchor[1] ?? 0] as [number, number],
    opacity: clamp(opacity / 100, 0, 1),
  };
}

function convertShapes(value: unknown, parent: string, path: string, state: ConversionState, tint: LottieTintEffect | null): AnimationNode[] {
  const result: AnimationNode[] = [];
  visitShapeList(list(value), [], [], parent, `${path}.shapes`);
  return result;

  function visitShapeList(
    values: unknown[],
    inheritedPaints: readonly LottiePaint[],
    inheritedModifiers: readonly AnimationVectorPathModifier[],
    nodeParent: string,
    listPath: string,
  ): void {
    const localPaints: Array<{ readonly index: number; readonly paint: LottiePaint }> = [];
    const localModifiers: Array<{ readonly index: number; readonly modifier: AnimationVectorPathModifier }> = [];
    for (let index = 0; index < values.length; index++) {
      const shape = object(values[index]);
      if (shape.hd === true) continue;
      if (shape.ty === 'fl') {
        localPaints.push({ index, paint: {
          kind: 'fill', fill: convertSolidFillStyle(shape, `${listPath}[${index}]`, state, tint),
          fillRule: shape.r === 2 ? 'evenodd' : 'nonzero',
        } });
      }
      if (shape.ty === 'gf') localPaints.push({ index, paint: {
        kind: 'fill', fill: convertGradientFillStyle(shape, `${listPath}[${index}]`, state, tint),
        fillRule: shape.r === 2 ? 'evenodd' : 'nonzero',
      } });
      if (shape.ty === 'st') {
        const stroke = convertStrokeStyle(shape, `${listPath}[${index}]`, state);
        if (stroke) localPaints.push({ index, paint: { kind: 'stroke', stroke } });
      }
      if (shape.ty === 'gs') {
        const stroke = convertGradientStrokeStyle(shape, `${listPath}[${index}]`, state, tint);
        if (stroke) localPaints.push({ index, paint: { kind: 'stroke', stroke } });
      }
      const modifier = convertShapeModifier(shape, `${listPath}[${index}]`, state);
      if (modifier) localModifiers.push({ index, modifier });
    }
    const paintsFor = (shapeIndex: number): readonly LottiePaint[] => [
      ...inheritedPaints,
      ...localPaints.filter(entry => entry.index > shapeIndex).map(entry => entry.paint),
    ];
    const modifiersFor = (shapeIndex: number): readonly AnimationVectorPathModifier[] => [
      ...localModifiers.filter(entry => entry.index > shapeIndex).map(entry => entry.modifier),
      ...inheritedModifiers,
    ];
    const mergePlans = prepareStaticMergePlans(values, listPath, state);
    const mergedInputIndices = new Set(
      [...mergePlans.values()].flatMap(plan => plan.inputIndices),
    );
    for (let index = 0; index < values.length; index++) {
      const shape = object(values[index]);
      const shapePath = `${listPath}[${index}]`;
      if (shape.hd === true) continue;
      if (mergedInputIndices.has(index)) continue;
      if (shape.ty === 'mm') {
        const plan = mergePlans.get(index);
        if (!plan) continue;
        const components = paintsFor(index).flatMap(paint => plan.prepared
          ? createPaintedPath(plan.prepared, paint, modifiersFor(index), state)
          : plan.path
            ? createPaintedStaticPath(plan.path, paint, modifiersFor(index), state)
            : []);
        if (components.length === 0) continue;
        const id = `${parent}:shape:${state.shapeCounter++}`;
        result.push({ id, name: typeof shape.nm === 'string' ? shape.nm : id, parent: nodeParent, components });
        continue;
      }
      if (shape.ty === 'gr') {
        const items = list(shape.it);
        const transformIndex = items.findIndex(item => object(item).ty === 'tr');
        const groupId = `${parent}:group:${state.shapeCounter++}`;
        const groupNode: AnimationNode = {
          id: groupId,
          name: typeof shape.nm === 'string' ? shape.nm : groupId,
          parent: nodeParent,
        };
        if (transformIndex >= 0) {
          const transform = object(items[transformIndex]);
          groupNode.transform = convertTransformProperties(transform, `${shapePath}.it[${transformIndex}]`, groupId, state);
          if (isAnimated(transform.sk) || isAnimated(transform.sa)
            || Math.abs(readStaticScalar(transform.sk, 0)) > 1e-6
            || Math.abs(readStaticScalar(transform.sa, 0)) > 1e-6) {
            warn(state, 'W_LOTTIE_GROUP_SKEW', `${shapePath}.it[${transformIndex}]`, 'Shape group skew is not converted.');
          }
        }
        result.push(groupNode);
        visitShapeList(items, paintsFor(index), modifiersFor(index), groupId, `${shapePath}.it`);
        continue;
      }
      if (shape.ty === 'sh') {
        const prepared = preparePaintedPath(shape.ks, `${shapePath}.ks`, state);
        const components = prepared ? paintsFor(index).flatMap(paint => (
          createPaintedPath(prepared, paint, modifiersFor(index), state)
        )) : [];
        if (components.length === 0) continue;
        const id = `${parent}:shape:${state.shapeCounter++}`;
        result.push({ id, name: typeof shape.nm === 'string' ? shape.nm : id, parent: nodeParent, components });
        continue;
      }
      if (shape.ty === 'sr') {
        const paints = paintsFor(index);
        if (paints.length === 0) continue;
        const pathData = convertPolystarPath(shape, shapePath, state);
        if (!pathData) continue;
        const id = `${parent}:shape:${state.shapeCounter++}`;
        const position = readStaticVector(shape.p, [0, 0]);
        const rotation = readStaticScalar(shape.r, 0);
        appendTrack(shape.p, id, 'position', state, values => [values[0] ?? 0, values[1] ?? 0], `${shapePath}.p`);
        appendTrack(shape.r, id, 'rotation', state, values => [degreesToRadians(values[0] ?? 0)], `${shapePath}.r`);
        result.push({
          id,
          name: typeof shape.nm === 'string' ? shape.nm : id,
          parent: nodeParent,
          transform: { position: [position[0] ?? 0, position[1] ?? 0], rotation: degreesToRadians(rotation) },
          components: paints.flatMap(paint => createPaintedStaticPath(pathData, paint, modifiersFor(index), state)),
        });
        continue;
      }
      if (shape.ty !== 'rc' && shape.ty !== 'el') {
        if (!['fl', 'gf', 'st', 'gs', 'tr', 'tm', 'rd', 'mm'].includes(String(shape.ty))) warn(state, 'W_LOTTIE_UNSUPPORTED_SHAPE', `${shapePath}.ty`, `Shape operator "${String(shape.ty)}" is not converted.`);
        continue;
      }
      const paints = paintsFor(index);
      if (paints.length === 0) continue;
      const size = readFirstPositiveVector(shape.s, 2) ?? readStaticVector(shape.s, [0, 0]);
      const position = readStaticVector(shape.p, [0, 0]);
      if ((size[0] ?? 0) <= 0 || (size[1] ?? 0) <= 0) {
        warn(state, 'W_LOTTIE_INVALID_SHAPE_SIZE', `${shapePath}.s`, 'Shape has no positive static size.');
        continue;
      }
      const id = `${parent}:shape:${state.shapeCounter++}`;
      const radius = shape.ty === 'rc' ? Math.max(0, readStaticScalar(shape.r, 0)) : 0;
      const pathData = shape.ty === 'rc'
        ? roundedRectanglePath(size[0]!, size[1]!, radius)
        : ellipsePath(size[0]! / 2, size[1]! / 2);
      const components = paints.flatMap(paint => createPaintedStaticPath(pathData, paint, modifiersFor(index), state));
      appendTrack(shape.p, id, 'position', state, values => [values[0] ?? 0, values[1] ?? 0], `${shapePath}.p`);
      appendTrack(shape.s, id, 'scale', state, values => [
        (values[0] ?? size[0]!) / size[0]!,
        (values[1] ?? size[1]!) / size[1]!,
      ], `${shapePath}.s`);
      if (shape.ty === 'rc' && isAnimated(shape.r)) warn(state, 'W_LOTTIE_ANIMATED_ROUNDED_RECT', `${shapePath}.r`, 'Animated corner radius is sampled at its initial value.');
      result.push({
        id,
        name: typeof shape.nm === 'string' ? shape.nm : id,
        parent: nodeParent,
        transform: { position: [position[0] ?? 0, position[1] ?? 0] },
        components,
      });
    }
  }
}

function hasOnlyIntentionallyInvisiblePaints(value: unknown): boolean {
  const paints: Record<string, unknown>[] = [];
  const visit = (items: readonly unknown[]): void => {
    for (const entry of items) {
      const shape = object(entry);
      if (shape.hd === true) continue;
      if (shape.ty === 'gr') visit(list(shape.it));
      else if (shape.ty === 'fl' || shape.ty === 'gf' || shape.ty === 'st' || shape.ty === 'gs') paints.push(shape);
    }
  };
  visit(list(value));
  if (paints.length === 0) return false;
  return paints.every(paint => {
    const opacityVisible = (readFirstPositiveVector(paint.o, 1)?.[0] ?? readStaticScalar(paint.o, 100)) > 0;
    if (!opacityVisible) return true;
    if (paint.ty === 'st' || paint.ty === 'gs') {
      return readFirstPositiveVector(paint.w, 1) === undefined;
    }
    if (paint.ty === 'fl') {
      const color = readStaticVector(paint.c, [1, 1, 1, 1]);
      return (color[3] ?? 1) <= 0;
    }
    return false;
  });
}

function hasOnlyIntentionallyEmptyPaths(value: unknown): boolean {
  let pathCount = 0;
  let hasRenderableGeometry = false;
  const visit = (items: readonly unknown[]): void => {
    for (const entry of items) {
      const shape = object(entry);
      if (shape.hd === true) continue;
      if (shape.ty === 'gr') {
        visit(list(shape.it));
        continue;
      }
      if (shape.ty === 'sh') {
        pathCount++;
        if (!isIntentionallyEmptyPathProperty(shape.ks)) hasRenderableGeometry = true;
        continue;
      }
      if (shape.ty === 'rc' || shape.ty === 'el' || shape.ty === 'sr' || shape.ty === 'mm') {
        hasRenderableGeometry = true;
      }
    }
  };
  visit(list(value));
  return pathCount > 0 && !hasRenderableGeometry;
}

function isIntentionallyEmptyPathProperty(value: unknown): boolean {
  const property = object(value);
  if (!isAnimated(property)) return isIntentionallyEmptyShape(readStaticShape(value));
  const shapes: Record<string, unknown>[] = [];
  for (const keyframe of list(property.k).map(object)) {
    for (const candidate of [keyframe.s, keyframe.e]) {
      if (candidate === undefined) continue;
      const shape = object(list(candidate)[0] ?? candidate);
      if (Object.keys(shape).length > 0) shapes.push(shape);
    }
  }
  return shapes.length > 0 && shapes.every(isIntentionallyEmptyShape);
}

function isIntentionallyEmptyShape(shape: Record<string, unknown>): boolean {
  return Array.isArray(shape.v) && shape.v.length === 0
    && Array.isArray(shape.i) && shape.i.length === 0
    && Array.isArray(shape.o) && shape.o.length === 0;
}

interface PreparedPaintedPath {
  readonly sourcePath: string;
  readonly commands: string;
  readonly values: number[];
  readonly closed: boolean;
  readonly morph?: AnimationVectorValueTrack;
}

interface StaticMergePlan {
  readonly inputIndices: readonly number[];
  readonly path?: Pick<AnimationPath2DComponent, 'commands' | 'values'>;
  readonly prepared?: PreparedPaintedPath;
}

interface StaticMergeOperand {
  readonly paths: readonly Pick<AnimationPath2DComponent, 'commands' | 'values'>[];
  readonly animated: boolean;
  readonly unsupportedReason?: string;
}

function prepareStaticMergePlans(
  values: readonly unknown[],
  listPath: string,
  state: ConversionState,
): ReadonlyMap<number, StaticMergePlan> {
  const plans = new Map<number, StaticMergePlan>();
  let boundary = 0;
  for (let index = 0; index < values.length; index++) {
    const operator = object(values[index]);
    if (operator.ty !== 'mm' || operator.hd === true) continue;
    const operatorPath = `${listPath}[${index}]`;
    const inputIndices: number[] = [];
    let unsupportedModifier: string | undefined;
    for (let inputIndex = boundary; inputIndex < index; inputIndex++) {
      const input = object(values[inputIndex]);
      if (input.hd === true) continue;
      if (isMergeGeometryShape(input.ty)) inputIndices.push(inputIndex);
      else if (['tm', 'rd', 'rp', 'pb', 'zz', 'op', 'tw'].includes(String(input.ty))) {
        unsupportedModifier = String(input.ty);
      }
    }
    boundary = index + 1;
    if (inputIndices.length === 0) {
      warn(state, 'W_LOTTIE_MERGE_PATH_INPUT', operatorPath, 'Merge Paths has no preceding path geometry to combine.');
      continue;
    }
    if (unsupportedModifier) {
      warn(state, 'W_LOTTIE_MERGE_PATH_INPUT', operatorPath, `Merge Paths cannot yet bake the preceding "${unsupportedModifier}" modifier.`);
      continue;
    }
    const mode = typeof operator.mm === 'number' && Number.isInteger(operator.mm) ? operator.mm : 1;
    if (mode < 1 || mode > 5) {
      warn(state, 'W_LOTTIE_MERGE_PATH_INPUT', `${operatorPath}.mm`, `Unknown Merge Paths mode "${String(operator.mm)}".`);
      continue;
    }
    const operands = inputIndices.map(inputIndex => collectStaticMergeOperand(
      object(values[inputIndex]),
      `${listPath}[${inputIndex}]`,
      state,
    ));
    if (operands.some(operand => operand.animated)) {
      const prepared = mode === 1
        ? prepareAnimatedCompoundMerge(values, inputIndices, listPath, state)
        : undefined;
      if (prepared) plans.set(index, { inputIndices, prepared });
      else warn(
        state,
        'W_LOTTIE_ANIMATED_MERGE_PATH',
        operatorPath,
        mode === 1
          ? 'Animated Merge Paths could not be baked into a stable compound morph.'
          : `Animated Merge Paths mode ${mode} requires time-varying boolean topology and remains unmerged.`,
      );
      continue;
    }
    const unsupported = operands.find(operand => operand.unsupportedReason)?.unsupportedReason;
    if (unsupported) {
      warn(state, 'W_LOTTIE_MERGE_PATH_INPUT', operatorPath, unsupported);
      continue;
    }
    try {
      plans.set(index, {
        inputIndices,
        ...(mergeStaticOperands(operands, mode) ?? {}),
      });
    } catch (error) {
      warn(
        state,
        'W_LOTTIE_MERGE_PATH_GEOMETRY',
        operatorPath,
        `Static Merge Paths boolean failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return plans;
}

function prepareAnimatedCompoundMerge(
  values: readonly unknown[],
  inputIndices: readonly number[],
  listPath: string,
  state: ConversionState,
): PreparedPaintedPath | undefined {
  const paths: PreparedPaintedPath[] = [];
  for (const inputIndex of inputIndices) {
    const shape = object(values[inputIndex]);
    // Mode 1 is a source-order compound path. Direct path operands preserve
    // that contract exactly. Animated primitives and group transforms need a
    // separate transform sampler and therefore retain the precise diagnostic.
    if (shape.ty !== 'sh') return undefined;
    const path = preparePaintedPath(shape.ks, `${listPath}[${inputIndex}].ks`, state);
    if (!path) return undefined;
    paths.push(path);
  }
  if (paths.length === 0) return undefined;
  const commands = paths.map(path => path.commands).join('');
  const dynamic = paths.filter(path => path.morph !== undefined);
  if (dynamic.length === 0) return {
    sourcePath: listPath,
    commands,
    values: paths.flatMap(path => path.values),
    closed: paths.every(path => path.closed),
  };

  const firstTime = Math.min(...dynamic.map(path => path.morph!.times[0]!));
  const lastTime = Math.max(...dynamic.map(path => path.morph!.times.at(-1)!));
  const sampleTimes = new Set<number>();
  for (const path of dynamic) for (const time of path.morph!.times) sampleTimes.add(Math.fround(time));
  // A compound morph owns one interpolation mode while its source paths may
  // have unrelated easings. Bake at the authored frame cadence: every rendered
  // source frame remains exact and linear reconstruction spans at most one
  // frame rather than assigning a false shared easing curve.
  const frameDuration = 1 / Math.max(1, state.frameRate);
  const firstFrame = Math.ceil(firstTime / frameDuration - 1e-6);
  const lastFrame = Math.floor(lastTime / frameDuration + 1e-6);
  if (lastFrame - firstFrame + 1 > 1024) return undefined;
  for (let frame = firstFrame; frame <= lastFrame; frame++) {
    sampleTimes.add(Math.fround(clamp(frame * frameDuration, 0, state.duration)));
  }
  const times = [...sampleTimes]
    .filter(time => time >= 0 && time <= state.duration)
    .sort((a, b) => a - b)
    .filter((time, index, entries) => index === 0 || time > entries[index - 1]!);
  if (times.length === 0) return undefined;
  const packedValues: number[] = [];
  for (const time of times) {
    for (const path of paths) {
      packedValues.push(...(path.morph ? sampleLottieVectorTrack(path.morph, time) : path.values));
    }
  }
  const valueSize = paths.reduce((sum, path) => sum + path.values.length, 0);
  return {
    sourcePath: listPath,
    commands,
    values: packedValues.slice(0, valueSize),
    closed: paths.every(path => path.closed),
    morph: { times, values: packedValues, valueSize, interpolation: 'linear' },
  };
}

function sampleLottieVectorTrack(track: AnimationVectorValueTrack, time: number): number[] {
  const times = track.times;
  let frame = 0;
  if (time >= times[times.length - 1]!) frame = times.length - 1;
  else while (frame + 1 < times.length && time >= times[frame + 1]!) frame++;
  const next = Math.min(frame + 1, times.length - 1);
  let progress = 0;
  if (next !== frame && track.interpolation !== 'step') {
    progress = clamp((time - times[frame]!) / Math.max(1e-8, times[next]! - times[frame]!), 0, 1);
    if (track.interpolation === 'cubic-bezier' && track.easings) {
      const offset = frame * 4;
      progress = cubicBezierProgress(
        progress,
        track.easings[offset] ?? 0.333,
        track.easings[offset + 1] ?? 0.333,
        track.easings[offset + 2] ?? 0.667,
        track.easings[offset + 3] ?? 0.667,
      );
    }
  }
  const result = new Array<number>(track.valueSize);
  const offset = frame * track.valueSize;
  const nextOffset = next * track.valueSize;
  for (let component = 0; component < track.valueSize; component++) {
    const from = track.values[offset + component] ?? 0;
    result[component] = from + ((track.values[nextOffset + component] ?? from) - from) * progress;
  }
  return result;
}

function isMergeGeometryShape(type: unknown): boolean {
  return type === 'sh' || type === 'rc' || type === 'el' || type === 'sr' || type === 'gr';
}

function collectStaticMergeOperand(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
): StaticMergeOperand {
  if (shape.ty === 'sh') {
    if (isAnimated(shape.ks)) return { paths: [], animated: true };
    const converted = convertShapePath(readStaticShape(shape.ks), `${path}.ks`, state, false, false);
    return converted
      ? { paths: [converted], animated: false }
      : { paths: [], animated: false, unsupportedReason: `Merge Paths input at ${path} is not valid path geometry.` };
  }
  if (shape.ty === 'rc' || shape.ty === 'el') {
    if ([shape.s, shape.p, ...(shape.ty === 'rc' ? [shape.r] : [])].some(isAnimated)) {
      return { paths: [], animated: true };
    }
    const size = readStaticVector(shape.s, [0, 0]);
    if ((size[0] ?? 0) <= 0 || (size[1] ?? 0) <= 0) {
      return { paths: [], animated: false, unsupportedReason: `Merge Paths primitive at ${path} has no positive size.` };
    }
    const generated = shape.ty === 'rc'
      ? roundedRectanglePath(size[0]!, size[1]!, Math.max(0, readStaticScalar(shape.r, 0)))
      : ellipsePath(size[0]! / 2, size[1]! / 2);
    const position = readStaticVector(shape.p, [0, 0]);
    return { paths: [transformStaticPath(generated, translationMatrix(position[0] ?? 0, position[1] ?? 0))], animated: false };
  }
  if (shape.ty === 'sr') {
    if ([shape.pt, shape.or, shape.ir, shape.is, shape.os, shape.p, shape.r].some(isAnimated)) {
      return { paths: [], animated: true };
    }
    const generated = convertPolystarPath(shape, path, state);
    if (!generated) return { paths: [], animated: false, unsupportedReason: `Merge Paths polystar at ${path} is invalid.` };
    const position = readStaticVector(shape.p, [0, 0]);
    const rotation = degreesToRadians(readStaticScalar(shape.r, 0));
    return {
      paths: [transformStaticPath(generated, transformMatrix(position, [0, 0], [100, 100], rotation))],
      animated: false,
    };
  }
  if (shape.ty === 'gr') {
    const items = list(shape.it);
    const transformEntry = items.map(object).find(item => item.ty === 'tr');
    if (transformEntry && [
      transformEntry.p, transformEntry.a, transformEntry.s, transformEntry.r ?? transformEntry.rz,
      transformEntry.sk, transformEntry.sa,
    ].some(isAnimated)) return { paths: [], animated: true };
    if (transformEntry && (Math.abs(readStaticScalar(transformEntry.sk, 0)) > 1e-6
      || Math.abs(readStaticScalar(transformEntry.sa, 0)) > 1e-6)) {
      return { paths: [], animated: false, unsupportedReason: `Merge Paths group at ${path} uses skew, which is not safe to bake.` };
    }
    const childShapes = items.map((item, index) => ({ item: object(item), index }))
      .filter(entry => entry.item.hd !== true && isMergeGeometryShape(entry.item.ty));
    const unsupportedOperator = items.map(object).find(item => item.hd !== true
      && ['mm', 'tm', 'rd', 'rp', 'pb', 'zz', 'op', 'tw'].includes(String(item.ty)));
    if (unsupportedOperator) {
      return { paths: [], animated: false, unsupportedReason: `Nested Merge Paths input at ${path} contains the "${String(unsupportedOperator.ty)}" operator.` };
    }
    const children = childShapes.map(child => collectStaticMergeOperand(child.item, `${path}.it[${child.index}]`, state));
    if (children.some(child => child.animated)) return { paths: [], animated: true };
    const unsupportedReason = children.find(child => child.unsupportedReason)?.unsupportedReason;
    if (unsupportedReason) return { paths: [], animated: false, unsupportedReason };
    const matrix = transformEntry
      ? transformMatrix(
        readStaticVector(transformEntry.p, [0, 0]),
        readStaticVector(transformEntry.a, [0, 0]),
        readStaticVector(transformEntry.s, [100, 100]),
        degreesToRadians(readStaticScalar(transformEntry.r ?? transformEntry.rz, 0)),
      )
      : identityMatrix();
    return {
      paths: children.flatMap(child => child.paths).map(child => transformStaticPath(child, matrix)),
      animated: false,
    };
  }
  return { paths: [], animated: false, unsupportedReason: `Merge Paths input at ${path} is not supported.` };
}

function mergeStaticOperands(
  operands: readonly StaticMergeOperand[],
  mode: number,
): Pick<StaticMergePlan, 'path'> | null {
  const path = mergeStaticVectorPaths(operands.map(operand => operand.paths), mode);
  return path ? { path } : null;
}

function convertSolidFillStyle(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
  tint: LottieTintEffect | null,
): AnimationVectorSolidPaint {
  const color = readStaticVector(shape.c, [1, 1, 1, 1]);
  const opacity = clamp(readStaticScalar(shape.o, 100) / 100, 0, 1);
  const base = applyTint([
    clamp(color[0] ?? 1, 0, 1), clamp(color[1] ?? 1, 0, 1), clamp(color[2] ?? 1, 0, 1),
    clamp(color[3] ?? 1, 0, 1),
  ], tint);
  const colorTrack = createInlineTrack(shape.c, state, `${path}.c`, values => {
    const converted = applyTint([
      clamp(values[0] ?? 1, 0, 1), clamp(values[1] ?? 1, 0, 1), clamp(values[2] ?? 1, 0, 1), clamp(values[3] ?? 1, 0, 1),
    ], tint);
    return [...converted];
  });
  const opacityTrack = createInlineTrack(shape.o, state, `${path}.o`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
  return { kind: 'solid', color: base, opacity, ...(colorTrack ? { colorTrack } : {}), ...(opacityTrack ? { opacityTrack } : {}) };
}

function convertGradientFillStyle(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
  tint: LottieTintEffect | null,
): AnimationVectorGradientPaint {
  const gradient = object(shape.g);
  if (shape.t === 2 && (isAnimated(shape.h) || isAnimated(shape.a)
    || Math.abs(readStaticScalar(shape.h, 0)) > 1e-6
    || Math.abs(readStaticScalar(shape.a, 0)) > 1e-6)) {
    warn(state, 'W_LOTTIE_GRADIENT_HIGHLIGHT', path, 'Radial gradient highlight length and angle are not converted.');
  }
  const authoredStopCount = Math.max(2, integer(gradient.p ?? 2, `${path}.g.p`));
  const stopCount = Math.min(8, authoredStopCount);
  if (authoredStopCount > 8) {
    warn(state, 'W_LOTTIE_GRADIENT_STOP_LIMIT', `${path}.g.p`, 'Gradient is resampled to the eight-stop HYA runtime budget.');
  }
  const property = gradient.k;
  const opacity = clamp(readStaticScalar(shape.o, 100) / 100, 0, 1);
  const stops = convertGradientStops(readStaticVector(property, []), authoredStopCount, stopCount, tint);
  const start = readStaticVector(shape.s, [0, 0]);
  const end = readStaticVector(shape.e, [100, 0]);
  const stopsTrack = createInlineTrack(property, state, `${path}.g.k`, values => convertGradientStops(values, authoredStopCount, stopCount, tint));
  const startTrack = createInlineTrack(shape.s, state, `${path}.s`, values => [values[0] ?? 0, values[1] ?? 0]);
  const endTrack = createInlineTrack(shape.e, state, `${path}.e`, values => [values[0] ?? 0, values[1] ?? 0]);
  const opacityTrack = createInlineTrack(shape.o, state, `${path}.o`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
  return {
    kind: shape.t === 2 ? 'radial-gradient' : 'linear-gradient',
    start: [start[0] ?? 0, start[1] ?? 0],
    end: [end[0] ?? 100, end[1] ?? 0],
    stops,
    opacity,
    ...(startTrack ? { startTrack } : {}),
    ...(endTrack ? { endTrack } : {}),
    ...(stopsTrack ? { stopsTrack } : {}),
    ...(opacityTrack ? { opacityTrack } : {}),
  };
}

function convertGradientStops(
  values: number[],
  authoredStopCount: number,
  stopCount: number,
  tint: LottieTintEffect | null,
): number[] {
  const colorStopCount = Math.min(authoredStopCount, Math.floor(values.length / 4));
  const opacityValues = values.slice(colorStopCount * 4);
  const opacityAt = (offset: number): number => {
    if (opacityValues.length < 2) return 1;
    let cursor = 0;
    while (cursor + 3 < opacityValues.length && opacityValues[cursor + 2]! <= offset) cursor += 2;
    const fromOffset = opacityValues[Math.max(0, cursor)] ?? 0;
    const fromOpacity = (opacityValues[Math.max(0, cursor) + 1] ?? 1);
    const toOffset = opacityValues[Math.min(opacityValues.length - 2, cursor + 2)] ?? fromOffset;
    const toOpacity = opacityValues[Math.min(opacityValues.length - 1, cursor + 3)] ?? fromOpacity;
    const progress = toOffset <= fromOffset ? 0 : clamp((offset - fromOffset) / (toOffset - fromOffset), 0, 1);
    return clamp(fromOpacity + (toOpacity - fromOpacity) * progress, 0, 1);
  };
  const colorAt = (offset: number): readonly [number, number, number] => {
    if (colorStopCount === 0) return [1, 1, 1];
    let from = 0;
    while (from + 1 < colorStopCount && (values[(from + 1) * 4] ?? 1) <= offset) from++;
    const to = Math.min(colorStopCount - 1, from + 1);
    const fromOffset = values[from * 4] ?? 0;
    const toOffset = values[to * 4] ?? fromOffset;
    const progress = toOffset <= fromOffset ? 0 : clamp((offset - fromOffset) / (toOffset - fromOffset), 0, 1);
    return [1, 2, 3].map(channel => clamp(
      (values[from * 4 + channel] ?? 1)
        + ((values[to * 4 + channel] ?? values[from * 4 + channel] ?? 1) - (values[from * 4 + channel] ?? 1)) * progress,
      0,
      1,
    )) as unknown as readonly [number, number, number];
  };
  const result: number[] = [];
  for (let index = 0; index < stopCount; index++) {
    const source = stopCount === colorStopCount ? index : -1;
    const offset = clamp(source >= 0 ? values[source * 4] ?? 0 : index / Math.max(1, stopCount - 1), 0, 1);
    const sampled = colorAt(offset);
    const converted = applyTint([
      sampled[0], sampled[1], sampled[2],
      opacityAt(offset),
    ], tint);
    result.push(offset, ...converted);
  }
  return result;
}

function convertGradientStrokeStyle(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
  tint: LottieTintEffect | null,
): LottieStrokeStyle | null {
  const base = convertStrokeStyle({ ...shape, c: { a: 0, k: [1, 1, 1, 1] } }, path, state);
  if (!base) return null;
  return { ...base, gradient: convertGradientFillStyle(shape, path, state, tint) };
}

function preparePaintedPath(value: unknown, path: string, state: ConversionState): PreparedPaintedPath | null {
  if (isAnimated(value)) {
    const morph = convertAnimatedPathData(value, path, state, false);
    if (morph) return {
      sourcePath: path,
      commands: morph.commands,
      values: morph.values.slice(0, morph.valueSize),
      closed: morph.commands.endsWith('Z'),
      morph: {
        times: morph.times,
        values: morph.values,
        valueSize: morph.valueSize,
        interpolation: morph.interpolation,
        ...(morph.easings ? { easings: morph.easings } : {}),
      },
    };
  }
  const shape = readStaticShape(value);
  const converted = convertShapePath(shape, path, state, false, false);
  return converted ? { sourcePath: path, commands: converted.commands, values: Array.from(converted.values), closed: shape.c !== false } : null;
}

function createPaintedPath(
  prepared: PreparedPaintedPath,
  paint: LottiePaint,
  modifiers: readonly AnimationVectorPathModifier[],
  state: ConversionState,
): AnimationComponent[] {
  const renderPath = paint.kind === 'fill' ? closePreparedPath(prepared, state) : prepared;
  const relativeMorph = renderPath.morph
    ? makeRelativeMorphTrack(renderPath.morph, renderPath.values)
    : undefined;
  const advanced = prepared.morph !== undefined || modifiers.length > 0
    || (paint.kind === 'fill' && (paint.fill.kind !== 'solid' || paint.fill.colorTrack !== undefined || paint.fill.opacityTrack !== undefined))
    || (paint.kind === 'stroke' && hasAnimatedStrokeStyle(paint.stroke));
  if (!advanced) {
    if (paint.kind === 'fill' && paint.fill.kind === 'solid') return [{
      type: 'path2d', commands: renderPath.commands, values: renderPath.values,
      fill: [
        paint.fill.color[0], paint.fill.color[1], paint.fill.color[2],
        paint.fill.color[3] * (paint.fill.opacity ?? 1),
      ],
      fillRule: paint.fillRule,
    }];
    if (paint.kind === 'stroke') {
      return [createStrokeExtensionComponent(renderPath.commands, renderPath.values, paint.stroke, state)];
    }
  }
  state.usesVectorShapeExtension = true;
  return [{
    type: ANIMATION_VECTOR_SHAPE_EXTENSION_ID,
    commands: renderPath.commands,
    values: renderPath.values,
    ...(relativeMorph ? { morph: relativeMorph, morphRelative: true } : {}),
    ...(paint.kind === 'fill' ? { fill: paint.fill } : { stroke: toVectorStrokePaint(paint.stroke) }),
    ...(modifiers.length > 0 ? { modifiers } : {}),
    fillRule: paint.kind === 'fill' ? paint.fillRule : 'nonzero',
    tolerance: 0.35,
  } satisfies AnimationVectorShapeComponent];
}

/**
 * Store animated path samples as deltas from the component base pose. Lottie
 * paths commonly repeat most coordinates between frames, so this preserves
 * the runtime ABI while producing long zero runs that compress efficiently.
 */
function makeRelativeMorphTrack(
  morph: AnimationVectorValueTrack,
  baseValues: readonly number[],
): AnimationVectorValueTrack {
  const values = Array.from(morph.values, (value, index) => (
    quantizeAnimatedPathCoordinate(value - (baseValues[index % morph.valueSize] ?? 0))
  ));
  return {
    times: morph.times,
    values,
    valueSize: morph.valueSize,
    interpolation: morph.interpolation,
    ...(morph.easings ? { easings: morph.easings } : {}),
  };
}

function closePreparedPath(prepared: PreparedPaintedPath, state: ConversionState): PreparedPaintedPath {
  if (prepared.closed) return prepared;
  warn(state, 'W_LOTTIE_OPEN_FILLED_PATH', prepared.sourcePath, 'Open filled path is closed with a straight segment.');
  const closeValues = (values: readonly number[]): number[] => [...values, values[0] ?? 0, values[1] ?? 0];
  if (!prepared.morph) return {
    commands: `${prepared.commands}LZ`,
    values: closeValues(prepared.values),
    closed: true,
    sourcePath: prepared.sourcePath,
  };
  const values: number[] = [];
  for (let frame = 0; frame < prepared.morph.times.length; frame++) {
    const start = frame * prepared.morph.valueSize;
    values.push(...closeValues(Array.from(prepared.morph.values).slice(start, start + prepared.morph.valueSize)));
  }
  return {
    commands: `${prepared.commands}LZ`,
    values: closeValues(prepared.values),
    closed: true,
    sourcePath: prepared.sourcePath,
    morph: {
      ...prepared.morph,
      values,
      valueSize: prepared.morph.valueSize + 2,
    },
  };
}

function createPaintedStaticPath(
  path: Pick<AnimationPath2DComponent, 'commands' | 'values'>,
  paint: LottiePaint,
  modifiers: readonly AnimationVectorPathModifier[],
  state: ConversionState,
): AnimationComponent[] {
  return createPaintedPath({ sourcePath: '$generated', commands: path.commands, values: Array.from(path.values), closed: path.commands.endsWith('Z') }, paint, modifiers, state);
}

function convertShapeModifier(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
): AnimationVectorPathModifier | null {
  if (shape.ty === 'tm') {
    const startTrack = createInlineTrack(shape.s, state, `${path}.s`, values => [(values[0] ?? 0) / 100]);
    const endTrack = createInlineTrack(shape.e, state, `${path}.e`, values => [(values[0] ?? 100) / 100]);
    const offsetTrack = createInlineTrack(shape.o, state, `${path}.o`, values => [(values[0] ?? 0) / 360]);
    return {
      kind: 'trim-path',
      start: readStaticScalar(shape.s, 0) / 100,
      end: readStaticScalar(shape.e, 100) / 100,
      offset: readStaticScalar(shape.o, 0) / 360,
      mode: shape.m === 2 ? 'individual' : 'simultaneous',
      ...(startTrack ? { startTrack } : {}),
      ...(endTrack ? { endTrack } : {}),
      ...(offsetTrack ? { offsetTrack } : {}),
    };
  }
  if (shape.ty === 'rd') {
    const radiusTrack = createInlineTrack(shape.r, state, `${path}.r`, values => [Math.max(0, values[0] ?? 0)]);
    return {
      kind: 'round-corners',
      radius: Math.max(0, readStaticScalar(shape.r, 0)),
      ...(radiusTrack ? { radiusTrack } : {}),
    };
  }
  return null;
}

function hasAnimatedStrokeStyle(stroke: LottieStrokeStyle): boolean {
  return stroke.colorTrack !== undefined || stroke.opacityTrack !== undefined || stroke.widthTrack !== undefined
    || stroke.dash !== undefined || stroke.dashOffsetTrack !== undefined || stroke.gradient !== undefined;
}

function toVectorStrokePaint(stroke: LottieStrokeStyle): AnimationVectorStrokePaint {
  const gradient = stroke.gradient;
  return {
    color: stroke.color,
    width: stroke.width,
    opacity: stroke.opacity,
    lineCap: stroke.lineCap === 2 ? 'round' : stroke.lineCap === 3 ? 'square' : 'butt',
    lineJoin: stroke.lineJoin === 2 ? 'round' : stroke.lineJoin === 3 ? 'bevel' : 'miter',
    miterLimit: stroke.miterLimit,
    ...(gradient ? { gradient } : {}),
    ...(stroke.dash ? { dash: stroke.dash } : {}),
    ...(stroke.dashOffset === undefined ? {} : { dashOffset: stroke.dashOffset }),
    ...(stroke.colorTrack ? { colorTrack: stroke.colorTrack } : {}),
    ...(stroke.opacityTrack ? { opacityTrack: stroke.opacityTrack } : {}),
    ...(stroke.widthTrack ? { widthTrack: stroke.widthTrack } : {}),
    ...(stroke.dashOffsetTrack ? { dashOffsetTrack: stroke.dashOffsetTrack } : {}),
  };
}

function convertStrokeStyle(shape: Record<string, unknown>, path: string, state: ConversionState): LottieStrokeStyle | null {
  const color = readStaticVector(shape.c, [0, 0, 0, 1]);
  const opacity = clamp(readStaticScalar(shape.o, 100) / 100, 0, 1);
  const initialWidth = readStaticScalar(shape.w, 0);
  const positiveWidth = readFirstPositiveVector(shape.w, 1)?.[0];
  if (initialWidth < 0 || (positiveWidth !== undefined && positiveWidth < 0)) {
    warn(state, 'W_LOTTIE_INVALID_STROKE', `${path}.w`, 'Stroke width cannot be negative.');
    return null;
  }
  // Zero is a valid, intentionally invisible stroke width. For an animated
  // zero-to-positive stroke, keep a positive base width for validation while
  // the inline track preserves the authored zero sample exactly.
  const width = initialWidth > 0 ? initialWidth : positiveWidth;
  if (width === undefined) return null;
  const colorTrack = createInlineTrack(shape.c, state, `${path}.c`, values => [
    clamp(values[0] ?? 0, 0, 1), clamp(values[1] ?? 0, 0, 1), clamp(values[2] ?? 0, 0, 1), clamp(values[3] ?? 1, 0, 1),
  ]);
  const opacityTrack = createInlineTrack(shape.o, state, `${path}.o`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
  const widthTrack = createInlineTrack(shape.w, state, `${path}.w`, values => [Math.max(0, values[0] ?? width)]);
  const dashEntries = list(shape.d).map(object);
  const dash = dashEntries.filter(entry => entry.n !== 'o').map((entry, index) => {
    if (isAnimated(entry.v)) warn(state, 'W_LOTTIE_ANIMATED_STROKE_DASH', `${path}.d[${index}].v`, 'Animated dash lengths are sampled at their initial value.');
    return Math.max(0, readStaticScalar(entry.v, 0));
  }).filter(value => value > 0);
  const offsetEntry = dashEntries.find(entry => entry.n === 'o');
  const dashOffset = offsetEntry ? readStaticScalar(offsetEntry.v, 0) : undefined;
  const dashOffsetTrack = offsetEntry ? createInlineTrack(offsetEntry.v, state, `${path}.d`, values => [values[0] ?? 0]) : undefined;
  return {
    color: [
      clamp(color[0] ?? 0, 0, 1),
      clamp(color[1] ?? 0, 0, 1),
      clamp(color[2] ?? 0, 0, 1),
      clamp(color[3] ?? 1, 0, 1),
    ],
    width,
    opacity,
    lineCap: shape.lc === 2 || shape.lc === 3 ? shape.lc : 1,
    lineJoin: shape.lj === 2 || shape.lj === 3 ? shape.lj : 1,
    miterLimit: Math.max(1, typeof shape.ml === 'number' && Number.isFinite(shape.ml) ? shape.ml : 4),
    ...(colorTrack ? { colorTrack } : {}),
    ...(opacityTrack ? { opacityTrack } : {}),
    ...(widthTrack ? { widthTrack } : {}),
    ...(dash.length > 0 ? { dash } : {}),
    ...(dashOffset === undefined ? {} : { dashOffset }),
    ...(dashOffsetTrack ? { dashOffsetTrack } : {}),
  };
}

function convertStrokePathComponents(
  value: unknown,
  stroke: LottieStrokeStyle,
  path: string,
  state: ConversionState,
  sourceComponent?: number,
): AnimationComponent[] {
  if (isAnimated(value)) {
    warn(state, 'W_LOTTIE_ANIMATED_PATH', path, 'Animated stroke path is sampled at its initial value.');
  }
  const shape = readStaticShape(value);
  const vertices = pointList(shape.v);
  const incoming = normalizedTangents(shape.i, vertices.length);
  const outgoing = normalizedTangents(shape.o, vertices.length);
  if (vertices.length < 2 || incoming.length !== vertices.length || outgoing.length !== vertices.length) {
    warn(state, 'W_LOTTIE_INVALID_PATH', path, 'Stroke path requires matching vertex, incoming-tangent and outgoing-tangent arrays.');
    return [];
  }
  let commands = 'M';
  const values: number[] = [...vertices[0]!];
  const closed = shape.c !== false;
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const fromIndex = segment;
    const toIndex = (segment + 1) % vertices.length;
    const from = vertices[fromIndex]!;
    const to = vertices[toIndex]!;
    const control1: [number, number] = [from[0] + outgoing[fromIndex]![0], from[1] + outgoing[fromIndex]![1]];
    const control2: [number, number] = [to[0] + incoming[toIndex]![0], to[1] + incoming[toIndex]![1]];
    if (samePair(control1, from) && samePair(control2, to)) {
      commands += 'L';
      values.push(...to);
      continue;
    }
    commands += 'C';
    values.push(...control1, ...control2, ...to);
  }
  if (closed) commands += 'Z';
  return [createStrokeExtensionComponent(commands, values, stroke, state, sourceComponent)];
}

function createStrokeComponents(
  points: ReadonlyArray<readonly [number, number]>,
  closed: boolean,
  stroke: LottieStrokeStyle,
  state: ConversionState,
): AnimationComponent[] {
  if (points.length < 2) return [];
  const commands = `M${'L'.repeat(points.length - 1)}${closed ? 'Z' : ''}`;
  return [createStrokeExtensionComponent(commands, points.flat(), stroke, state)];
}

function createStrokeExtensionComponent(
  commands: string,
  values: number[],
  stroke: LottieStrokeStyle,
  state: ConversionState,
  sourceComponent?: number,
): AnimationComponent {
  state.usesStrokeExtension = true;
  return {
    type: VECTOR_STROKE_EXTENSION,
    ...(sourceComponent === undefined ? { commands, values } : { sourceComponent }),
    color: [stroke.color[0], stroke.color[1], stroke.color[2], stroke.color[3] * stroke.opacity],
    width: stroke.width,
    lineCap: stroke.lineCap === 2 ? 'round' : stroke.lineCap === 3 ? 'square' : 'butt',
    lineJoin: stroke.lineJoin === 2 ? 'round' : stroke.lineJoin === 3 ? 'bevel' : 'miter',
    miterLimit: stroke.miterLimit,
    tolerance: 0.2,
  };
}

function rectanglePoints(width: number, height: number): Array<[number, number]> {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]];
}

function ellipsePoints(radiusX: number, radiusY: number): Array<[number, number]> {
  return Array.from({ length: 48 }, (_, index) => {
    const angle = index * Math.PI * 2 / 48;
    return [Math.cos(angle) * radiusX, Math.sin(angle) * radiusY] as [number, number];
  });
}

function roundedRectanglePath(width: number, height: number, authoredRadius: number): Pick<AnimationPath2DComponent, 'commands' | 'values'> {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const radius = Math.min(Math.max(0, authoredRadius), halfWidth, halfHeight);
  if (radius <= 1e-6) return {
    commands: 'MLLLZ',
    values: [-halfWidth, -halfHeight, halfWidth, -halfHeight, halfWidth, halfHeight, -halfWidth, halfHeight],
  };
  const k = radius * 0.5522847498307936;
  return {
    commands: 'MLCLCLCLCZ',
    values: [
      -halfWidth + radius, -halfHeight,
      halfWidth - radius, -halfHeight,
      halfWidth - radius + k, -halfHeight, halfWidth, -halfHeight + radius - k, halfWidth, -halfHeight + radius,
      halfWidth, halfHeight - radius,
      halfWidth, halfHeight - radius + k, halfWidth - radius + k, halfHeight, halfWidth - radius, halfHeight,
      -halfWidth + radius, halfHeight,
      -halfWidth + radius - k, halfHeight, -halfWidth, halfHeight - radius + k, -halfWidth, halfHeight - radius,
      -halfWidth, -halfHeight + radius,
      -halfWidth, -halfHeight + radius - k, -halfWidth + radius - k, -halfHeight, -halfWidth + radius, -halfHeight,
    ],
  };
}

function ellipsePath(radiusX: number, radiusY: number): Pick<AnimationPath2DComponent, 'commands' | 'values'> {
  const kx = radiusX * 0.5522847498307936;
  const ky = radiusY * 0.5522847498307936;
  return {
    commands: 'MCCCCZ',
    values: [
      0, -radiusY,
      kx, -radiusY, radiusX, -ky, radiusX, 0,
      radiusX, ky, kx, radiusY, 0, radiusY,
      -kx, radiusY, -radiusX, ky, -radiusX, 0,
      -radiusX, -ky, -kx, -radiusY, 0, -radiusY,
    ],
  };
}

function convertPolystarPath(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
): Pick<AnimationPath2DComponent, 'commands' | 'values'> | null {
  const points = Math.round(readStaticScalar(shape.pt, 0));
  const outerRadius = readStaticScalar(shape.or, 0);
  const star = shape.sy !== 2;
  const innerRadius = star ? readStaticScalar(shape.ir, 0) : outerRadius;
  if (points < 3 || outerRadius <= 0 || (star && innerRadius <= 0)) {
    warn(state, 'W_LOTTIE_INVALID_POLYSTAR', path, 'Polystar requires at least three points and positive radii.');
    return null;
  }
  if ([shape.pt, shape.or, shape.ir].some(isAnimated)) {
    warn(state, 'W_LOTTIE_ANIMATED_POLYSTAR_GEOMETRY', path, 'Animated polystar points and radii are sampled at their initial value.');
  }
  const innerRoundness = clamp(readStaticScalar(shape.is, 0) / 100, 0, 1);
  const outerRoundness = clamp(readStaticScalar(shape.os, 0) / 100, 0, 1);
  if (isAnimated(shape.is) || isAnimated(shape.os)) warn(state, 'W_LOTTIE_ANIMATED_POLYSTAR_ROUNDNESS', path, 'Animated polystar roundness is sampled at its initial value.');
  const vertexCount = star ? points * 2 : points;
  const direction = shape.d === 3 ? -1 : 1;
  const vertices: Array<[number, number]> = [];
  const roundness: number[] = [];
  for (let index = 0; index < vertexCount; index++) {
    const inner = star && (index & 1) === 1;
    const radius = inner ? innerRadius : outerRadius;
    const angle = -Math.PI / 2 + direction * index * Math.PI * 2 / vertexCount;
    vertices.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    roundness.push(inner ? innerRoundness : outerRoundness);
  }
  if (roundness.every(value => value <= 1e-6)) {
    return { commands: `M${'L'.repeat(vertexCount - 1)}Z`, values: vertices.flat() };
  }
  const entries = vertices.map((vertex, index) => {
    const previous = vertices[(index - 1 + vertexCount) % vertexCount]!;
    const next = vertices[(index + 1) % vertexCount]!;
    const factor = roundness[index]! * 0.25;
    return {
      vertex,
      enter: [vertex[0] + (previous[0] - vertex[0]) * factor, vertex[1] + (previous[1] - vertex[1]) * factor] as [number, number],
      exit: [vertex[0] + (next[0] - vertex[0]) * factor, vertex[1] + (next[1] - vertex[1]) * factor] as [number, number],
    };
  });
  let commands = 'M';
  const values: number[] = [...entries[0]!.enter];
  for (let index = 0; index < entries.length; index++) {
    const current = entries[index]!;
    if (index > 0) { commands += 'L'; values.push(...current.enter); }
    commands += 'Q'; values.push(...current.vertex, ...current.exit);
  }
  commands += 'LZ'; values.push(...entries[0]!.enter);
  return { commands, values };
}

function convertPolystar(
  shape: Record<string, unknown>,
  fill: readonly [number, number, number, number] | null,
  stroke: LottieStrokeStyle | null,
  path: string,
  parent: string,
  state: ConversionState,
): AnimationNode | null {
  const points = Math.round(readStaticScalar(shape.pt, 0));
  const outerRadius = readStaticScalar(shape.or, 0);
  const star = shape.sy !== 2;
  const innerRadius = star ? readStaticScalar(shape.ir, 0) : outerRadius;
  if (points < 3 || outerRadius <= 0 || (star && innerRadius <= 0)) {
    warn(state, 'W_LOTTIE_INVALID_POLYSTAR', path, 'Polystar requires at least three points and positive radii.');
    return null;
  }
  if ([shape.pt, shape.or, shape.ir].some(isAnimated)) {
    warn(state, 'W_LOTTIE_ANIMATED_POLYSTAR_GEOMETRY', path, 'Animated polystar points and radii are sampled at their initial value.');
  }
  if (isAnimated(shape.is) || isAnimated(shape.os)
    || Math.abs(readStaticScalar(shape.is, 0)) > 1e-6
    || Math.abs(readStaticScalar(shape.os, 0)) > 1e-6) {
    warn(state, 'W_LOTTIE_POLYSTAR_ROUNDNESS', path, 'Polystar roundness is not converted.');
  }
  const position = readStaticVector(shape.p, [0, 0]);
  const rotation = readStaticScalar(shape.r, 0);
  const vertexCount = star ? points * 2 : points;
  const direction = shape.d === 3 ? -1 : 1;
  const pointsList: Array<[number, number]> = [];
  for (let index = 0; index < vertexCount; index++) {
    const radius = star && (index & 1) === 1 ? innerRadius : outerRadius;
    const angle = -Math.PI / 2 + direction * index * Math.PI * 2 / vertexCount;
    pointsList.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  const id = `${parent}:shape:${state.shapeCounter++}`;
  appendTrack(shape.p, id, 'position', state, value => [value[0] ?? 0, value[1] ?? 0], `${path}.p`);
  appendTrack(shape.r, id, 'rotation', state, value => [degreesToRadians(value[0] ?? 0)], `${path}.r`);
  return {
    id,
    name: typeof shape.nm === 'string' ? shape.nm : id,
    parent,
    transform: {
      position: [position[0] ?? 0, position[1] ?? 0],
      rotation: degreesToRadians(rotation),
    },
    components: [
      ...(fill ? [{
        type: 'path2d' as const,
        commands: `M${'L'.repeat(vertexCount - 1)}Z`,
        values: pointsList.flat(),
        fill,
        fillRule: 'nonzero' as const,
      }] : []),
      ...(stroke ? createStrokeComponents(pointsList, true, stroke, state) : []),
    ],
  };
}

function diagnoseUnsupportedLayerFeatures(
  layer: Record<string, unknown>,
  path: string,
  type: number,
  state: ConversionState,
): void {
  if (layer.ddd === 1) warn(state, 'W_LOTTIE_3D_LAYER', `${path}.ddd`, '3D layer transforms are flattened to the supported 2D transform subset.');
  if (typeof layer.bm === 'number' && layer.bm !== 0) {
    warn(state, 'W_LOTTIE_BLEND_MODE', `${path}.bm`, `Layer blend mode ${layer.bm} is not represented by the HYA 2D renderer.`);
  }
  if (layer.ao === 1) warn(state, 'W_LOTTIE_AUTO_ORIENT', `${path}.ao`, 'Auto-orient along a motion path is not converted.');
  if (layer.tm !== undefined && (type !== 0 || !isAnimated(layer.tm))) {
    warn(
      state,
      'W_LOTTIE_TIME_REMAP',
      `${path}.tm`,
      type !== 0
        ? 'Time remapping is only supported for precomposition layers.'
        : 'Static time remapping cannot be represented by ordinary HYA transform tracks.',
    );
  }
  const position = object(object(layer.ks).p);
  if (position.s === true || position.x !== undefined || position.y !== undefined) {
    warn(state, 'W_LOTTIE_SPLIT_POSITION', `${path}.ks.p`, 'Separated position dimensions are sampled as the default position.');
  }
  const transform = object(layer.ks);
  if (isAnimated(transform.sk) || isAnimated(transform.sa)
    || Math.abs(readStaticScalar(transform.sk, 0)) > 1e-6
    || Math.abs(readStaticScalar(transform.sa, 0)) > 1e-6) {
    warn(state, 'W_LOTTIE_LAYER_SKEW', `${path}.ks`, 'Layer skew and skew axis are not converted.');
  }
}

function convertLayerEffects(value: unknown, layerPath: string, state: ConversionState): AnimationLayerEffect[] {
  const result: AnimationLayerEffect[] = [];
  const effects = list(value).map(object);
  for (let index = 0; index < effects.length; index++) {
    const effect = effects[index]!;
    const effectPath = `${layerPath}.ef[${index}]`;
    const name = normalizeEffectName(effect.nm ?? effect.mn);
    const parameters = list(effect.ef).map(object);
    if (name === 'tint') {
      const blackProperty = effectParameter(parameters, ['map black to', 'adbe tint-0001']);
      const whiteProperty = effectParameter(parameters, ['map white to', 'adbe tint-0002']);
      const amountProperty = effectParameter(parameters, ['amount to tint', 'adbe tint-0003']);
      if (!blackProperty || !whiteProperty || !amountProperty) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Tint requires Map Black To, Map White To and Amount to Tint parameters.');
        continue;
      }
      const black = readStaticVector(blackProperty, [0, 0, 0]);
      const white = readStaticVector(whiteProperty, [1, 1, 1]);
      const blackTrack = createInlineTrack(blackProperty, state, `${effectPath}.black`, values => rgb(values, [0, 0, 0]));
      const whiteTrack = createInlineTrack(whiteProperty, state, `${effectPath}.white`, values => rgb(values, [1, 1, 1]));
      const amountTrack = createInlineTrack(amountProperty, state, `${effectPath}.amount`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
      result.push({
        kind: 'tint', black: rgb(black, [0, 0, 0]), white: rgb(white, [1, 1, 1]),
        amount: clamp(readStaticScalar(amountProperty, 100) / 100, 0, 1),
        ...(blackTrack ? { blackTrack } : {}), ...(whiteTrack ? { whiteTrack } : {}), ...(amountTrack ? { amountTrack } : {}),
      });
      continue;
    }
    if (name === 'fill') {
      const colorProperty = effectParameter(parameters, ['color', 'adbe fill-0002']);
      const opacityProperty = effectParameter(parameters, ['opacity', 'adbe fill-0007']);
      if (!colorProperty) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Fill requires a Color parameter.');
        continue;
      }
      const initial = readStaticVector(colorProperty, [1, 1, 1, 1]);
      const colorTrack = createInlineTrack(colorProperty, state, `${effectPath}.color`, values => rgba(values));
      const opacityTrack = createInlineTrack(opacityProperty, state, `${effectPath}.opacity`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
      result.push({
        kind: 'fill', color: rgba(initial),
        opacity: clamp(readStaticScalar(opacityProperty, 100) / 100, 0, 1),
        ...(colorTrack ? { colorTrack } : {}), ...(opacityTrack ? { opacityTrack } : {}),
      });
      continue;
    }
    if (name.includes('gaussian blur') || name.includes('fast box blur') || name === 'blur') {
      const blurProperty = effectParameter(parameters, ['blurriness', 'blur', 'adbe gaussian blur 2-0001', 'adbe fast blur-0001']);
      const dimensions = Math.round(readStaticScalar(effectParameter(parameters, ['blur dimensions', 'dimensions']), 1));
      if (!blurProperty) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Blur requires a Blurriness parameter.');
        continue;
      }
      const toRadius = (values: readonly number[]) => dimensions === 2
        ? [0, Math.max(0, values[0] ?? 0)]
        : dimensions === 3 ? [Math.max(0, values[0] ?? 0), 0] : [Math.max(0, values[0] ?? 0), Math.max(0, values[0] ?? 0)];
      const radiusTrack = createInlineTrack(blurProperty, state, `${effectPath}.blur`, toRadius);
      result.push({ kind: 'blur', radius: toRadius([readStaticScalar(blurProperty, 0)]) as [number, number], ...(radiusTrack ? { radiusTrack } : {}) });
      continue;
    }
    if (name === 'drop shadow' || name.includes('drop shadow')) {
      const colorProperty = effectParameter(parameters, ['shadow color', 'color', 'adbe drop shadow-0001']);
      const opacityProperty = effectParameter(parameters, ['opacity', 'adbe drop shadow-0002']);
      const directionProperty = effectParameter(parameters, ['direction', 'adbe drop shadow-0003']);
      const distanceProperty = effectParameter(parameters, ['distance', 'adbe drop shadow-0004']);
      const blurProperty = effectParameter(parameters, ['softness', 'blur', 'adbe drop shadow-0005']);
      if (!colorProperty) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Drop Shadow requires a Shadow Color parameter.');
        continue;
      }
      if (isAnimated(directionProperty) || isAnimated(distanceProperty)) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Animated Drop Shadow direction/distance requires coupled sampling and is held at its first value.');
      }
      const direction = degreesToRadians(readStaticScalar(directionProperty, 135));
      const distance = Math.max(0, readStaticScalar(distanceProperty, 0));
      const initial = readStaticVector(colorProperty, [0, 0, 0, 1]);
      const colorTrack = createInlineTrack(colorProperty, state, `${effectPath}.color`, values => rgba(values, [0, 0, 0, 1]));
      const opacityTrack = createInlineTrack(opacityProperty, state, `${effectPath}.opacity`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
      const blurTrack = createInlineTrack(blurProperty, state, `${effectPath}.blur`, values => [Math.max(0, values[0] ?? 0)]);
      result.push({
        kind: 'drop-shadow', color: rgba(initial, [0, 0, 0, 1]),
        opacity: clamp(readStaticScalar(opacityProperty, 100) / 100, 0, 1),
        offset: [Math.cos(direction) * distance, Math.sin(direction) * distance],
        blur: Math.max(0, readStaticScalar(blurProperty, 0)),
        ...(colorTrack ? { colorTrack } : {}), ...(opacityTrack ? { opacityTrack } : {}), ...(blurTrack ? { blurTrack } : {}),
      });
      continue;
    }
    if (name === 'opacity') {
      const opacityProperty = effectParameter(parameters, ['opacity', 'amount']);
      if (!opacityProperty) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Opacity effect requires an Opacity parameter.');
        continue;
      }
      const opacityTrack = createInlineTrack(opacityProperty, state, `${effectPath}.opacity`, values => [clamp((values[0] ?? 100) / 100, 0, 1)]);
      result.push({ kind: 'opacity', opacity: clamp(readStaticScalar(opacityProperty, 100) / 100, 0, 1), ...(opacityTrack ? { opacityTrack } : {}) });
      continue;
    }
    if (name === 'color matrix') {
      const matrixProperty = effectParameter(parameters, ['matrix', 'color matrix']);
      const matrix = readStaticVector(matrixProperty, []);
      if (matrix.length !== 20) {
        warn(state, 'W_LOTTIE_EFFECT_PARAM', effectPath, 'Color Matrix requires exactly 20 values.');
        continue;
      }
      const matrixTrack = createInlineTrack(matrixProperty, state, `${effectPath}.matrix`, values => values.slice(0, 20));
      result.push({ kind: 'color-matrix', matrix: matrix.slice(0, 20), ...(matrixTrack ? { matrixTrack } : {}) });
      continue;
    }
    warn(state, 'W_LOTTIE_EFFECT', effectPath, `Layer effect "${typeof effect.nm === 'string' ? effect.nm : String(effect.ty)}" is not converted.`);
  }
  return result;
}

function normalizeEffectName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function effectParameter(parameters: readonly Record<string, unknown>[], names: readonly string[]): unknown {
  const normalized = names.map(name => name.toLowerCase());
  return parameters.find(parameter => {
    const name = normalizeEffectName(parameter.nm);
    const matchName = normalizeEffectName(parameter.mn);
    return normalized.includes(name) || normalized.includes(matchName);
  })?.v;
}

function rgb(values: readonly number[], fallback: readonly [number, number, number]): [number, number, number] {
  return [
    clamp(values[0] ?? fallback[0], 0, 1),
    clamp(values[1] ?? fallback[1], 0, 1),
    clamp(values[2] ?? fallback[2], 0, 1),
  ];
}

function rgba(values: readonly number[], fallback: readonly [number, number, number, number] = [1, 1, 1, 1]): [number, number, number, number] {
  return [
    clamp(values[0] ?? fallback[0], 0, 1), clamp(values[1] ?? fallback[1], 0, 1),
    clamp(values[2] ?? fallback[2], 0, 1), clamp(values[3] ?? fallback[3], 0, 1),
  ];
}

function applyTint(
  color: readonly [number, number, number, number],
  tint: LottieTintEffect | null,
): readonly [number, number, number, number] {
  if (!tint || tint.amount <= 0) return color;
  const luminance = clamp(color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722, 0, 1);
  return [
    color[0] + (tint.black[0] + (tint.white[0] - tint.black[0]) * luminance - color[0]) * tint.amount,
    color[1] + (tint.black[1] + (tint.white[1] - tint.black[1]) * luminance - color[1]) * tint.amount,
    color[2] + (tint.black[2] + (tint.white[2] - tint.black[2]) * luminance - color[2]) * tint.amount,
    color[3],
  ];
}

function convertLayerComposite(
  layer: Record<string, unknown>,
  sourceIndex: number,
  layerValues: unknown[],
  layerIds: ReadonlyMap<number, string>,
  layerId: string,
  path: string,
  listPath: string,
  state: ConversionState,
  compositionWidth: number,
  compositionHeight: number,
): { value?: AnimationNode['composite']; nodes: AnimationNode[] } {
  const matteType = layer.tt === undefined ? 0 : integer(layer.tt, `${path}.tt`);
  const masks = convertMasks(
    layer.masksProperties,
    layerId,
    path,
    state,
    matteType > 0 ? 7 : 8,
    compositionWidth,
    compositionHeight,
  );
  if (matteType === 0) return masks;
  if (matteType < 1 || matteType > 4) {
    warn(state, 'W_LOTTIE_UNSUPPORTED_MATTE', `${path}.tt`, `Track matte type ${matteType} is not supported.`);
    return masks;
  }
  const explicitSource = layer.tp === undefined ? undefined : integer(layer.tp, `${path}.tp`);
  const sourceLayer = object(layerValues[sourceIndex - 1]);
  const sourceLayerIndex = explicitSource ?? (sourceIndex > 0
    ? integer(sourceLayer.ind ?? sourceIndex, `${listPath}[${sourceIndex - 1}].ind`)
    : undefined);
  const source = sourceLayerIndex === undefined ? undefined : layerIds.get(sourceLayerIndex);
  if (!source) {
    warn(state, 'W_LOTTIE_MISSING_MATTE_SOURCE', `${path}.tt`, 'Track matte source layer was not found immediately before the target layer.');
    return masks;
  }
  const matte: AnimationCompositeLayer = {
    kind: 'matte',
    source,
    mode: matteType === 2 ? 'alpha-inverted' : matteType === 3 ? 'luma' : matteType === 4 ? 'luma-inverted' : 'alpha',
    operation: masks.value ? 'intersect' : 'add',
  };
  const layers = [...compositeLayers(masks.value), matte];
  return { value: compactComposite(layers), nodes: masks.nodes };
}

function convertMasks(
  value: unknown,
  layerId: string,
  path: string,
  state: ConversionState,
  layerBudget: number,
  compositionWidth: number,
  compositionHeight: number,
): { value?: AnimationNode['composite']; nodes: AnimationNode[] } {
  const masks = list(value).map((entry, sourceIndex) => ({ mask: object(entry), sourceIndex }))
    .filter(entry => entry.mask.hd !== true && entry.mask.mode !== 'n');
  if (masks.length === 0) return { nodes: [] };
  const supported = masks.filter(({ mask, sourceIndex }) => {
    if (mask.mode === undefined || ['a', 's', 'i', 'f'].includes(String(mask.mode))) return true;
    warn(state, 'W_LOTTIE_MASK_MODE', `${path}.masksProperties[${sourceIndex}].mode`, `Mask mode "${String(mask.mode)}" is not recognized.`);
    return false;
  });
  if (supported.length === 0) return { nodes: [] };
  const nodes: AnimationNode[] = [];
  const layers: AnimationCompositeLayer[] = [];
  for (let index = 0; index < supported.length; index++) {
    const { mask, sourceIndex } = supported[index]!;
    const maskPath = `${path}.masksProperties[${sourceIndex}]`;
    const source = `${layerId}:mask:${state.shapeCounter++}`;
    const opacity = clamp(readStaticScalar(mask.o, 100) / 100, 0, 1);
    const feather = readStaticVector(mask.f, [0, 0]);
    const expansion = readStaticScalar(mask.x, 0);
    const expansionTrack = createInlineTrack(
      mask.x,
      state,
      `${maskPath}.x`,
      values => [values[0] ?? 0],
    );
    if (isAnimated(mask.f)) warn(state, 'W_LOTTIE_ANIMATED_MASK_FEATHER', `${maskPath}.f`, 'Animated mask feather is sampled at its initial value.');
    const animatedPath = isAnimated(mask.pt);
    const animatedOpacity = isAnimated(mask.o);
    const components: AnimationComponent[] = [];
    const childNodes: AnimationNode[] = [];
    if (!animatedPath && !animatedOpacity) {
      const component = convertPathComponent(mask.pt, [1, 1, 1, opacity], `${maskPath}.pt`, state);
      if (component) components.push(component);
    } else {
      const maskNodeId = `${layerId}:mask-entry:${state.shapeCounter++}`;
      const maskNode: AnimationNode = {
        id: maskNodeId,
        name: `${layerId} mask ${index}`,
        parent: source,
        transform: { opacity },
      };
      if (animatedOpacity) {
        appendTrack(
          mask.o,
          maskNodeId,
          'opacity',
          state,
          values => [clamp((values[0] ?? 100) / 100, 0, 1)],
          `${maskPath}.o`,
        );
      }
      const component = convertPathComponent(mask.pt, [1, 1, 1, 1], `${maskPath}.pt`, state);
      if (component) maskNode.components = [component];
      childNodes.push(maskNode);
    }
    if (components.length === 0 && childNodes.length === 0) continue;
    nodes.push({ id: source, name: `${layerId} mask ${index}`, parent: layerId, ...(components.length > 0 ? { components } : {}) }, ...childNodes);
    layers.push({
      kind: 'mask',
      source,
      mode: mask.inv === true ? 'alpha-inverted' : 'alpha',
      operation: mask.mode === 's' ? 'subtract' : mask.mode === 'i' ? 'intersect' : mask.mode === 'f' ? 'difference' : 'add',
      ...(feather.some(value => Math.abs(value) > 1e-6) ? { feather: [Math.abs(feather[0] ?? 0), Math.abs(feather[1] ?? feather[0] ?? 0)] } : {}),
      ...(Math.abs(expansion) > 1e-6 ? { expansion } : {}),
      ...(expansionTrack ? { expansionTrack } : {}),
    });
  }
  if (layers.length === 0) return { nodes: [] };
  const nested = nestCompositeLayers(
    layers,
    layerBudget,
    layerId,
    state,
    compositionWidth,
    compositionHeight,
  );
  nodes.push(...nested.nodes);
  return { value: compactComposite(nested.layers), nodes };
}

function nestCompositeLayers(
  sourceLayers: readonly AnimationCompositeLayer[],
  finalLayerBudget: number,
  layerId: string,
  state: ConversionState,
  compositionWidth: number,
  compositionHeight: number,
): { readonly layers: readonly AnimationCompositeLayer[]; readonly nodes: readonly AnimationNode[] } {
  const remaining = [...sourceLayers];
  const nodes: AnimationNode[] = [];
  let previousSource: string | undefined;
  while (remaining.length + (previousSource ? 1 : 0) > finalLayerBudget) {
    const capacity = previousSource ? 7 : 8;
    const chunk = remaining.splice(0, capacity);
    const compositeLayers: AnimationCompositeLayer[] = [
      ...(previousSource ? [{
        kind: 'mask' as const,
        source: previousSource,
        mode: 'alpha' as const,
        operation: 'add' as const,
      }] : []),
      ...chunk,
    ];
    const id = `${layerId}:mask-stack:${state.shapeCounter++}`;
    nodes.push({
      id,
      name: `${layerId} mask stack`,
      composite: compactComposite(compositeLayers),
      components: [{
        type: 'shape2d',
        shape: 'rect',
        size: [compositionWidth, compositionHeight],
        position: [compositionWidth / 2, compositionHeight / 2],
        fill: [1, 1, 1, 1],
      }],
    });
    previousSource = id;
  }
  return {
    layers: [
      ...(previousSource ? [{
        kind: 'mask' as const,
        source: previousSource,
        mode: 'alpha' as const,
        operation: 'add' as const,
      }] : []),
      ...remaining,
    ],
    nodes,
  };
}

function compactComposite(layers: readonly AnimationCompositeLayer[]): NonNullable<AnimationNode['composite']> {
  if (layers.length !== 1) return { layers };
  const layer = layers[0]!;
  return layer.operation === undefined || layer.operation === 'add'
    ? {
      kind: layer.kind,
      source: layer.source,
      mode: layer.mode,
      ...(layer.feather ? { feather: layer.feather } : {}),
      ...(layer.expansion === undefined ? {} : { expansion: layer.expansion }),
      ...(layer.expansionTrack === undefined ? {} : { expansionTrack: layer.expansionTrack }),
    }
    : layer;
}

function compositeLayers(value: AnimationNode['composite'] | undefined): readonly AnimationCompositeLayer[] {
  if (!value) return [];
  return 'layers' in value ? value.layers : [value];
}

function convertPathComponent(
  value: unknown,
  fill: readonly [number, number, number, number],
  path: string,
  state: ConversionState,
): AnimationComponent | null {
  if (isAnimated(value)) {
    const diagnosticStart = state.diagnostics.length;
    const morph = convertAnimatedPathData(value, path, state);
    if (morph) {
      state.usesPathMorphExtension = true;
      return {
        type: VECTOR_PATH_MORPH_EXTENSION,
        ...morph,
        fill,
        fillRule: 'nonzero',
      };
    }
    if (!state.diagnostics.slice(diagnosticStart).some(diagnostic => diagnostic.code === 'W_LOTTIE_PATH_TOPOLOGY')) {
      warn(state, 'W_LOTTIE_ANIMATED_PATH', path, 'Animated path cannot be represented and is sampled at its initial value.');
    }
  }
  const shape = readStaticShape(value);
  const converted = convertShapePath(shape, path, state);
  if (!converted) return null;
  return { type: 'path2d', ...converted, fill, fillRule: 'nonzero' };
}

function convertAnimatedPathData(
  value: unknown,
  path: string,
  state: ConversionState,
  closeOpen = true,
): LottieAnimatedPathData | null {
  const keyframes = list(object(value).k).map(object);
  const times: number[] = [];
  const shapes: Record<string, unknown>[] = [];
  const sourceFrames: Record<string, unknown>[] = [];
  let previousShape: Record<string, unknown> | null = null;
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index]!;
    const rawShape = list(keyframe.s)[0] ?? keyframe.s ?? list(keyframes[index - 1]?.e)[0] ?? previousShape;
    const shape = object(rawShape);
    if (Object.keys(shape).length === 0) continue;
    // HYA stores timeline data as Float32. De-duplicate after the storage
    // conversion so composition-boundary keyframes cannot collapse into an
    // invalid equal-time pair during binary validation.
    const time = Math.fround(clamp(frameToSeconds(state.timeline, finite(keyframe.t, `${path}.k[${index}].t`)), 0, state.duration));
    if (times.length > 0 && time <= times.at(-1)!) continue;
    times.push(time);
    shapes.push(shape);
    sourceFrames.push(keyframe);
    previousShape = object(list(keyframe.e)[0] ?? keyframe.e ?? shape);
  }
  if (times.length === 0) return null;
  const normalized = normalizeAnimatedPathTopology(shapes, path, state, closeOpen);
  if (!normalized) return null;
  const values = normalized.frames.flatMap(frame => frame.map(quantizeAnimatedPathCoordinate));
  const commands = normalized.commands;
  const valueSize = normalized.frames[0]!.length;
  const allHold = sourceFrames.length > 1 && sourceFrames.slice(0, -1).every(frame => frame.h === 1);
  const interpolation = allHold ? 'step' : times.length > 1 ? 'cubic-bezier' : 'linear';
  const easings: number[] = [];
  if (interpolation === 'cubic-bezier') {
    for (let index = 0; index < times.length - 1; index++) {
      const frame = sourceFrames[index]!;
      const outgoing = object(frame.o);
      const incoming = object(frame.i);
      easings.push(
        clamp(firstNumber(outgoing.x, 0.333), 0, 1), firstNumber(outgoing.y, 0.333),
        clamp(firstNumber(incoming.x, 0.667), 0, 1), firstNumber(incoming.y, 0.667),
      );
    }
  }
  return {
    commands,
    times,
    values,
    valueSize,
    interpolation,
    ...(easings.length > 0 ? { easings } : {}),
    tolerance: 0.35,
  };
}

/**
 * Lottie permits a segment to switch between a line and a cubic curve while
 * keeping the same authored vertices. HYA morph tracks intentionally have one
 * command stream, so every segment is represented canonically as a cubic. If
 * exporters genuinely change the vertex count, exact de Casteljau subdivision
 * raises every frame to the largest segment count without flattening curves.
 */
function normalizeAnimatedPathTopology(
  shapes: readonly Record<string, unknown>[],
  path: string,
  state: ConversionState,
  closeOpen: boolean,
): { readonly commands: string; readonly frames: readonly number[][] } | null {
  const contours: LottieCubicContour[] = [];
  for (let index = 0; index < shapes.length; index++) {
    const contour = lottieShapeToCubicContour(shapes[index]!, closeOpen);
    if (!contour) {
      warn(state, 'W_LOTTIE_INVALID_PATH', `${path}.k[${index}].s`, 'Animated path requires matching vertices and tangent arrays.');
      return null;
    }
    contours.push(contour);
  }
  const closed = contours[0]!.closed;
  if (contours.some(contour => contour.closed !== closed)) {
    warn(state, 'W_LOTTIE_PATH_TOPOLOGY', path, 'Animated path changes between open and closed topology.');
    return null;
  }
  const segmentCount = Math.max(...contours.map(contour => contour.segments.length));
  if (segmentCount < 1 || segmentCount > MAX_ANIMATED_PATH_SEGMENTS) {
    warn(
      state,
      'W_LOTTIE_PATH_TOPOLOGY',
      path,
      `Animated path requires ${segmentCount} canonical segments; the safe budget is ${MAX_ANIMATED_PATH_SEGMENTS}.`,
    );
    return null;
  }
  const normalized = contours.map(contour => subdivideContour(contour, segmentCount));
  const reference = normalized[0]!;
  for (let index = 1; index < normalized.length; index++) {
    normalized[index] = alignCubicContour(normalized[index]!, reference);
  }
  return {
    commands: `M${'C'.repeat(segmentCount)}${closed ? 'Z' : ''}`,
    frames: normalized.map(contour => [
      ...contour.segments[0]!.start,
      ...contour.segments.flatMap(segment => [...segment.control1, ...segment.control2, ...segment.end]),
    ]),
  };
}

function lottieShapeToCubicContour(
  shape: Record<string, unknown>,
  closeOpen: boolean,
): LottieCubicContour | null {
  const vertices = pointList(shape.v);
  const incoming = normalizedTangents(shape.i, vertices.length);
  const outgoing = normalizedTangents(shape.o, vertices.length);
  if (vertices.length < 2 || incoming.length !== vertices.length || outgoing.length !== vertices.length) return null;
  const authoredClosed = shape.c !== false;
  const closed = authoredClosed || closeOpen;
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  const segments: LottieCubicSegment[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const next = (index + 1) % vertices.length;
    const start = vertices[index]!;
    const end = vertices[next]!;
    const authoredSegment = authoredClosed || next !== 0;
    segments.push({
      start,
      control1: authoredSegment
        ? [start[0] + outgoing[index]![0], start[1] + outgoing[index]![1]]
        : start,
      control2: authoredSegment
        ? [end[0] + incoming[next]![0], end[1] + incoming[next]![1]]
        : end,
      end,
    });
  }
  return { closed, segments };
}

function subdivideContour(contour: LottieCubicContour, segmentCount: number): LottieCubicContour {
  const segments = [...contour.segments];
  while (segments.length < segmentCount) {
    let longest = 0;
    let longestLength = -Infinity;
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const length = pointDistance(segment.start, segment.control1)
        + pointDistance(segment.control1, segment.control2)
        + pointDistance(segment.control2, segment.end);
      if (length > longestLength) { longest = index; longestLength = length; }
    }
    segments.splice(longest, 1, ...splitCubicSegment(segments[longest]!));
  }
  return { closed: contour.closed, segments };
}

function splitCubicSegment(segment: LottieCubicSegment): readonly [LottieCubicSegment, LottieCubicSegment] {
  const a = midpointPair(segment.start, segment.control1);
  const b = midpointPair(segment.control1, segment.control2);
  const c = midpointPair(segment.control2, segment.end);
  const d = midpointPair(a, b);
  const e = midpointPair(b, c);
  const middle = midpointPair(d, e);
  return [
    { start: segment.start, control1: a, control2: d, end: middle },
    { start: middle, control1: e, control2: c, end: segment.end },
  ];
}

function alignCubicContour(contour: LottieCubicContour, reference: LottieCubicContour): LottieCubicContour {
  let candidate = contour;
  if (contour.closed) {
    if (Math.sign(cubicContourArea(candidate)) !== Math.sign(cubicContourArea(reference))) {
      candidate = reverseCubicContour(candidate);
    }
    let bestOffset = 0;
    let bestDistance = Infinity;
    for (let offset = 0; offset < candidate.segments.length; offset++) {
      let distance = 0;
      for (let index = 0; index < reference.segments.length; index++) {
        distance += squaredPointDistance(
          reference.segments[index]!.start,
          candidate.segments[(index + offset) % candidate.segments.length]!.start,
        );
      }
      if (distance < bestDistance) { bestDistance = distance; bestOffset = offset; }
    }
    if (bestOffset > 0) candidate = {
      closed: true,
      segments: [...candidate.segments.slice(bestOffset), ...candidate.segments.slice(0, bestOffset)],
    };
    return candidate;
  }
  const forward = squaredPointDistance(reference.segments[0]!.start, candidate.segments[0]!.start)
    + squaredPointDistance(reference.segments.at(-1)!.end, candidate.segments.at(-1)!.end);
  const reversed = squaredPointDistance(reference.segments[0]!.start, candidate.segments.at(-1)!.end)
    + squaredPointDistance(reference.segments.at(-1)!.end, candidate.segments[0]!.start);
  return reversed < forward ? reverseCubicContour(candidate) : candidate;
}

function reverseCubicContour(contour: LottieCubicContour): LottieCubicContour {
  return {
    closed: contour.closed,
    segments: [...contour.segments].reverse().map(segment => ({
      start: segment.end,
      control1: segment.control2,
      control2: segment.control1,
      end: segment.start,
    })),
  };
}

function cubicContourArea(contour: LottieCubicContour): number {
  let area = 0;
  for (const segment of contour.segments) {
    area += segment.start[0] * segment.end[1] - segment.end[0] * segment.start[1];
  }
  return area / 2;
}

function midpointPair(a: LottiePoint, b: LottiePoint): LottiePoint {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function pointDistance(a: LottiePoint, b: LottiePoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function squaredPointDistance(a: LottiePoint, b: LottiePoint): number {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  return x * x + y * y;
}

function quantizeAnimatedPathCoordinate(value: number): number {
  return Math.round(value / ANIMATED_PATH_QUANTIZATION) * ANIMATED_PATH_QUANTIZATION;
}

function convertShapePath(
  shape: Record<string, unknown>,
  path: string,
  state: ConversionState,
  diagnose = true,
  closeOpen = true,
): Pick<AnimationPath2DComponent, 'commands' | 'values'> | null {
  const vertices = pointList(shape.v);
  const incoming = normalizedTangents(shape.i, vertices.length);
  const outgoing = normalizedTangents(shape.o, vertices.length);
  // Two cubic vertices can form a valid closed lens/oval. Older Bodymovin
  // exporters use this compact form heavily for masks.
  if (vertices.length < 2 || incoming.length !== vertices.length || outgoing.length !== vertices.length) {
    if (diagnose) warn(state, 'W_LOTTIE_INVALID_PATH', path, 'Path requires matching vertex, incoming-tangent and outgoing-tangent arrays.');
    return null;
  }
  let commands = 'M';
  const values: number[] = [...vertices[0]!];
  const closed = shape.c !== false;
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const fromIndex = segment;
    const toIndex = (segment + 1) % vertices.length;
    const from = vertices[fromIndex]!;
    const to = vertices[toIndex]!;
    const control1: [number, number] = [from[0] + outgoing[fromIndex]![0], from[1] + outgoing[fromIndex]![1]];
    const control2: [number, number] = [to[0] + incoming[toIndex]![0], to[1] + incoming[toIndex]![1]];
    if (samePair(control1, from) && samePair(control2, to)) {
      commands += 'L';
      values.push(...to);
    } else {
      commands += 'C';
      values.push(...control1, ...control2, ...to);
    }
  }
  if (!closed && closeOpen) {
    if (diagnose) warn(state, 'W_LOTTIE_OPEN_FILLED_PATH', path, 'Open filled path is closed with a straight segment.');
    commands += 'L';
    values.push(...vertices[0]!);
  }
  if (closed || closeOpen) commands += 'Z';
  return { commands, values };
}

function readStaticShape(value: unknown): Record<string, unknown> {
  const property = object(value);
  if (isAnimated(property)) {
    const first = object(list(property.k)[0]);
    const start = list(first.s)[0];
    return object(start ?? first.s);
  }
  return object(property.k ?? value);
}

function pointList(value: unknown): Array<[number, number]> {
  return list(value).map(item => {
    const pair = numberList(item);
    return [pair[0] ?? 0, pair[1] ?? 0] as [number, number];
  });
}

function normalizedTangents(value: unknown, vertexCount: number): Array<[number, number]> {
  const points = pointList(value);
  if (points.length === 0 && vertexCount > 0) {
    return Array.from({ length: vertexCount }, () => [0, 0] as [number, number]);
  }
  return points;
}

function samePair(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function shapePathFor(_values: unknown[], index: number, listPath: string): string {
  return `${listPath}[${index}]`;
}

function appendTrack(
  property: unknown,
  node: string,
  target: AnimationTrackProperty,
  state: ConversionState,
  mapValue: (value: number[]) => number[],
  path: string,
): void {
  const track = createInlineTrack(property, state, path, mapValue);
  if (track) state.tracks.push({
    node,
    property: target,
    interpolation: track.interpolation,
    times: track.times,
    values: track.values,
    ...(track.easings ? { easings: track.easings } : {}),
    ...(target === 'position' && track.spatialTangents ? { spatialTangents: track.spatialTangents } : {}),
  });
}

function createInlineTrack(
  property: unknown,
  state: ConversionState,
  path: string,
  mapValue: (value: number[]) => number[],
): LottieInlineTrack | undefined {
  if (!isAnimated(property)) return undefined;
  const descriptor = object(property);
  const keyframes = list(descriptor.k).map(object);
  const times: number[] = [];
  const values: number[] = [];
  const sourceFrames: Record<string, unknown>[] = [];
  let previousValue: number[] | null = null;
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index]!;
    const frame = finite(keyframe.t, `${path}.k[${index}].t`);
    const startValue = numberList(keyframe.s);
    const raw: number[] = startValue.length > 0
      ? startValue
      : previousValue ?? numberList(keyframes[index - 1]?.e);
    if (raw.length === 0) continue;
    const time = Math.fround(clamp(frameToSeconds(state.timeline, frame), 0, state.duration));
    if (times.length > 0 && time <= times[times.length - 1]!) continue;
    const mapped = mapValue(raw);
    times.push(time);
    values.push(...mapped);
    sourceFrames.push(keyframe);
    previousValue = numberList(keyframe.e).length > 0 ? numberList(keyframe.e) : raw;
  }
  if (times.length < 1) {
    warn(state, 'W_LOTTIE_EMPTY_TRACK', path, 'Animated property contains no usable keyframes.');
    return undefined;
  }
  const allHold = sourceFrames.length > 1 && sourceFrames.slice(0, -1).every(frame => frame.h === 1);
  if (allHold) {
    return { times, values, valueSize: values.length / times.length, interpolation: 'step' };
  }
  const easings: number[] = [];
  const spatialTangents: number[] = [];
  let hasSpatialTangents = false;
  for (let index = 0; index < times.length - 1; index++) {
    const frame = sourceFrames[index]!;
    const outgoing = object(frame.o);
    const incoming = object(frame.i);
    easings.push(
      clamp(firstNumber(outgoing.x, 0.333), 0, 1), firstNumber(outgoing.y, 0.333),
      clamp(firstNumber(incoming.x, 0.667), 0, 1), firstNumber(incoming.y, 0.667),
    );
    if (values.length / times.length === 2) {
      const outgoingSpatial = numberList(frame.to);
      const incomingSpatial = numberList(frame.ti);
      const authored = [...outgoingSpatial, ...incomingSpatial].some(value => Math.abs(value) > 1e-8);
      hasSpatialTangents ||= authored;
      if (authored) {
        spatialTangents.push(
          outgoingSpatial[0] ?? 0, outgoingSpatial[1] ?? 0,
          incomingSpatial[0] ?? 0, incomingSpatial[1] ?? 0,
        );
      } else {
        const offset = index * 2;
        const dx = ((values[offset + 2] ?? values[offset] ?? 0) - (values[offset] ?? 0)) / 3;
        const dy = ((values[offset + 3] ?? values[offset + 1] ?? 0) - (values[offset + 1] ?? 0)) / 3;
        spatialTangents.push(dx, dy, -dx, -dy);
      }
    }
  }
  return {
    times,
    values,
    valueSize: values.length / times.length,
    interpolation: times.length > 1 ? 'cubic-bezier' : 'linear',
    ...(times.length > 1 ? { easings } : {}),
    ...(times.length > 1 && hasSpatialTangents ? { spatialTangents } : {}),
  };
}

function frameToSeconds(timeline: LottieTimeline, frame: number): number {
  return timeline.mapFrameToSeconds?.(frame) ?? timeline.secondsOffset + frame * timeline.secondsPerFrame;
}

function createTimeRemappedTimeline(
  property: unknown,
  parentTimeline: LottieTimeline,
  assetFrameRate: number,
  path: string,
  state: ConversionState,
): LottieTimeline | null {
  if (!isAnimated(property)) {
    warn(state, 'W_LOTTIE_TIME_REMAP', path, 'Static time remapping cannot be represented by ordinary HYA transform tracks.');
    return null;
  }
  const keyframes = list(object(property).k).map(object);
  if (keyframes.length < 2) {
    warn(state, 'W_LOTTIE_TIME_REMAP', path, 'Time remapping requires at least two scalar keyframes.');
    return null;
  }
  const samples: Array<{ frame: number; value: number }> = [];
  for (let index = 0; index < keyframes.length; index++) {
    const keyframe = keyframes[index]!;
    if (typeof keyframe.t !== 'number' || !Number.isFinite(keyframe.t)) {
      warn(state, 'W_LOTTIE_TIME_REMAP', `${path}.k[${index}].t`, 'Time-remap keyframe time must be finite.');
      return null;
    }
    const value = firstNumber(keyframe.s, Number.NaN);
    if (Number.isFinite(value)) samples.push({ frame: keyframe.t, value });
  }
  if (samples.length < 1) {
    warn(state, 'W_LOTTIE_TIME_REMAP', path, 'Time remapping contains no scalar keyframe values.');
    return null;
  }
  const finalFrame = finite(keyframes.at(-1)!.t, `${path}.k[${keyframes.length - 1}].t`);
  const lastSegment = keyframes[Math.max(0, keyframes.length - 2)]!;
  const finalValue = firstNumber(
    keyframes.at(-1)!.s,
    firstNumber(lastSegment.e, samples.at(-1)!.value),
  );
  if (finalFrame > samples.at(-1)!.frame) samples.push({ frame: finalFrame, value: finalValue });
  for (let index = 1; index < samples.length; index++) {
    if (samples[index]!.frame <= samples[index - 1]!.frame || samples[index]!.value + 1e-6 < samples[index - 1]!.value) {
      warn(
        state,
        'W_LOTTIE_TIME_REMAP',
        path,
        'Non-monotonic time remapping requires runtime time-warp support and was not converted.',
      );
      return null;
    }
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const sourceSecondsAtParentFrame = (frame: number): number => {
    if (frame <= first.frame) return first.value;
    if (frame >= last.frame) return last.value;
    let segment = 0;
    while (segment + 1 < samples.length && frame >= samples[segment + 1]!.frame) segment++;
    const from = samples[segment]!;
    const to = samples[segment + 1]!;
    const keyframe = keyframes[Math.min(segment, keyframes.length - 1)]!;
    if (keyframe.h === 1 || to.frame <= from.frame) return from.value;
    const linearProgress = clamp((frame - from.frame) / (to.frame - from.frame), 0, 1);
    const progress = cubicBezierProgress(
      linearProgress,
      clamp(firstNumber(object(keyframe.o).x, 0.333), 0, 1),
      firstNumber(object(keyframe.o).y, 0.333),
      clamp(firstNumber(object(keyframe.i).x, 0.667), 0, 1),
      firstNumber(object(keyframe.i).y, 0.667),
    );
    return from.value + (to.value - from.value) * progress;
  };
  const parentFrameForSourceSeconds = (sourceSeconds: number): number => {
    if (sourceSeconds <= first.value) return first.frame;
    if (sourceSeconds >= last.value) return last.frame;
    let low = first.frame;
    let high = last.frame;
    for (let iteration = 0; iteration < 28; iteration++) {
      const middle = (low + high) / 2;
      if (sourceSecondsAtParentFrame(middle) < sourceSeconds) low = middle;
      else high = middle;
    }
    return (low + high) / 2;
  };
  return {
    frameRate: assetFrameRate,
    secondsOffset: frameToSeconds(parentTimeline, first.frame),
    secondsPerFrame: parentTimeline.secondsPerFrame,
    mapFrameToSeconds: frame => frameToSeconds(
      parentTimeline,
      parentFrameForSourceSeconds(frame / assetFrameRate),
    ),
  };
}

function cubicBezierProgress(progress: number, x1: number, y1: number, x2: number, y2: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 16; iteration++) {
    const parameter = (low + high) / 2;
    if (cubicBezierCoordinate(parameter, x1, x2) < progress) low = parameter;
    else high = parameter;
  }
  return cubicBezierCoordinate((low + high) / 2, y1, y2);
}

function cubicBezierCoordinate(parameter: number, firstControl: number, secondControl: number): number {
  const inverse = 1 - parameter;
  return 3 * inverse * inverse * parameter * firstControl
    + 3 * inverse * parameter * parameter * secondControl
    + parameter * parameter * parameter;
}

function createOrdinaryLayerTimeline(
  layer: Record<string, unknown>,
  path: string,
  parentTimeline: LottieTimeline,
  state: ConversionState,
): LottieTimeline {
  const stretch = finite(layer.sr ?? 1, `${path}.sr`);
  if (Math.abs(stretch - 1) < 1e-8) return parentTimeline;
  if (stretch <= 0) {
    warn(state, 'W_LOTTIE_INVALID_TIME_STRETCH', `${path}.sr`, 'Layer time stretch must be greater than zero.');
    return parentTimeline;
  }
  const startFrame = finite(layer.st ?? layer.ip ?? 0, `${path}.st`);
  const mapFrameToSeconds = (frame: number): number => frameToSeconds(
    parentTimeline,
    startFrame + (frame - startFrame) * stretch,
  );
  return {
    frameRate: parentTimeline.frameRate,
    secondsOffset: mapFrameToSeconds(0),
    secondsPerFrame: parentTimeline.secondsPerFrame * stretch,
    mapFrameToSeconds,
  };
}

function convertNodeTiming(
  startFrame: number,
  endFrame: number,
  timeline: LottieTimeline,
  animationDuration: number,
): { start: number; duration: number } {
  const minimumDuration = Math.min(animationDuration, Math.max(1e-6, timeline.secondsPerFrame));
  const rawStart = frameToSeconds(timeline, startFrame);
  const rawEnd = frameToSeconds(timeline, endFrame);
  const start = clamp(rawStart, 0, Math.max(0, animationDuration - minimumDuration));
  const end = clamp(rawEnd, start + minimumDuration, animationDuration);
  return { start, duration: Math.max(minimumDuration, end - start) };
}

function isAnimated(value: unknown): boolean {
  const property = object(value);
  if (!Array.isArray(property.k)) return false;
  if (property.a === 1) return true;
  // Older Bodymovin exporters omit the `a` flag and encode animation solely as
  // a keyframe array. Treating that form as a static array drops paths and
  // transforms instead of merely degrading their animation.
  const first = object(property.k[0]);
  return typeof first.t === 'number'
    && Number.isFinite(first.t)
    && (first.s !== undefined || first.e !== undefined);
}

function readStaticVector(value: unknown, fallback: number[]): number[] {
  const property = object(value);
  if (isAnimated(property)) return numberList(object(list(property.k)[0]).s).length > 0 ? numberList(object(list(property.k)[0]).s) : fallback;
  const values = numberList(property.k);
  return values.length > 0 ? values : fallback;
}

function readFirstPositiveVector(value: unknown, valueSize: number): number[] | undefined {
  const property = object(value);
  const candidates = isAnimated(property)
    ? list(property.k).flatMap(entry => {
      const keyframe = object(entry);
      return [numberList(keyframe.s), numberList(keyframe.e)];
    })
    : [numberList(property.k)];
  return candidates.find(candidate => candidate.length >= valueSize
    && candidate.slice(0, valueSize).every(component => component > 0));
}

function readStaticScalar(value: unknown, fallback: number): number {
  return readStaticVector(value, [fallback])[0] ?? fallback;
}

function parseHexColor(value: unknown, path: string): readonly [number, number, number, number] {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError(`Expected #RRGGBB at ${path}.`);
  const packed = Number.parseInt(value.slice(1), 16);
  return [((packed >> 16) & 255) / 255, ((packed >> 8) & 255) / 255, (packed & 255) / 255, 1];
}

function resolveUri(base: string, path: string): string {
  if (!base) return path;
  try { return new URL(path, base).toString(); } catch { return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`; }
}

function parseLottieJson(source: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(source);
  return object(value);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberList(value: unknown): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (!Array.isArray(value)) return [];
  const flattened = value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
  return flattened.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function firstNumber(value: unknown, fallback: number): number {
  return numberList(value)[0] ?? fallback;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`Expected a finite number at ${path}.`);
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) throw new TypeError(`Expected a positive number at ${path}.`);
  return result;
}

function integer(value: unknown, path: string): number {
  const result = finite(value, path);
  if (!Number.isSafeInteger(result)) throw new TypeError(`Expected an integer at ${path}.`);
  return result;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stableUint32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function warn(state: ConversionState, code: string, path: string, message: string): void {
  state.diagnostics.push(Object.freeze({ severity: 'warning', code, path, message }));
}
