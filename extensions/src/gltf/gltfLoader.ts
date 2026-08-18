import { CartesianTransform3D, Entity, Geometry3D, Mesh3D, PbrMaterial } from '@haiyue/engine';
import { Transform3D } from '@haiyue/engine/components';
import { type AssetHandle, type AssetManager } from '@haiyue/engine/assets';
import { monotonicNow, parseAssetWorkerFirst } from '@haiyue/engine/experimental/async';
import { mat4 } from 'wgpu-matrix';
import {
  isGltfAsset,
  type GltfAsset,
  type GltfNode,
  type GltfPrimitive,
} from './GltfSchema';
import { GltfConservativeBounds } from './GltfConservativeBounds';
import {
  createGltfCompatibilityReport,
  type GltfPrimitiveCompatibilityInput,
} from './GltfCompatibilityReport';
import {
  parseTextureCoordinateSemantic,
  planGltfUvSemantics,
} from './GltfUvSemanticPlanner';
import {
  collectGltfMaterialVariantNames,
  createGltfExtensionCapabilities,
  resolveGltfExtensionAdapters,
  type GltfExtensionCapability,
} from './GltfExtensionAdapter';
import {
  attachGltfSource,
  gltfDataError,
  throwIfGltfLoadAborted as throwIfAborted,
} from './GltfLoaderErrors';
import {
  generateFlatNormals,
  readAccessorFloat,
  readAccessorIndices,
  readAccessorMat4,
  readAccessorUnsigned,
} from './GltfAccessorReader';
import { decodeDracoPrimitive } from './GltfDracoDecoder';
import {
  applyMorphWeights,
  composeTrsMatrix,
  createAnimationClips,
  registerGltfConservativeBounds,
  updateSkinnedPrimitive,
} from './GltfAnimationRuntime';
import { createGltfMaterial, preloadGltfTextures } from './GltfMaterialLoader';
import type {
  GltfAnimationTarget,
  GltfAssetStats,
  GltfExtensionReport,
  GltfExtensionReportEntry,
  GltfGeometryPayloadMatrix,
  GltfLoadContext,
  GltfLoadWarning,
  GltfParsedAsset,
  GltfPendingSkinnedPrimitive,
  GltfPrimitiveGeometryPayload,
  GltfSkinnedPrimitiveRuntime,
  LoadedGltfModel,
  LoadGltfOptions,
} from './GltfLoaderContract';

export * from './GltfLoaderContract';
export { applyGltfAnimationClip } from './GltfAnimationRuntime';

const sharedImageSourcesByAsset = new WeakMap<GltfParsedAsset, WeakMap<AssetManager, Map<number, string>>>();

export async function loadGltfModel(src: string, options: LoadGltfOptions = {}): Promise<LoadedGltfModel> {
  const loadStartedAt = nowMilliseconds();
  throwIfAborted(options.signal);
  const extensionAdapters = resolveGltfExtensionAdapters(options.extensionAdapters);
  const extensionCapabilities = createGltfExtensionCapabilities(extensionAdapters);
  let parsedAssetHandle: AssetHandle<GltfParsedAsset> | null = null;
  let parsedAsset: GltfParsedAsset;
  const assetManager = options.assetManager ?? null;
  try {
    if (assetManager) {
      parsedAssetHandle = await assetManager.load(
        `gltf:parsed:${resolveAssetIdentity(src)}`,
        signal => loadParsedAssetForModel(src, options, signal),
        asset => disposeSharedImageSources(asset, assetManager),
        { signal: options.signal },
      );
      parsedAsset = parsedAssetHandle.value;
    } else {
      parsedAsset = await loadParsedAssetForModel(src, options, options.signal);
    }
  } catch (error) {
    throw attachGltfSource(error, src);
  }
  const { gltf, buffers, baseUrl, geometryPayloads } = parsedAsset;
  let extensionInspection: GltfExtensionInspection;
  try {
    extensionInspection = validateGltfExtensions(gltf, extensionCapabilities);
  } catch (error) {
    parsedAssetHandle?.release();
    throw attachGltfSource(error, src);
  }
  try {
    for (const warning of extensionInspection.warnings) options.onWarning?.(warning);
    throwIfAborted(options.signal);
  } catch (error) {
    parsedAssetHandle?.release();
    throw attachGltfSource(error, src);
  }
  const animationTargets = new Map<number, GltfAnimationTarget>();
  const context: GltfLoadContext = {
    baseUrl,
    assetIdentity: resolveAssetIdentity(src),
    objectUrls: [],
    imageSources: parsedAssetHandle && assetManager
      ? getSharedImageSources(parsedAsset, assetManager)
      : new Map(),
    sharedImageSources: parsedAssetHandle !== null,
    preloadedTextures: new Map(),
    animationTargets,
    skinnedPrimitives: [],
    pendingSkinnedPrimitives: [],
    assetHandles: parsedAssetHandle ? [parsedAssetHandle] : [],
    ...(geometryPayloads === undefined ? {} : { geometryPayloads }),
    compatibilityPrimitives: [],
    extensionAdapters,
  };
  const root = new Entity('glTF Model');
  try {
    let mainThreadDracoDecodeMs = 0;
    const geometryOptions: LoadGltfOptions = geometryPayloads === undefined
      ? {
          ...options,
          diagnostics: {
            onDracoDecode(durationMs, decodedBytes) {
              mainThreadDracoDecodeMs += durationMs;
              options.diagnostics?.onDracoDecode?.(durationMs, decodedBytes);
            },
          },
        }
      : options;
    let geometryPreparationMs = parsedAsset.metrics?.geometryPreparationMs ?? 0;
    const geometryTask = geometryPayloads === undefined
      ? (async () => {
          const startedAt = nowMilliseconds();
          try {
            return await prepareGltfGeometryPayloads(gltf, buffers, geometryOptions);
          } finally {
            geometryPreparationMs = nowMilliseconds() - startedAt;
          }
        })()
      : Promise.resolve(geometryPayloads);
    let textureDecodeTranscodeUploadMs = 0;
    const textureTask = (async () => {
      const startedAt = nowMilliseconds();
      try {
        await preloadGltfTextures(gltf, buffers, options, context);
      } finally {
        textureDecodeTranscodeUploadMs = nowMilliseconds() - startedAt;
      }
    })();
    const [geometryResult, textureResult] = await Promise.all([
      settleTask(geometryTask),
      settleTask(textureTask),
    ]);
    if (!geometryResult.ok) throw geometryResult.error;
    if (!textureResult.ok) throw textureResult.error;
    context.geometryPayloads = geometryResult.value;
    const instantiateStartedAt = nowMilliseconds();
    root.addComponent(new CartesianTransform3D());
    const sceneIndex = options.scene ?? gltf.scene ?? 0;
    const scene = gltf.scenes?.[sceneIndex] ?? gltf.scenes?.[0];
    const rootNodes = await Promise.all((scene?.nodes ?? []).map(nodeIndex =>
      instantiateNode(gltf, buffers, nodeIndex, options, animationTargets, context)));
    for (const child of rootNodes) {
      throwIfAborted(options.signal);
      if (child) root.addChild(child);
    }
    resolvePendingSkins(gltf, buffers, context);
    const animationClips = createAnimationClips(gltf, buffers, animationTargets, context.skinnedPrimitives);
    const instantiateMs = nowMilliseconds() - instantiateStartedAt;
    const decodedGeometryBytes = countDecodedGeometryBytes(context.compatibilityPrimitives);
    const parsedMetrics = parsedAsset.metrics;
    const dracoDecodeMs = (parsedMetrics?.dracoDecodeMs ?? 0) + mainThreadDracoDecodeMs;
    const compatibilityReport = createGltfCompatibilityReport(
      gltf,
      extensionInspection.report.entries,
      context.compatibilityPrimitives,
      {
        loadMs: nowMilliseconds() - loadStartedAt,
        decodedGeometryBytes,
      },
    );
    return {
      root,
      animations: animationClips.map(clip => ({ name: clip.name, duration: clip.duration, channelCount: clip.channels.length })),
      animationClips,
      assetStats: collectAssetStats(gltf),
      loadMetrics: Object.freeze({
        timings: Object.freeze({
          fetchMs: parsedMetrics?.fetchMs ?? 0,
          workerParseMs: parsedMetrics?.workerParseMs ?? 0,
          dracoDecodeMs,
          geometryPreparationMs: geometryPayloads === undefined
            ? Math.max(0, geometryPreparationMs - mainThreadDracoDecodeMs)
            : parsedMetrics?.geometryPreparationMs ?? 0,
          instantiateMs,
          textureDecodeTranscodeUploadMs,
          totalMs: nowMilliseconds() - loadStartedAt,
        }),
        sourceBytes: parsedMetrics?.sourceBytes ?? countUniqueBufferBytes(buffers),
        decodedGeometryBytes,
        workerTransferBytes: parsedMetrics?.workerTransferBytes ?? 0,
        workerTransferBufferCount: parsedMetrics?.workerTransferBufferCount ?? 0,
      }),
      objectUrls: context.objectUrls,
      assetHandles: context.assetHandles,
      materialVariants: collectGltfMaterialVariantNames(gltf, extensionAdapters),
      warnings: extensionInspection.warnings,
      extensionReport: extensionInspection.report,
      compatibilityReport,
    };
  } catch (error) {
    disposeEntityTree(root);
    revokeObjectUrls(context.objectUrls);
    releaseAssetHandles(context.assetHandles);
    throw attachGltfSource(error, src);
  }
}

async function loadParsedAssetForModel(
  src: string,
  options: LoadGltfOptions,
  signal: AbortSignal | undefined,
): Promise<GltfParsedAsset> {
  const assetWorker = options.assetWorker && !isInlineOrBlobUri(src) ? options.assetWorker : null;
  return parseAssetWorkerFirst({
    parser: { type: 'model/gltf', parse: (_input, context) => loadParsedGltfAsset(src, context.signal) },
    input: src,
    context: { ...(signal === undefined ? {} : { signal }), source: src },
    worker: assetWorker
      ? (_input, context) => assetWorker.loadParsedAsset(src, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(options.dracoDecoderConfig === undefined ? {} : { dracoDecoderConfig: options.dracoDecoderConfig }),
        })
      : null,
  });
}

function resolveAssetIdentity(src: string): string {
  try {
    const fallback = typeof globalThis.location?.href === 'string' ? globalThis.location.href : undefined;
    return fallback === undefined ? new URL(src).href : new URL(src, fallback).href;
  } catch {
    return src;
  }
}

function getSharedImageSources(asset: GltfParsedAsset, manager: AssetManager): Map<number, string> {
  let byManager = sharedImageSourcesByAsset.get(asset);
  if (!byManager) {
    byManager = new WeakMap();
    sharedImageSourcesByAsset.set(asset, byManager);
  }
  let sources = byManager.get(manager);
  if (!sources) {
    sources = new Map();
    byManager.set(manager, sources);
  }
  return sources;
}

function disposeSharedImageSources(asset: GltfParsedAsset, manager: AssetManager): void {
  const sources = sharedImageSourcesByAsset.get(asset)?.get(manager);
  if (!sources) return;
  for (const url of sources.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  sources.clear();
  sharedImageSourcesByAsset.get(asset)?.delete(manager);
}

type SettledTask<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function settleTask<T>(task: Promise<T>): Promise<SettledTask<T>> {
  try {
    return { ok: true, value: await task };
  } catch (error) {
    return { ok: false, error };
  }
}

const nowMilliseconds = monotonicNow;

function countDecodedGeometryBytes(primitives: readonly GltfPrimitiveCompatibilityInput[]): number {
  const buffers = new Set<ArrayBufferLike>();
  const add = (value: ArrayBufferView<ArrayBufferLike> | null | undefined): void => {
    if (value) buffers.add(value.buffer);
  };
  for (const { geometry } of primitives) {
    add(geometry.positions);
    add(geometry.normals);
    add(geometry.indices);
    add(geometry.morphBasePositions);
    add(geometry.morphBaseNormals);
    for (const value of geometry.textureCoordinates.values()) add(value);
    for (const target of geometry.morphTargets) {
      add(target.positions);
      add(target.normals);
    }
    add(geometry.skinning?.joints);
    add(geometry.skinning?.weights);
    add(geometry.skinning?.jointMatrices);
  }
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  return total;
}

function countUniqueBufferBytes(buffers: readonly ArrayBuffer[]): number {
  let total = 0;
  for (const buffer of new Set(buffers)) total += buffer.byteLength;
  return total;
}

function isInlineOrBlobUri(src: string): boolean {
  return /^(data:|blob:)/i.test(src);
}

export function disposeGltfModel(model: LoadedGltfModel): void {
  disposeEntityTree(model.root);
  revokeObjectUrls(model.objectUrls);
  releaseAssetHandles(model.assetHandles);
  model.animations.length = 0;
  model.animationClips.length = 0;
}

export function setGltfMaterialVariant(model: LoadedGltfModel, name: string | null): void {
  if (name !== null && !model.materialVariants.includes(name)) {
    throw new RangeError(`Unknown glTF material variant "${name}".`);
  }
  visitEntityTree(model.root, entity => {
    const material = entity.getComponent(Mesh3D)?.material;
    if (!(material instanceof PbrMaterial)) return;
    material.setVariant(name !== null && material.variantNames.includes(name) ? name : null);
  });
}

function visitEntityTree(entity: Entity, visit: (entity: Entity) => void): void {
  visit(entity);
  for (const child of entity.children as Iterable<Entity>) visitEntityTree(child, visit);
}

function releaseAssetHandles(handles: AssetHandle<unknown>[]): void {
  for (const handle of handles) handle.release();
  handles.length = 0;
}

function revokeObjectUrls(urls: string[]): void {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.length = 0;
}

function disposeEntityTree(entity: Entity): void {
  const children = [...entity.children] as Entity[];
  for (const child of children) disposeEntityTree(child);
  entity.destroy();
}

function collectAssetStats(gltf: GltfAsset): GltfAssetStats {
  return {
    meshCount: gltf.meshes?.length ?? 0,
    primitiveCount: (gltf.meshes ?? []).reduce((sum, mesh) => sum + mesh.primitives.length, 0),
    materialCount: gltf.materials?.length ?? 0,
    textureCount: gltf.textures?.length ?? 0,
    imageCount: gltf.images?.length ?? 0,
    animationCount: gltf.animations?.length ?? 0,
  };
}

async function loadGltfAsset(src: string, signal?: AbortSignal): Promise<{
  gltf: GltfAsset;
  binaryChunk: ArrayBuffer | null;
  baseUrl: string;
  fetchMs: number;
  parseMs: number;
  sourceBytes: number;
}> {
  const baseUrl = resolveBaseUrl(src);
  const fetchStartedAt = nowMilliseconds();
  const response = await fetch(src, signal ? { signal } : undefined);
  if (!response.ok) throw gltfDataError(
    `Failed to load glTF: ${response.status} ${response.statusText}`,
    { url: src, status: response.status },
    'gltf',
  );
  throwIfAborted(signal);
  const bytes = await response.arrayBuffer();
  const fetchMs = nowMilliseconds() - fetchStartedAt;
  throwIfAborted(signal);
  const parseStartedAt = nowMilliseconds();
  if (isGlb(bytes)) {
    const parsed = parseGlb(bytes);
    return {
      ...parsed,
      baseUrl,
      fetchMs,
      parseMs: nowMilliseconds() - parseStartedAt,
      sourceBytes: bytes.byteLength,
    };
  }
  const text = new TextDecoder().decode(bytes);
  const gltf = parseGltfJson(text, src, 'gltf');
  return {
    gltf,
    binaryChunk: null,
    baseUrl,
    fetchMs,
    parseMs: nowMilliseconds() - parseStartedAt,
    sourceBytes: bytes.byteLength,
  };
}

export async function loadParsedGltfAsset(src: string, signal?: AbortSignal): Promise<GltfParsedAsset> {
  const { gltf, binaryChunk, baseUrl, fetchMs: primaryFetchMs, parseMs, sourceBytes } =
    await loadGltfAsset(src, signal);
  throwIfAborted(signal);
  const buffersStartedAt = nowMilliseconds();
  const buffers = await loadBuffers(gltf, binaryChunk, baseUrl, signal);
  const bufferFetchMs = nowMilliseconds() - buffersStartedAt;
  return {
    gltf,
    binaryChunk,
    buffers,
    baseUrl,
    metrics: Object.freeze({
      fetchMs: primaryFetchMs + bufferFetchMs,
      parseMs,
      workerParseMs: parseMs,
      dracoDecodeMs: 0,
      geometryPreparationMs: 0,
      sourceBytes: sourceBytes + countExternalBufferBytes(gltf, buffers),
      workerTransferBytes: 0,
      workerTransferBufferCount: 0,
    }),
  };
}

function countExternalBufferBytes(gltf: GltfAsset, buffers: readonly ArrayBuffer[]): number {
  let total = 0;
  for (const [index, descriptor] of (gltf.buffers ?? []).entries()) {
    if (!descriptor.uri || descriptor.uri.startsWith('data:')) continue;
    total += buffers[index]?.byteLength ?? 0;
  }
  return total;
}

interface GltfExtensionInspection {
  readonly warnings: readonly GltfLoadWarning[];
  readonly report: GltfExtensionReport;
}

function validateGltfExtensions(
  gltf: GltfAsset,
  capabilities: Readonly<Record<string, GltfExtensionCapability>>,
): GltfExtensionInspection {
  const usedExtensions = new Set(gltf.extensionsUsed ?? []);
  const requiredExtensions = new Set(gltf.extensionsRequired ?? []);
  for (const [index, extension] of (gltf.extensionsRequired ?? []).entries()) {
    if (!usedExtensions.has(extension)) {
      throw gltfDataError(
        `Required glTF extension "${extension}" is missing from extensionsUsed.`,
        { extension },
        `gltf.extensionsRequired[${index}]`,
      );
    }
    const capability = capabilities[extension];
    if (capability?.support === 'supported') continue;
    throw gltfDataError(
      `Required glTF extension "${extension}" is not supported.`,
      { extension, support: capability?.support ?? 'unknown' },
      `gltf.extensionsRequired[${index}]`,
    );
  }

  const warnings: GltfLoadWarning[] = [];
  for (const [index, extension] of (gltf.extensionsUsed ?? []).entries()) {
    const capability = capabilities[extension];
    if (capability?.support === 'supported') continue;
    const partial = capability?.support === 'partial';
    warnings.push(Object.freeze({
      code: partial ? 'W_GLTF_PARTIAL_OPTIONAL_EXTENSION' : 'W_GLTF_UNSUPPORTED_OPTIONAL_EXTENSION',
      message: partial
        ? `Optional glTF extension "${extension}" is only partially supported: ${capability.note}`
        : `Optional glTF extension "${extension}" is not supported and was ignored.`,
      extension,
      path: `gltf.extensionsUsed[${index}]`,
    }));
  }
  const entries = [...usedExtensions].map(extension => {
    const capability = capabilities[extension];
    const support = capability?.support ?? 'unsupported';
    return Object.freeze({
      extension,
      required: requiredExtensions.has(extension),
      support,
      disposition: support === 'supported' ? 'supported' : support === 'partial' ? 'partial' : 'ignored',
      note: capability?.note ?? 'No loader capability is registered; optional extension data is ignored.',
    } satisfies GltfExtensionReportEntry);
  });
  const frozenWarnings = Object.freeze(warnings);
  return Object.freeze({
    warnings: frozenWarnings,
    report: Object.freeze({
      fullySupported: entries.every(entry => entry.support === 'supported'),
      entries: Object.freeze(entries),
    }),
  });
}

function resolveBaseUrl(src: string): string {
  try {
    return new URL('.', src).href;
  } catch {
    const documentBase = (globalThis as typeof globalThis & {
      document?: { baseURI?: string };
    }).document?.baseURI;
    const candidates = [documentBase, globalThis.location?.href, 'http://localhost/'];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      try {
        return new URL('.', candidate).href;
      } catch {
        // about:srcdoc and other opaque origins cannot resolve relatives.
      }
    }
    return 'http://localhost/';
  }
}

function isGlb(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  return view.byteLength >= 12 && view.getUint32(0, true) === 0x46546c67;
}

function parseGlb(buffer: ArrayBuffer): { gltf: GltfAsset; binaryChunk: ArrayBuffer | null } {
  if (buffer.byteLength < 12) throw gltfDataError('GLB header is truncated.', {}, 'glb.header');
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version !== 2) throw gltfDataError(`Unsupported GLB version: ${version}`, { version }, 'glb.header.version');
  let offset = 12;
  let gltf: GltfAsset | null = null;
  let binaryChunk: ArrayBuffer | null = null;
  while (offset + 8 <= view.byteLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkStart + chunkLength > view.byteLength) {
      throw gltfDataError('GLB chunk exceeds the file length.', { chunkLength, offset }, `glb.chunks[${offset}]`);
    }
    const chunk = buffer.slice(chunkStart, chunkStart + chunkLength);
    if (chunkType === 0x4e4f534a) {
      gltf = parseGltfJson(new TextDecoder().decode(chunk), 'GLB', 'glb.json');
    } else if (chunkType === 0x004e4942) {
      binaryChunk = chunk;
    }
    offset = chunkStart + chunkLength;
  }
  if (!gltf) throw gltfDataError('GLB is missing JSON chunk.', {}, 'glb.json');
  return { gltf, binaryChunk };
}

function parseGltfJson(text: string, source: string, path: string): GltfAsset {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw gltfDataError('glTF JSON is not valid JSON.', { url: source }, path, error);
  }
  if (!isGltfAsset(value)) {
    throw gltfDataError('glTF JSON does not match the supported glTF structure.', { url: source }, path);
  }
  return value;
}

async function loadBuffers(gltf: GltfAsset, binaryChunk: ArrayBuffer | null, baseUrl: string, signal?: AbortSignal): Promise<ArrayBuffer[]> {
  return Promise.all((gltf.buffers ?? []).map(async (buffer, index) => {
    throwIfAborted(signal);
    if (!buffer.uri) {
      if (index === 0 && binaryChunk) return binaryChunk;
      throw gltfDataError(`glTF buffer ${index} has no uri and no GLB chunk.`);
    }
    if (buffer.uri.startsWith('data:')) {
      return dataUriToArrayBuffer(buffer.uri);
    }
    const response = await fetch(resolveFetchUri(buffer.uri, baseUrl), signal ? { signal } : undefined);
    if (!response.ok) throw gltfDataError(`Failed to load glTF buffer: ${buffer.uri}`, { uri: buffer.uri }, `gltf.buffers[${index}]`);
    throwIfAborted(signal);
    const result = await response.arrayBuffer();
    throwIfAborted(signal);
    return result;
  }));
}

function resolveFetchUri(uri: string, baseUrl: string): string {
  if (/^(blob:|https?:\/\/)/i.test(uri)) return uri;
  return new URL(uri, baseUrl).href;
}

function dataUriToArrayBuffer(uri: string): ArrayBuffer {
  const comma = uri.indexOf(',');
  const meta = uri.slice(0, comma);
  const data = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(data)).buffer;
}

async function instantiateNode(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  nodeIndex: number,
  options: LoadGltfOptions,
  animationTargets: Map<number, GltfAnimationTarget>,
  context: GltfLoadContext,
): Promise<Entity | null> {
  throwIfAborted(options.signal);
  const node = gltf.nodes?.[nodeIndex];
  if (!node) return null;
  const entity = new Entity(node.name || `glTF Node ${nodeIndex}`);
  const { transform, target } = createNodeTransform(node, entity);
  entity.addComponent(transform);
  animationTargets.set(nodeIndex, target);
  if (node.mesh !== undefined) {
    const mesh = gltf.meshes?.[node.mesh];
    target.weights = mesh?.weights ? [...mesh.weights] : [];
    const primitiveEntities = await Promise.all((mesh?.primitives ?? []).map((primitive, primitiveIndex) =>
      createPrimitiveEntity(gltf, buffers, primitive, options, `${mesh?.name || 'Mesh'} Primitive ${primitiveIndex}`, target, context, node.skin, entity, node.mesh as number, primitiveIndex)));
    for (const primitiveEntity of primitiveEntities) {
      throwIfAborted(options.signal);
      if (primitiveEntity) entity.addChild(primitiveEntity);
    }
    applyMorphWeights(target, target.weights);
  }
  const children = await Promise.all((node.children ?? []).map(childIndex =>
    instantiateNode(gltf, buffers, childIndex, options, animationTargets, context)));
  for (const child of children) {
    throwIfAborted(options.signal);
    if (child) entity.addChild(child);
  }
  return entity;
}

function createNodeTransform(node: GltfNode, entity: Entity): { transform: Transform3D; target: GltfAnimationTarget } {
  const translation: [number, number, number] = node.translation ? [...node.translation] : [0, 0, 0];
  const rotation: [number, number, number, number] = node.rotation ? [...node.rotation] : [0, 0, 0, 1];
  const scale: [number, number, number] = node.scale ? [...node.scale] : [1, 1, 1];
  const transform = new Transform3D();
  if (node.matrix?.length === 16) {
    transform.localMatrix = new Float32Array(node.matrix);
  } else {
    transform.localMatrix = composeTrsMatrix(translation, rotation, scale);
  }
  return { transform, target: { entity, transform, translation, rotation, scale, weights: [], morphPrimitives: [] } };
}

async function createPrimitiveEntity(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  primitive: GltfPrimitive,
  options: LoadGltfOptions,
  name: string,
  target: GltfAnimationTarget,
  context: GltfLoadContext,
  skinIndex: number | undefined,
  meshEntity: Entity,
  meshIndex: number,
  primitiveIndex: number,
): Promise<Entity | null> {
  throwIfAborted(options.signal);
  if (primitive.mode !== undefined && primitive.mode !== 4) return null;
  const payload = context.geometryPayloads?.[meshIndex]?.[primitiveIndex]
    ?? await createPrimitiveGeometryPayload(gltf, buffers, primitive, options);
  throwIfAborted(options.signal);
  if (!payload) return null;
  const uvPlanResult = planGltfUvSemantics(
    gltf,
    primitive,
    meshIndex,
    primitiveIndex,
    context.extensionAdapters,
  );
  if (!uvPlanResult.ok) {
    throw gltfDataError(uvPlanResult.failure.message, uvPlanResult.failure.context, uvPlanResult.failure.path);
  }
  const uvPlan = uvPlanResult.plan;
  const { positions, indices, normals, textureCoordinates, joints, weights, positionTargets, normalTargets } = payload;
  for (const mapping of uvPlan.mappings) {
    if (textureCoordinates.some(entry => entry.set === mapping.set)) continue;
    throw gltfDataError(
      `Decoded geometry payload is missing ${mapping.semantic}.`,
      { meshIndex, primitiveIndex, semantic: mapping.semantic, texCoord: mapping.set },
      `${uvPlan.path}.attributes.${mapping.semantic}`,
    );
  }
  const geometry = new Geometry3D({
    positions,
    ...(normals === undefined ? {} : { normals }),
    textureCoordinates,
    textureCoordinateLayout: uvPlan.mappings.map(mapping => mapping.set),
    ...(indices === undefined ? {} : { indices }),
  });
  const conservativeBounds = GltfConservativeBounds.fromPrimitive(gltf, primitive);
  if (conservativeBounds) registerGltfConservativeBounds(geometry, conservativeBounds);
  if (positionTargets.length > 0 || normalTargets.length > 0) {
    geometry.setMorphTargets(
      new Array(Math.max(positionTargets.length, normalTargets.length)).fill(null).map((_, index) => ({
        ...(positionTargets[index] === undefined ? {} : { positions: positionTargets[index] }),
        ...(normalTargets[index] === undefined ? {} : { normals: normalTargets[index] }),
      })),
      target.weights,
    );
    target.morphPrimitives.push({
      geometry,
      basePositions: positions.slice(),
      baseNormals: normals ? normals.slice() : null,
      positionTargets,
      normalTargets,
    });
    if (target.weights.length === 0) target.weights = new Array(Math.max(positionTargets.length, normalTargets.length)).fill(0);
  }
  const material = await createGltfMaterial(gltf, buffers, primitive, options, context, uvPlan);
  throwIfAborted(options.signal);
  const entity = new Entity(name);
  entity.addComponent(new CartesianTransform3D());
  entity.addComponent(new Mesh3D(geometry, material));
  if (skinIndex !== undefined && joints && weights) {
    context.pendingSkinnedPrimitives.push({ skinIndex, geometry, meshEntity, joints, weights });
  }
  context.compatibilityPrimitives.push({
    meshIndex,
    primitiveIndex,
    primitive,
    geometry,
    skinRequested: skinIndex !== undefined,
    uvSemanticPlan: uvPlan,
  });
  return entity;
}

async function createPrimitiveGeometryPayload(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  primitive: GltfPrimitive,
  options: LoadGltfOptions,
): Promise<GltfPrimitiveGeometryPayload | null> {
  throwIfAborted(options.signal);
  if (primitive.mode !== undefined && primitive.mode !== 4) return null;
  const dracoExtension = primitive.extensions?.KHR_draco_mesh_compression;
  let decoded = null;
  if (dracoExtension) {
    const decodeStartedAt = nowMilliseconds();
    decoded = await decodeDracoPrimitive(gltf, buffers, dracoExtension, options);
    options.diagnostics?.onDracoDecode?.(
      nowMilliseconds() - decodeStartedAt,
      countDracoGeometryBytes(decoded),
    );
  }
  throwIfAborted(options.signal);
  const positionAccessor = primitive.attributes.POSITION;
  if (positionAccessor === undefined && !decoded?.positions) return null;
  const positions = decoded?.positions ?? readAccessorFloat(gltf, buffers, positionAccessor as number, 3);
  const indices = decoded?.indices ?? (primitive.indices !== undefined ? readAccessorIndices(gltf, buffers, primitive.indices) : undefined);
  const normals = decoded?.normals ?? (primitive.attributes.NORMAL !== undefined
    ? readAccessorFloat(gltf, buffers, primitive.attributes.NORMAL, 3)
    : generateFlatNormals(positions, indices ?? null));
  const textureCoordinates = decoded?.textureCoordinates ?? Object.entries(primitive.attributes)
    .map(([semantic, accessor]) => ({ set: parseTextureCoordinateSemantic(semantic), accessor }))
    .filter((entry): entry is { set: number; accessor: number } => entry.set !== null)
    .sort((a, b) => a.set - b.set)
    .map(entry => ({ set: entry.set, data: readAccessorFloat(gltf, buffers, entry.accessor, 2) }));
  const joints = decoded?.joints ?? (primitive.attributes.JOINTS_0 !== undefined
    ? readAccessorUnsigned(gltf, buffers, primitive.attributes.JOINTS_0, 4)
    : undefined);
  const weights = decoded?.weights ?? (primitive.attributes.WEIGHTS_0 !== undefined
    ? readAccessorFloat(gltf, buffers, primitive.attributes.WEIGHTS_0, 4)
    : undefined);
  return {
    positions,
    ...(indices === undefined ? {} : { indices }),
    ...(normals === undefined ? {} : { normals }),
    textureCoordinates,
    ...(joints === undefined ? {} : { joints }),
    ...(weights === undefined ? {} : { weights }),
    positionTargets: (primitive.targets ?? []).map(item => item.POSITION !== undefined
      ? readAccessorFloat(gltf, buffers, item.POSITION, 3)
      : new Float32Array(positions.length)),
    normalTargets: (primitive.targets ?? []).map(item => item.NORMAL !== undefined
      ? readAccessorFloat(gltf, buffers, item.NORMAL, 3)
      : new Float32Array(normals.length)),
  };
}

export async function prepareGltfGeometryPayloads(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  options: LoadGltfOptions = {},
): Promise<GltfGeometryPayloadMatrix> {
  return Promise.all((gltf.meshes ?? []).map(mesh => Promise.all(
    mesh.primitives.map(primitive => createPrimitiveGeometryPayload(gltf, buffers, primitive, options)),
  )));
}

function countDracoGeometryBytes(decoded: NonNullable<Awaited<ReturnType<typeof decodeDracoPrimitive>>>): number {
  const buffers = new Set<ArrayBufferLike>();
  const add = (value: ArrayBufferView<ArrayBufferLike> | undefined): void => {
    if (value) buffers.add(value.buffer);
  };
  add(decoded.positions);
  add(decoded.indices);
  add(decoded.normals);
  add(decoded.joints);
  add(decoded.weights);
  for (const entry of decoded.textureCoordinates) add(entry.data);
  let total = 0;
  for (const buffer of buffers) total += buffer.byteLength;
  return total;
}

function resolvePendingSkins(gltf: GltfAsset, buffers: ArrayBuffer[], context: GltfLoadContext): void {
  for (const pending of context.pendingSkinnedPrimitives) {
    const runtime = createSkinRuntime(gltf, buffers, pending, context);
    if (runtime) {
      updateSkinnedPrimitive(runtime);
      context.skinnedPrimitives.push(runtime);
    }
  }
  context.pendingSkinnedPrimitives.length = 0;
}

function createSkinRuntime(
  gltf: GltfAsset,
  buffers: ArrayBuffer[],
  pending: GltfPendingSkinnedPrimitive,
  context: GltfLoadContext,
): GltfSkinnedPrimitiveRuntime | null {
  const skin = gltf.skins?.[pending.skinIndex];
  if (!skin || skin.joints.length === 0) return null;
  const jointTargets = skin.joints.map(nodeIndex => context.animationTargets.get(nodeIndex) ?? null);
  if (!jointTargets.some(Boolean)) return null;
  const inverseBindMatrices = skin.inverseBindMatrices !== undefined
    ? readAccessorMat4(gltf, buffers, skin.inverseBindMatrices)
    : new Array(jointTargets.length).fill(null).map(() => mat4.identity() as Float32Array);
  if (inverseBindMatrices.length < jointTargets.length) {
    while (inverseBindMatrices.length < jointTargets.length) inverseBindMatrices.push(mat4.identity() as Float32Array);
  }
  const jointMatrices = new Float32Array(jointTargets.length * 16);
  const gpuSkinAttributes = createGpuSkinAttributes(pending.joints, pending.weights, jointTargets.length);
  pending.geometry.setSkinning({
    joints: gpuSkinAttributes.joints,
    weights: gpuSkinAttributes.weights,
    jointMatrices,
  });
  return {
    geometry: pending.geometry,
    meshEntity: pending.meshEntity,
    jointTargets,
    inverseBindMatrices,
    jointMatrices,
    inverseMeshWorldScratch: mat4.identity() as Float32Array,
    jointMatrixScratch: mat4.identity() as Float32Array,
    skinMatrixScratch: mat4.identity() as Float32Array,
    lastMeshWorldVersion: -1,
    lastGeometryVersion: -1,
    lastJointWorldVersions: new Int32Array(jointTargets.length).fill(-1),
  };
}

function createGpuSkinAttributes(
  joints: Uint16Array | Uint32Array,
  weights: Float32Array,
  jointCount: number,
): { joints: Float32Array; weights: Float32Array } {
  const gpuJoints = new Float32Array(joints.length);
  const gpuWeights = new Float32Array(joints.length);
  for (let vertexOffset = 0; vertexOffset < joints.length; vertexOffset += 4) {
    let weightSum = 0;
    for (let influence = 0; influence < 4; influence++) {
      const offset = vertexOffset + influence;
      const jointIndex = joints[offset] ?? 0;
      const weight = weights[offset] ?? 0;
      if (jointIndex >= 0 && jointIndex < jointCount) {
        gpuJoints[offset] = jointIndex;
        gpuWeights[offset] = Number.isFinite(weight) && weight > 0 ? weight : 0;
        weightSum += gpuWeights[offset];
      } else {
        gpuJoints[offset] = 0;
        gpuWeights[offset] = 0;
      }
    }
    if (weightSum > 0) {
      for (let influence = 0; influence < 4; influence++) {
        const offset = vertexOffset + influence;
        gpuWeights[offset] = (gpuWeights[offset] ?? 0) / weightSum;
      }
    }
  }
  return { joints: gpuJoints, weights: gpuWeights };
}
