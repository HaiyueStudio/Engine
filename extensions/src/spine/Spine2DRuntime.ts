import { EngineError, EngineErrorCode } from '@haiyue/engine';
import { ErrorDomain, ErrorRecovery } from '@haiyue/engine/core';
import { createAbortError, parseAssetWorkerFirst } from '@haiyue/engine/experimental/async';
import { Spine2DComponent } from './Spine2DComponent';
import { Spine2DGpuRenderer, type AtlasPageGpu, type SpineBufferDirtyRange } from './Spine2DGpuRenderer';
import { compileAnimationBoneTimelines, getAnimationBoneTimelines } from './SpineAnimationBoneTimelines';
import { SpineFloatBuilder } from './SpineFloatBuilder';
import { parseAtlas, type AtlasRegion } from './SpineAtlasParser';
import {
  applyPathConstraint,
  createSpinePathConstraintScratch,
  type SpinePathConstraintScratch,
} from './SpinePathConstraintSolver';
import {
  appendBoneDebug,
  appendMeshVertices,
  appendMeshWireframe,
  appendRegionVertices,
  appendRegionWireframe,
  computeClipPolygon,
  copyBuilderData,
  createEmptySlotCache,
  getDebugBonesSignature,
  getSlotBuildSignature,
  getSlotOrderHash,
  hasInvalidOffsets,
  hashInt,
  normalizeBlend,
  rebuildCachedDrawBatches,
  rebuildCachedGeometryLayout,
  replaceClippedRange,
  type SpineDrawBatch,
  type SpineSlotGeometryCache,
} from './SpineVertexBuilder';
import {
  type BonePose,
  type IkConstraintData,
  type PathConstraintData,
  type SliderAnimationState,
  type SliderConstraintData,
  type SlotData,
  type SpineAnimationData,
  type SpineData,
  type TransformConstraintData,
} from './SpineSkeletonRuntime';
import {
  compileSpineTimelines,
  createSpineTimelineSamplerState,
  findCompiledFrameIndex,
  getCompiledAnimationDuration,
  sampleCompiledTimeline as sampleTimeline,
  type SpineTimelineCompileStats,
  type SpineTimelineSamplerState,
} from './SpineTimelineRuntime';
import {
  getSpineAttachmentRegionName,
  getSpineSlotAttachmentName,
  getSpineSlotColor,
} from './SpineSlotAnimation';
import { SPINE_ASSET_PARSER, type SpineParsedAsset } from './SpineAssetParser';
import type { SpineAssetWorker } from './SpineAssetWorkerContract';
import { requiredItemAt, requiredNumberAt } from '../utils/arrayAccess';

export interface SpineVertexBuild {
  vertices: SpineFloatBuilder;
  batches: SpineDrawBatch[];
  debugVertices: SpineFloatBuilder;
  vertexDirtyRanges: SpineBufferDirtyRange[];
  debugDirtyRanges: SpineBufferDirtyRange[];
  verticesChanged: boolean;
  debugVerticesChanged: boolean;
}

export interface SpineRuntimeAllocationStats {
  slotRegionGrowths: number;
  batchPoolMisses: number;
  dirtyRangePoolMisses: number;
}

type SpineConstraintEntry =
  | { type: 'ik'; order: number; constraint: IkConstraintData }
  | { type: 'path'; order: number; constraint: PathConstraintData }
  | { type: 'transform'; order: number; constraint: TransformConstraintData };

class LocalPoseSnapshot {
  data: Float32Array;
  length = 0;

  constructor(initialCapacity = 256) {
    this.data = new Float32Array(initialCapacity);
  }

  capture(poses: Map<string, BonePose>): void {
    const required = poses.size * 7;
    if (this.data.length < required) {
      let nextCapacity = Math.max(1, this.data.length);
      while (nextCapacity < required) nextCapacity *= 2;
      this.data = new Float32Array(nextCapacity);
    }

    let offset = 0;
    for (const pose of poses.values()) {
      this.data[offset++] = pose.x;
      this.data[offset++] = pose.y;
      this.data[offset++] = pose.rotation;
      this.data[offset++] = pose.shearX;
      this.data[offset++] = pose.shearY;
      this.data[offset++] = pose.scaleX;
      this.data[offset++] = pose.scaleY;
    }
    this.length = offset;
  }
}

export interface SpineRuntime extends SpinePathConstraintScratch {
  data: SpineData;
  atlas: Map<string, AtlasRegion>;
  pages: Map<string, AtlasPageGpu>;
  vertexBuffer: GPUBuffer;
  vertexBufferSize: number;
  debugVertexBuffer: GPUBuffer;
  debugVertexBufferSize: number;
  batches: SpineDrawBatch[];
  batchPool: SpineDrawBatch[];
  vertexBuilder: SpineFloatBuilder;
  debugVertexBuilder: SpineFloatBuilder;
  slotVertexBuilder: SpineFloatBuilder;
  slotDebugVertexBuilder: SpineFloatBuilder;
  clipBuilder: SpineFloatBuilder;
  meshPointBuilder: SpineFloatBuilder;
  slotGeometryCache: Map<string, SpineSlotGeometryCache>;
  slotOrderHash: number;
  boneChildren: Map<string, string[]>;
  setupPoses: Map<string, BonePose>;
  previousSetupPoses: Map<string, BonePose>;
  slotIndexByName: Map<string, number>;
  slotCacheKeyByName: Map<string, string>;
  sliderConstraintsByOrder: SliderConstraintData[];
  sortedConstraintsBySkin: Map<string, SpineConstraintEntry[]>;
  transformConstraintBoneSets: WeakMap<TransformConstraintData, Set<string>>;
  transformWorldSpaceBonesScratch: string[];
  drawOrderScratch: number[];
  unchangedSlotScratch: number[];
  orderedSlotScratch: SlotData[];
  liveSlotKeys: Set<string>;
  slotEntries: SpineSlotGeometryCache[];
  changedVertexEntries: SpineSlotGeometryCache[];
  changedDebugEntries: SpineSlotGeometryCache[];
  sliderStateScratch: SliderAnimationState[];
  sliderStatePool: SliderAnimationState[];
  vertexDirtyRanges: SpineBufferDirtyRange[];
  debugDirtyRanges: SpineBufferDirtyRange[];
  mergedDirtyRanges: SpineBufferDirtyRange[];
  vertexDirtyRangePool: SpineBufferDirtyRange[];
  debugDirtyRangePool: SpineBufferDirtyRange[];
  mergedDirtyRangePool: SpineBufferDirtyRange[];
  vertexBuildResult: SpineVertexBuild;
  slotColorScratch: [number, number, number, number];
  sliderColorScratch: [number, number, number, number];
  vertexColorScratch: [number, number, number, number];
  timelineCompileStats: SpineTimelineCompileStats;
  timelineSamplerState: SpineTimelineSamplerState;
  allocationStats: SpineRuntimeAllocationStats;
  ikStateScratch: { mix: number; softness: number; bendPositive: boolean };
  transformStateScratch: Pick<TransformConstraintData, 'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'>;
}

const sliderPoseSnapshots = new WeakMap<Spine2DComponent, LocalPoseSnapshot>();
const TWO_PI = Math.PI * 2;
const PATH_CONSTRAINT_DEPS = { normalizeRadians, updateDescendantBoneTrees };

function getSliderPoseSnapshot(component: Spine2DComponent): LocalPoseSnapshot {
  let snapshot = sliderPoseSnapshots.get(component);
  if (!snapshot) {
    snapshot = new LocalPoseSnapshot();
    sliderPoseSnapshots.set(component, snapshot);
  }
  return snapshot;
}

export function advanceSpineRuntime(component: Spine2DComponent, delta: number): void {
  component.elapsed += delta * component.timeScale;
  if (component.previousAnimation) component.mixElapsed += delta * component.timeScale;
  if (component.previousAnimation && component.mixElapsed >= component.mixDuration * 1000) component.previousAnimation = '';
}

export function buildSpineVertices(component: Spine2DComponent, runtime: SpineRuntime): SpineVertexBuild {
  const poses = computePoses(runtime, component);
  const floats = runtime.vertexBuilder;
  const debugFloats = runtime.debugVertexBuilder;
  const skin = runtime.data.skins[component.skin] ?? runtime.data.skins.default ?? {};
  const time = getCurrentAnimationTime(runtime.data, component);
  const sliderStates = computeSliderAnimationStates(runtime, component, poses);
  const entries = runtime.slotEntries;
  const changedVertexEntries = runtime.changedVertexEntries;
  const changedDebugEntries = runtime.changedDebugEntries;
  const liveKeys = runtime.liveSlotKeys;
  entries.length = 0;
  changedVertexEntries.length = 0;
  changedDebugEntries.length = 0;
  liveKeys.clear();
  let clip: { endSlot?: string; polygon: Array<[number, number]> } | null = null;
  for (const slot of getDrawOrderedSlots(runtime, component, time)) {
    const slotSkin = skin[slot.name] ?? {};
    const attachmentName = getSpineSlotAttachmentName(runtime, component, slot, time);
    if (!attachmentName) {
      if (clip?.endSlot === slot.name) clip = null;
      continue;
    }
    const attachment = slotSkin[attachmentName];
    if (!attachment || attachment.type === 'boundingbox') {
      if (clip?.endSlot === slot.name) clip = null;
      continue;
    }
    const bone = poses.get(slot.bone);
    if (attachment.type === 'clipping') {
      if (bone) clip = {
        ...(attachment.end === undefined ? {} : { endSlot: attachment.end }),
        polygon: computeClipPolygon(bone, attachment, component.scale),
      };
      continue;
    }
    const regionName = getSpineAttachmentRegionName(
      runtime,
      component,
      slot,
      attachmentName,
      attachment,
      time,
      sliderStates,
    );
    const region = runtime.atlas.get(regionName) ?? runtime.atlas.get(attachment.path || attachment.name || attachmentName) ?? runtime.atlas.get(attachmentName);
    if (!bone || !region) {
      if (clip?.endSlot === slot.name) clip = null;
      continue;
    }
    const slotColor = getSpineSlotColor(runtime, component, slot, time, sliderStates);
    const cacheKey = runtime.slotCacheKeyByName.get(slot.name) ?? slot.name;
    liveKeys.add(cacheKey);
    const signature = getSlotBuildSignature(
      slot, attachmentName, attachment, regionName, region, bone, poses, slotColor, clip, component,
    );
    const debugSignature = component.debugMesh ? hashInt(signature, 1) : 0;
    let cache = runtime.slotGeometryCache.get(cacheKey);
    const verticesChanged = !cache || cache.signature !== signature;
    const debugChanged = !cache || cache.debugSignature !== debugSignature;
    if (!cache) {
      cache = createEmptySlotCache(cacheKey);
      runtime.slotGeometryCache.set(cacheKey, cache);
    }
    if (verticesChanged || debugChanged) {
      runtime.slotVertexBuilder.clear();
      runtime.slotDebugVertexBuilder.clear();
      if (attachment.type === 'mesh') {
        appendMeshVertices(runtime.slotVertexBuilder, component, runtime, runtime.data, poses, bone, slotColor, attachment, region);
        if (component.debugMesh) appendMeshWireframe(runtime.slotDebugVertexBuilder, component, runtime, runtime.data, poses, bone, attachment);
      } else {
        appendRegionVertices(runtime.slotVertexBuilder, component, runtime, bone, slotColor, attachment, region);
        if (component.debugMesh) appendRegionWireframe(runtime.slotDebugVertexBuilder, component, bone, attachment, region);
      }
      if (clip) replaceClippedRange(runtime.slotVertexBuilder, 0, clip.polygon, runtime.clipBuilder);
      const previousVertexCapacity = cache.vertexCapacity;
      const previousDebugCapacity = cache.debugVertexCapacity;
      const previousDebugLength = cache.debugVertexLength;
      cache.signature = signature;
      cache.debugSignature = debugSignature;
      const previousVertices = cache.vertices;
      cache.vertices = copyBuilderData(runtime.slotVertexBuilder, cache.vertices);
      if (cache.vertices !== previousVertices) runtime.allocationStats.slotRegionGrowths++;
      cache.vertexLength = runtime.slotVertexBuilder.length;
      cache.vertexCapacity = cache.vertices.length;
      const previousDebugVertices = cache.debugVertices;
      cache.debugVertices = copyBuilderData(runtime.slotDebugVertexBuilder, cache.debugVertices);
      if (cache.debugVertices !== previousDebugVertices) runtime.allocationStats.slotRegionGrowths++;
      cache.debugVertexLength = runtime.slotDebugVertexBuilder.length;
      cache.debugVertexCapacity = cache.debugVertices.length;
      cache.batch.blend = normalizeBlend(slot.blend);
      cache.batch.page = region.page;
      cache.batch.vertexCount = cache.vertexLength / 8;
      if (cache.vertexCapacity !== previousVertexCapacity) cache.vertexOffset = -1;
      if (cache.debugVertexCapacity !== previousDebugCapacity || cache.debugVertexLength !== previousDebugLength) {
        cache.debugVertexOffset = -1;
      }
    }
    if (verticesChanged) changedVertexEntries.push(cache);
    if (debugChanged) changedDebugEntries.push(cache);
    entries.push(cache);
    if (clip?.endSlot === slot.name) clip = null;
  }
  if (component.debugBones) {
    const cacheKey = '__debug_bones__';
    liveKeys.add(cacheKey);
    const signature = 0;
    const debugSignature = getDebugBonesSignature(component.scale, poses);
    let cache = runtime.slotGeometryCache.get(cacheKey);
    const debugChanged = !cache || cache.debugSignature !== debugSignature;
    if (!cache) {
      cache = createEmptySlotCache(cacheKey);
      runtime.slotGeometryCache.set(cacheKey, cache);
    }
    if (debugChanged) {
      runtime.slotDebugVertexBuilder.clear();
      appendBoneDebug(runtime.slotDebugVertexBuilder, runtime.data, poses, component.scale);
      const previousDebugCapacity = cache.debugVertexCapacity;
      const previousDebugLength = cache.debugVertexLength;
      cache.signature = signature;
      cache.debugSignature = debugSignature;
      cache.vertexLength = 0;
      const previousDebugVertices = cache.debugVertices;
      cache.debugVertices = copyBuilderData(runtime.slotDebugVertexBuilder, cache.debugVertices);
      if (cache.debugVertices !== previousDebugVertices) runtime.allocationStats.slotRegionGrowths++;
      cache.debugVertexLength = runtime.slotDebugVertexBuilder.length;
      cache.debugVertexCapacity = cache.debugVertices.length;
      cache.batch.vertexCount = 0;
      if (cache.debugVertexCapacity !== previousDebugCapacity || cache.debugVertexLength !== previousDebugLength) {
        cache.debugVertexOffset = -1;
      }
    }
    if (debugChanged) changedDebugEntries.push(cache);
    entries.push(cache);
  }
  for (const key of runtime.slotGeometryCache.keys()) {
    if (!liveKeys.has(key)) runtime.slotGeometryCache.delete(key);
  }

  const slotOrderHash = getSlotOrderHash(entries);
  const layoutChanged = runtime.slotOrderHash !== slotOrderHash || hasInvalidOffsets(entries);
  const vertexDirtyRanges = runtime.vertexDirtyRanges;
  const debugDirtyRanges = runtime.debugDirtyRanges;
  vertexDirtyRanges.length = 0;
  debugDirtyRanges.length = 0;
  if (layoutChanged) {
    rebuildCachedGeometryLayout(runtime, entries);
    runtime.slotOrderHash = slotOrderHash;
    if (floats.byteLength > 0) pushDirtyRange(runtime, vertexDirtyRanges, runtime.vertexDirtyRangePool, 0, floats.byteLength);
    if (debugFloats.byteLength > 0) pushDirtyRange(runtime, debugDirtyRanges, runtime.debugDirtyRangePool, 0, debugFloats.byteLength);
  } else {
    for (const entry of changedVertexEntries) {
      if (entry.vertexLength === 0) continue;
      for (let index = 0; index < entry.vertexLength; index++) {
        floats.data[entry.vertexOffset + index] = entry.vertices[index] ?? 0;
      }
      pushDirtyRange(runtime, vertexDirtyRanges, runtime.vertexDirtyRangePool, entry.vertexOffset * 4, entry.vertexLength * 4);
    }
    for (const entry of changedDebugEntries) {
      if (entry.debugVertexLength === 0) continue;
      for (let index = 0; index < entry.debugVertexLength; index++) {
        debugFloats.data[entry.debugVertexOffset + index] = entry.debugVertices[index] ?? 0;
      }
      pushDirtyRange(runtime, debugDirtyRanges, runtime.debugDirtyRangePool, entry.debugVertexOffset * 4, entry.debugVertexLength * 4);
    }
  }
  rebuildCachedDrawBatches(runtime, entries);
  const result = runtime.vertexBuildResult;
  result.verticesChanged = vertexDirtyRanges.length > 0;
  result.debugVerticesChanged = debugDirtyRanges.length > 0;
  return result;
}

function pushDirtyRange(
  runtime: SpineRuntime,
  ranges: SpineBufferDirtyRange[],
  pool: SpineBufferDirtyRange[],
  byteOffset: number,
  byteLength: number,
): void {
  const index = ranges.length;
  let range = pool[index];
  if (!range) {
    range = { byteOffset, byteLength };
    pool.push(range);
    runtime.allocationStats.dirtyRangePoolMisses++;
  } else {
    range.byteOffset = byteOffset;
    range.byteLength = byteLength;
  }
  ranges.push(range);
}

export async function loadSpineRuntime(
  gpuRenderer: Spine2DGpuRenderer,
  component: Spine2DComponent,
  options: { assetWorker?: SpineAssetWorker | null; signal?: AbortSignal } = {},
): Promise<SpineRuntime> {
  try {
    return await loadSpineRuntimeUnchecked(gpuRenderer, component, options);
  } catch (error) {
    if (error instanceof EngineError) {
      throw new EngineError(error.code, error.message, {
        domain: error.domain,
        recoverable: error.recoverable,
        recovery: error.recovery,
        context: {
          resourceType: 'skeleton/spine',
          jsonUrl: component.jsonUrl,
          atlasUrl: component.atlasUrl,
          ...error.context,
        },
        ...(error.path === undefined ? {} : { path: error.path }),
        cause: error,
      });
    }
    throw new EngineError(EngineErrorCode.AssetInvalidData, 'Failed to create the Spine runtime.', {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.ReleaseResource,
      context: { resourceType: 'skeleton/spine', jsonUrl: component.jsonUrl, atlasUrl: component.atlasUrl },
      path: 'spine',
      cause: error,
    });
  }
}

async function loadSpineRuntimeUnchecked(
  gpuRenderer: Spine2DGpuRenderer,
  component: Spine2DComponent,
  options: { assetWorker?: SpineAssetWorker | null; signal?: AbortSignal },
): Promise<SpineRuntime> {
  const parsed = await parseAssetWorkerFirst({
    parser: {
      type: 'skeleton/spine',
      parse: (_input, context) => loadAndParseSpineMain(component, context.signal),
    },
    input: Object.freeze({ jsonUrl: component.jsonUrl, atlasUrl: component.atlasUrl }),
    context: { ...(options.signal ? { signal: options.signal } : {}), source: component.jsonUrl },
    worker: options.assetWorker
      ? async (_input, context) => requireSpineParsedAsset(await options.assetWorker!.loadParsedAsset(
          component.jsonUrl,
          component.atlasUrl,
          context.signal ? { signal: context.signal } : {},
        ), component.jsonUrl)
      : null,
  });
  throwIfAborted(options.signal);
  const data = parsed.data as SpineData;
  const atlas = new Map(parsed.regions);
  const pages = await gpuRenderer.loadAtlasPages(component, atlas);
  throwIfAborted(options.signal);
  const runtimeBuffers = gpuRenderer.createRuntimeBuffers();
  return createSpineRuntimeState(data, atlas, pages, runtimeBuffers);
}

function requireSpineParsedAsset(value: unknown, source: string): SpineParsedAsset {
  if (!value || typeof value !== 'object') throw invalidSpineWorkerPayload(source, value);
  const candidate = value as { data?: unknown; regions?: unknown };
  const data = candidate.data as { bones?: unknown } | null | undefined;
  if (!data || typeof data !== 'object' || !Array.isArray(data.bones) || !Array.isArray(candidate.regions)) {
    throw invalidSpineWorkerPayload(source, value);
  }
  return candidate as SpineParsedAsset;
}

function invalidSpineWorkerPayload(source: string, cause: unknown): EngineError {
  return new EngineError(EngineErrorCode.WorkerProtocolInvalid, 'Spine worker returned an invalid parsed asset.', {
    domain: ErrorDomain.Worker,
    recovery: ErrorRecovery.TerminateRuntime,
    context: { url: source, resourceType: 'skeleton/spine' },
    path: 'spine.worker.response',
    cause,
  });
}

function createSpineRuntimeState(
  data: SpineData,
  atlas: Map<string, AtlasRegion>,
  pages: Map<string, AtlasPageGpu>,
  runtimeBuffers: Pick<SpineRuntime, 'vertexBuffer' | 'vertexBufferSize' | 'debugVertexBuffer' | 'debugVertexBufferSize'>,
): SpineRuntime {
  const timelineSamplerState = createSpineTimelineSamplerState();
  const timelineCompileStats = compileSpineTimelines(data.animations, timelineSamplerState);
  compileAnimationBoneTimelines(data.animations);
  const vertexBuilder = new SpineFloatBuilder(1024);
  const debugVertexBuilder = new SpineFloatBuilder(256);
  const batches: SpineDrawBatch[] = [];
  const vertexDirtyRanges: SpineBufferDirtyRange[] = [];
  const debugDirtyRanges: SpineBufferDirtyRange[] = [];
  const rangePoolCapacity = Math.max(1, data.slots.length + 1);
  const vertexBuildResult: SpineVertexBuild = {
    vertices: vertexBuilder,
    batches,
    debugVertices: debugVertexBuilder,
    vertexDirtyRanges,
    debugDirtyRanges,
    verticesChanged: false,
    debugVerticesChanged: false,
  };
  return {
    data,
    atlas,
    pages,
    ...runtimeBuffers,
    batches,
    batchPool: createBatchPool(Math.max(1, data.slots.length)),
    vertexBuilder,
    debugVertexBuilder,
    slotVertexBuilder: new SpineFloatBuilder(256),
    slotDebugVertexBuilder: new SpineFloatBuilder(128),
    clipBuilder: new SpineFloatBuilder(256),
    meshPointBuilder: new SpineFloatBuilder(256),
    slotGeometryCache: new Map(),
    slotOrderHash: 0,
    boneChildren: buildBoneChildren(data),
    setupPoses: createSetupPoses(data),
    previousSetupPoses: createSetupPoses(data),
    slotIndexByName: buildSlotIndexByName(data),
    slotCacheKeyByName: buildSlotCacheKeys(data),
    sliderConstraintsByOrder: buildSliderConstraintsByOrder(data),
    sortedConstraintsBySkin: new Map(),
    transformConstraintBoneSets: new WeakMap(),
    transformWorldSpaceBonesScratch: [],
    drawOrderScratch: [],
    unchangedSlotScratch: [],
    orderedSlotScratch: [],
    liveSlotKeys: new Set(),
    slotEntries: [],
    changedVertexEntries: [],
    changedDebugEntries: [],
    sliderStateScratch: [],
    sliderStatePool: [],
    vertexDirtyRanges,
    debugDirtyRanges,
    mergedDirtyRanges: [],
    vertexDirtyRangePool: createDirtyRangePool(rangePoolCapacity),
    debugDirtyRangePool: createDirtyRangePool(rangePoolCapacity),
    mergedDirtyRangePool: createDirtyRangePool(rangePoolCapacity),
    vertexBuildResult,
    slotColorScratch: [1, 1, 1, 1],
    sliderColorScratch: [1, 1, 1, 1],
    vertexColorScratch: [1, 1, 1, 1],
    timelineCompileStats,
    timelineSamplerState,
    allocationStats: { slotRegionGrowths: 0, batchPoolMisses: 0, dirtyRangePoolMisses: 0 },
    ikStateScratch: { mix: 0, softness: 0, bendPositive: true },
    transformStateScratch: { mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0 },
    ...createSpinePathConstraintScratch(),
  };
}

function createDirtyRangePool(capacity: number): SpineBufferDirtyRange[] {
  return Array.from({ length: capacity }, () => ({ byteOffset: 0, byteLength: 0 }));
}

function createBatchPool(capacity: number): SpineDrawBatch[] {
  return Array.from({ length: capacity }, () => ({
    blend: 'normal' as const,
    page: '',
    firstVertex: 0,
    vertexCount: 0,
  }));
}

/** Monorepo benchmark adapter; not re-exported from the Spine package facade. */
export function createSpineRuntimeForBenchmark(
  data: SpineData,
  atlas: Map<string, AtlasRegion>,
  pages: Map<string, AtlasPageGpu>,
): SpineRuntime {
  const placeholderBuffer = {} as GPUBuffer;
  return createSpineRuntimeState(data, atlas, pages, {
    vertexBuffer: placeholderBuffer,
    vertexBufferSize: 0,
    debugVertexBuffer: placeholderBuffer,
    debugVertexBufferSize: 0,
  });
}

/** Monorepo benchmark adapter; samples the complete animation/constraint pose path. */
export function sampleSpinePosesForBenchmark(component: Spine2DComponent, runtime: SpineRuntime): number {
  let checksum = 0;
  for (const pose of computePoses(runtime, component).values()) {
    checksum += pose.worldX + pose.worldY + pose.a + pose.d;
  }
  return checksum;
}

async function loadAndParseSpineMain(component: Spine2DComponent, signal?: AbortSignal): Promise<SpineParsedAsset> {
  const [json, atlasText] = await Promise.all([
    fetchJson(component.jsonUrl, signal),
    component.atlasUrl ? fetchText(component.atlasUrl, signal) : Promise.resolve(''),
  ]);
  return await SPINE_ASSET_PARSER.parse(
    { json, atlasText },
    { source: component.jsonUrl, ...(signal === undefined ? {} : { signal }) },
  );
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new EngineError(EngineErrorCode.AssetLoadFailed, `Failed to load Spine JSON: ${response.status} ${response.statusText}`, {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.Retry,
      context: { url, resourceType: 'skeleton/spine-json', status: response.status },
      path: 'spine.json',
    });
  }
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw new EngineError(EngineErrorCode.AssetInvalidData, 'Spine JSON is not valid JSON.', {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.ReleaseResource,
      context: { url, resourceType: 'skeleton/spine-json' },
      path: 'spine.json',
      cause: error,
    });
  }
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new EngineError(EngineErrorCode.AssetLoadFailed, `Failed to load Spine atlas: ${response.status} ${response.statusText}`, {
      domain: ErrorDomain.Component,
      recovery: ErrorRecovery.Retry,
      context: { url, resourceType: 'skeleton/spine-atlas', status: response.status },
      path: 'spine.atlas',
    });
  }
  return response.text();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw createAbortError('Spine load aborted.', signal.reason);
}

function computePoses(runtime: SpineRuntime, component: Spine2DComponent): Map<string, BonePose> {
  const data = runtime.data;
  const children = runtime.boneChildren;
  const local = resetSetupPoses(runtime.setupPoses);
  if (
    component.previousAnimation
    && component.mixDuration > 0
    && component.mixElapsed < component.mixDuration * 1000
    && data.animations[component.previousAnimation]
  ) {
    const previous = resetSetupPoses(runtime.previousSetupPoses);
    applyAnimationAt(runtime, data, component.previousAnimation, component.previousElapsed / 1000, component.loop, previous);
    applyAnimationAt(runtime, data, component.animation, component.elapsed / 1000, component.loop, local);
    const alpha = Math.max(0, Math.min(1, component.mixElapsed / (component.mixDuration * 1000)));
    blendLocalPoses(local, previous, alpha);
  } else {
    applyAnimation(runtime, data, component, local);
  }
  applySliderBoneAnimations(runtime, component, local, true);
  updateWorldPoses(data, local);
  applyConstraints(runtime, component, local, children);
  if (applySliderBoneAnimations(runtime, component, local, false)) updateWorldPoses(data, local);
  return local;
}

function buildBoneChildren(data: SpineData): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const bone of data.bones) {
    if (!bone.parent) continue;
    const list = children.get(bone.parent) ?? [];
    list.push(bone.name);
    children.set(bone.parent, list);
  }
  return children;
}

function buildSlotIndexByName(data: SpineData): Map<string, number> {
  const indices = new Map<string, number>();
  for (let i = 0; i < data.slots.length; i++) {
    indices.set(requiredItemAt(data.slots, i, 'Spine slots').name, i);
  }
  return indices;
}

function buildSlotCacheKeys(data: SpineData): Map<string, string> {
  const keys = new Map<string, string>();
  for (const slot of data.slots) keys.set(slot.name, `slot:${slot.name}`);
  return keys;
}

function buildSliderConstraintsByOrder(data: SpineData): SliderConstraintData[] {
  return data.sliders.slice().sort((a, b) => a.order - b.order);
}

function createSetupPoses(data: SpineData): Map<string, BonePose> {
  const local = new Map<string, BonePose>();
  for (const bone of data.bones) {
    local.set(bone.name, {
      data: bone,
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      worldX: 0,
      worldY: 0,
      rotation: bone.rotation,
      shearX: bone.shearX,
      shearY: bone.shearY,
      x: bone.x,
      y: bone.y,
      scaleX: bone.scaleX,
      scaleY: bone.scaleY,
    });
  }
  return local;
}

function resetSetupPoses(poses: Map<string, BonePose>): Map<string, BonePose> {
  for (const pose of poses.values()) {
    const bone = pose.data;
    pose.a = 1;
    pose.b = 0;
    pose.c = 0;
    pose.d = 1;
    pose.worldX = 0;
    pose.worldY = 0;
    pose.rotation = bone.rotation;
    pose.shearX = bone.shearX;
    pose.shearY = bone.shearY;
    pose.x = bone.x;
    pose.y = bone.y;
    pose.scaleX = bone.scaleX;
    pose.scaleY = bone.scaleY;
  }
  return poses;
}

function blendLocalPoses(current: Map<string, BonePose>, previous: Map<string, BonePose>, alpha: number): void {
  for (const [name, pose] of current) {
    const from = previous.get(name);
    if (!from) continue;
    pose.x = lerpNumber(from.x, pose.x, alpha);
    pose.y = lerpNumber(from.y, pose.y, alpha);
    pose.rotation = from.rotation + normalizeAngle(pose.rotation - from.rotation) * alpha;
    pose.shearX = lerpNumber(from.shearX, pose.shearX, alpha);
    pose.shearY = lerpNumber(from.shearY, pose.shearY, alpha);
    pose.scaleX = lerpNumber(from.scaleX, pose.scaleX, alpha);
    pose.scaleY = lerpNumber(from.scaleY, pose.scaleY, alpha);
  }
}

function blendLocalPosesFromSnapshot(current: Map<string, BonePose>, previous: LocalPoseSnapshot, alpha: number): void {
  let offset = 0;
  for (const pose of current.values()) {
    if (offset + 6 >= previous.length) return;
    const fromX = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromY = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromRotation = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromShearX = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromShearY = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromScaleX = requiredNumberAt(previous.data, offset++, 'previous local pose');
    const fromScaleY = requiredNumberAt(previous.data, offset++, 'previous local pose');
    pose.x = lerpNumber(fromX, pose.x, alpha);
    pose.y = lerpNumber(fromY, pose.y, alpha);
    pose.rotation = fromRotation + normalizeAngle(pose.rotation - fromRotation) * alpha;
    pose.shearX = lerpNumber(fromShearX, pose.shearX, alpha);
    pose.shearY = lerpNumber(fromShearY, pose.shearY, alpha);
    pose.scaleX = lerpNumber(fromScaleX, pose.scaleX, alpha);
    pose.scaleY = lerpNumber(fromScaleY, pose.scaleY, alpha);
  }
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function getDrawOrderedSlots(runtime: SpineRuntime, component: Spine2DComponent, time: number): SlotData[] {
  const data = runtime.data;
  const frames = data.animations[component.animation]?.drawOrder;
  if (!Array.isArray(frames) || frames.length === 0) return data.slots;
  const frameIndex = findCompiledFrameIndex(frames, time, runtime.timelineSamplerState);
  const frame = frameIndex >= 0 ? frames[frameIndex] : null;
  if (!frame?.offsets?.length) return data.slots;

  const drawOrder = runtime.drawOrderScratch;
  const unchanged = runtime.unchangedSlotScratch;
  const ordered = runtime.orderedSlotScratch;
  drawOrder.length = data.slots.length;
  unchanged.length = 0;
  ordered.length = 0;
  for (let i = 0; i < drawOrder.length; i++) drawOrder[i] = -1;
  let originalIndex = 0;
  for (const offset of frame.offsets) {
    const slotIndex = runtime.slotIndexByName.get(offset.slot) ?? -1;
    if (slotIndex < 0) continue;
    while (originalIndex < slotIndex) unchanged.push(originalIndex++);
    const drawIndex = originalIndex + (offset.offset ?? 0);
    if (drawIndex >= 0 && drawIndex < drawOrder.length) drawOrder[drawIndex] = originalIndex;
    originalIndex++;
  }
  while (originalIndex < data.slots.length) unchanged.push(originalIndex++);
  let unchangedIndex = unchanged.length - 1;
  for (let i = drawOrder.length - 1; i >= 0; i--) {
    if (drawOrder[i] === -1) drawOrder[i] = unchanged[unchangedIndex--] ?? i;
  }
  for (let i = 0; i < drawOrder.length; i++) {
    const drawIndex = drawOrder[i];
    const slot = drawIndex === undefined ? undefined : data.slots[drawIndex];
    if (slot) ordered.push(slot);
  }
  return ordered;
}

function updateWorldPoses(data: SpineData, poses: Map<string, BonePose>): void {
  for (const bone of data.bones) {
    const pose = poses.get(bone.name)!;
    const parent = bone.parent ? poses.get(bone.parent) ?? null : null;
    updateWorldPose(pose, parent);
  }
}

function updateWorldPose(pose: BonePose, parent: BonePose | null): void {
  const rx = (pose.rotation + pose.shearX) * Math.PI / 180;
  const ry = (pose.rotation + 90 + pose.shearY) * Math.PI / 180;
  const la = Math.cos(rx) * pose.scaleX;
  const lb = Math.cos(ry) * pose.scaleY;
  const lc = Math.sin(rx) * pose.scaleX;
  const ld = Math.sin(ry) * pose.scaleY;
  if (!parent) {
    pose.worldX = pose.x;
    pose.worldY = pose.y;
    pose.a = la;
    pose.b = lb;
    pose.c = lc;
    pose.d = ld;
    return;
  }

  pose.worldX = parent.a * pose.x + parent.b * pose.y + parent.worldX;
  pose.worldY = parent.c * pose.x + parent.d * pose.y + parent.worldY;

  switch (pose.data.inherit) {
    case 'onlyTranslation':
      pose.a = la;
      pose.b = lb;
      pose.c = lc;
      pose.d = ld;
      return;
    case 'noRotationOrReflection':
      updateNoRotationOrReflectionWorldPose(pose, parent);
      return;
    case 'noScale':
    case 'noScaleOrReflection':
      updateNoScaleWorldPose(pose, parent);
      return;
    default:
      pose.a = parent.a * la + parent.b * lc;
      pose.b = parent.a * lb + parent.b * ld;
      pose.c = parent.c * la + parent.d * lc;
      pose.d = parent.c * lb + parent.d * ld;
  }
}

function updateNoRotationOrReflectionWorldPose(pose: BonePose, parent: BonePose): void {
  let pa = parent.a;
  let pb = parent.b;
  let pc = parent.c;
  let pd = parent.d;

  let s = pa * pa + pc * pc;
  let rotation = 0;
  if (s > 0.000001) {
    s = Math.abs(pa * pd - pb * pc) / s;
    pb = pc * s;
    pd = pa * s;
    rotation = pose.rotation - Math.atan2(pc, pa) * 180 / Math.PI;
  } else {
    pa = 0;
    pc = 0;
    rotation = pose.rotation - 90 + Math.atan2(pd, pb) * 180 / Math.PI;
  }

  const rx = (rotation + pose.shearX) * Math.PI / 180;
  const ry = (rotation + 90 + pose.shearY) * Math.PI / 180;
  const la = Math.cos(rx) * pose.scaleX;
  const lb = Math.cos(ry) * pose.scaleY;
  const lc = Math.sin(rx) * pose.scaleX;
  const ld = Math.sin(ry) * pose.scaleY;
  pose.a = pa * la - pb * lc;
  pose.b = pa * lb - pb * ld;
  pose.c = pc * la + pd * lc;
  pose.d = pc * lb + pd * ld;
}

function updateNoScaleWorldPose(pose: BonePose, parent: BonePose): void {
  const rotation = pose.rotation * Math.PI / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let za = parent.a * cos + parent.b * sin;
  let zc = parent.c * cos + parent.d * sin;
  const length = Math.sqrt(za * za + zc * zc);
  if (length > 0.000001) {
    za /= length;
    zc /= length;
  }
  let zb = -zc;
  let zd = za;
  const determinant = parent.a * parent.d - parent.b * parent.c;
  if (pose.data.inherit === 'noScale' && determinant < 0) {
    zb = -zb;
    zd = -zd;
  }

  const rx = pose.shearX * Math.PI / 180;
  const ry = (90 + pose.shearY) * Math.PI / 180;
  const la = Math.cos(rx) * pose.scaleX;
  const lb = Math.cos(ry) * pose.scaleY;
  const lc = Math.sin(rx) * pose.scaleX;
  const ld = Math.sin(ry) * pose.scaleY;
  pose.a = za * la + zb * lc;
  pose.b = za * lb + zb * ld;
  pose.c = zc * la + zd * lc;
  pose.d = zc * lb + zd * ld;
}

function applyAnimation(runtime: SpineRuntime, data: SpineData, component: Spine2DComponent, poses: Map<string, BonePose>): void {
  applyAnimationAt(runtime, data, component.animation, getCurrentAnimationTime(data, component), component.loop, poses);
}

function applyAnimationAt(runtime: SpineRuntime, data: SpineData, animationName: string, rawTime: number, loop: boolean, poses: Map<string, BonePose>): void {
  const animation = data.animations[animationName];
  if (!animation?.bones) return;
  const duration = getCompiledAnimationDuration(animation);
  const time = loop && duration > 0 ? rawTime % duration : Math.min(rawTime, duration);
  for (const entry of getAnimationBoneTimelines(animation)) {
    const pose = poses.get(entry.boneName);
    if (!pose) continue;
    const timelines = entry.timelines;
    if (timelines.rotate) pose.rotation = pose.data.rotation + sampleTimeline(timelines.rotate, time, 'angle', 0, duration, loop, runtime.timelineSamplerState);
    if (timelines.translate) {
      pose.x = pose.data.x + sampleTimeline(timelines.translate, time, 'x', 0, duration, loop, runtime.timelineSamplerState);
      pose.y = pose.data.y + sampleTimeline(timelines.translate, time, 'y', 0, duration, loop, runtime.timelineSamplerState);
    }
    if (timelines.scale) {
      pose.scaleX = pose.data.scaleX * sampleTimeline(timelines.scale, time, 'x', 1, duration, loop, runtime.timelineSamplerState);
      pose.scaleY = pose.data.scaleY * sampleTimeline(timelines.scale, time, 'y', 1, duration, loop, runtime.timelineSamplerState);
    }
    if (timelines.shear) {
      pose.shearX = pose.data.shearX + sampleTimeline(timelines.shear, time, 'x', 0, duration, loop, runtime.timelineSamplerState);
      pose.shearY = pose.data.shearY + sampleTimeline(timelines.shear, time, 'y', 0, duration, loop, runtime.timelineSamplerState);
    }
  }
}

function computeSliderAnimationStates(
  runtime: SpineRuntime,
  component: Spine2DComponent,
  poses: Map<string, BonePose>,
  localOnly?: boolean,
): SliderAnimationState[] {
  const data = runtime.data;
  const states = runtime.sliderStateScratch;
  states.length = 0;
  if (!runtime.sliderConstraintsByOrder.length) return states;
  const currentAnimation = data.animations[component.animation];
  const currentDuration = getCompiledAnimationDuration(currentAnimation);
  const currentTime = getCurrentAnimationTime(data, component);
  for (const slider of runtime.sliderConstraintsByOrder) {
    if (localOnly !== undefined && slider.local !== localOnly) continue;
    if (slider.animation === component.animation) continue;
    if (!slider.animation || slider.mix <= 0 || !data.animations[slider.animation]) continue;
    if (!isConstraintActiveForSkin(data, component.skin, 'slider', slider.name, slider.skin)) continue;
    const mix = sampleTimeline(currentAnimation?.slider?.[slider.name]?.mix ?? [], currentTime, 'mix', slider.mix, currentDuration, component.loop, runtime.timelineSamplerState);
    if (mix <= 0) continue;
    const duration = getCompiledAnimationDuration(data.animations[slider.animation]);
    let time = slider.offset;
    if (slider.bone) {
      const bone = poses.get(slider.bone);
      if (!bone) continue;
      time += getSliderBoneProperty(bone, slider.property, slider.local) * slider.scale;
    }
    if (slider.loop && duration > 0) {
      time %= duration;
      if (time < 0) time += duration;
    } else {
      time = Math.max(0, Math.min(time, duration));
    }
    const stateIndex = states.length;
    let state = runtime.sliderStatePool[stateIndex];
    if (!state) {
      state = { animation: slider.animation, time, loop: slider.loop, mix };
      runtime.sliderStatePool.push(state);
    } else {
      state.animation = slider.animation;
      state.time = time;
      state.loop = slider.loop;
      state.mix = mix;
    }
    states.push(state);
  }
  return states;
}

function applySliderBoneAnimations(
  runtime: SpineRuntime,
  component: Spine2DComponent,
  poses: Map<string, BonePose>,
  localOnly: boolean,
): boolean {
  const data = runtime.data;
  let applied = false;
  let before: LocalPoseSnapshot | null = null;
  for (const slider of computeSliderAnimationStates(runtime, component, poses, localOnly)) {
    if (!data.animations[slider.animation]?.bones) continue;
    if (slider.mix < 1) {
      before ??= getSliderPoseSnapshot(component);
      before.capture(poses);
    }
    applyAnimationAt(runtime, data, slider.animation, slider.time, slider.loop, poses);
    if (slider.mix < 1 && before) blendLocalPosesFromSnapshot(poses, before, slider.mix);
    applied = true;
  }
  return applied;
}

function getSliderBoneProperty(bone: BonePose, property: string, local: boolean): number {
  if (local) {
    if (property === 'x') return bone.x;
    if (property === 'y') return bone.y;
    if (property === 'scaleX') return bone.scaleX;
    if (property === 'scaleY') return bone.scaleY;
    if (property === 'shearX') return bone.shearX;
    if (property === 'shearY') return bone.shearY;
    return bone.rotation;
  }
  if (property === 'x') return bone.worldX;
  if (property === 'y') return bone.worldY;
  if (property === 'scaleX') return Math.hypot(bone.a, bone.c);
  if (property === 'scaleY') return Math.hypot(bone.b, bone.d);
  if (property === 'shearY') return Math.atan2(bone.d, bone.b) * 180 / Math.PI - Math.atan2(bone.c, bone.a) * 180 / Math.PI - 90;
  return Math.atan2(bone.c, bone.a) * 180 / Math.PI;
}

function applyConstraints(
  runtime: SpineRuntime,
  component: Spine2DComponent,
  poses: Map<string, BonePose>,
  children: Map<string, string[]>,
): void {
  const data = runtime.data;
  const animation = data.animations[component.animation];
  const duration = getCompiledAnimationDuration(animation);
  const time = getCurrentAnimationTime(data, component);
  const constraints = getSortedConstraintEntries(runtime, component.skin);
  for (const constraint of constraints) {
    if (constraint.type === 'ik') {
      applyIkConstraint(runtime, animation, constraint.constraint, time, duration, component.loop, poses, children);
    } else if (constraint.type === 'path') {
      applyPathConstraint(
        runtime, component, constraint.constraint, time, duration, component.loop, poses, children,
        PATH_CONSTRAINT_DEPS,
      );
    } else {
      applyTransformConstraint(runtime, animation, constraint.constraint, time, duration, component.loop, poses, children);
    }
  }
}

function getSortedConstraintEntries(runtime: SpineRuntime, skinName: string): SpineConstraintEntry[] {
  const cached = runtime.sortedConstraintsBySkin.get(skinName);
  if (cached) return cached;

  const data = runtime.data;
  const constraints: SpineConstraintEntry[] = [];
  for (const constraint of data.ik) {
    if (isConstraintActiveForSkin(data, skinName, 'ik', constraint.name, constraint.skin)) {
      constraints.push({ type: 'ik', order: constraint.order, constraint });
    }
  }
  for (const constraint of data.path) {
    if (isConstraintActiveForSkin(data, skinName, 'path', constraint.name, constraint.skin)) {
      constraints.push({ type: 'path', order: constraint.order, constraint });
    }
  }
  for (const constraint of data.transform) {
    if (isConstraintActiveForSkin(data, skinName, 'transform', constraint.name, constraint.skin)) {
      constraints.push({ type: 'transform', order: constraint.order, constraint });
    }
  }
  constraints.sort((a, b) => a.order - b.order);
  runtime.sortedConstraintsBySkin.set(skinName, constraints);
  return constraints;
}

function isConstraintActiveForSkin(
  data: SpineData,
  skinName: string,
  type: 'ik' | 'path' | 'transform' | 'slider',
  constraintName: string,
  skinRequired: boolean,
): boolean {
  if (!skinRequired) return true;
  return data.skinConstraints[skinName]?.[type]?.includes(constraintName) ?? false;
}

function applyIkConstraint(
  runtime: SpineRuntime,
  animation: SpineAnimationData | undefined,
  constraint: IkConstraintData,
  time: number,
  duration: number,
  loop: boolean,
  poses: Map<string, BonePose>,
  children: Map<string, string[]>,
): void {
  const timeline = animation?.ik?.[constraint.name];
  const state = sampleIkConstraint(
    constraint, timeline, time, duration, loop, runtime.ikStateScratch, runtime.timelineSamplerState,
  );
  if (state.mix <= 0) return;
  if (constraint.bones.length === 1) {
    const rootBone = constraint.bones[0];
    if (rootBone === undefined) return;
    applyOneBoneIk(constraint, state, poses);
    updateBoneTree(rootBone, poses, children);
  } else if (constraint.bones.length === 2) {
    const rootBone = constraint.bones[0];
    if (rootBone === undefined) return;
    applyTwoBoneIk(constraint, state, poses);
    updateBoneTree(rootBone, poses, children);
  }
}

function sampleIkConstraint(
  constraint: IkConstraintData,
  frames: unknown[] | undefined,
  time: number,
  duration: number,
  loop: boolean,
  out: { mix: number; softness: number; bendPositive: boolean },
  samplerState: SpineTimelineSamplerState,
): { mix: number; softness: number; bendPositive: boolean } {
  out.mix = sampleTimeline(frames ?? [], time, 'mix', constraint.mix, duration, loop, samplerState);
  out.softness = sampleTimeline(frames ?? [], time, 'softness', constraint.softness, duration, loop, samplerState);
  let bendPositive = constraint.bendPositive;
  if (!Array.isArray(frames) || frames.length === 0) {
    out.bendPositive = bendPositive;
    return out;
  }
  const frameIndex = findCompiledFrameIndex(frames, time, samplerState);
  const frame = frameIndex >= 0 ? frames[frameIndex] : null;
  if (frame && typeof frame === 'object') {
    const value = (frame as Record<string, unknown>).bendPositive;
    if (typeof value === 'boolean') bendPositive = value;
  }
  out.bendPositive = bendPositive;
  return out;
}

function applyTransformConstraint(
  runtime: SpineRuntime,
  animation: SpineAnimationData | undefined,
  constraint: TransformConstraintData,
  time: number,
  duration: number,
  loop: boolean,
  poses: Map<string, BonePose>,
  children: Map<string, string[]>,
): void {
  const state = sampleTransformConstraint(
    constraint,
    animation?.transform?.[constraint.name],
    time,
    duration,
    loop,
    runtime.transformStateScratch,
    runtime.timelineSamplerState,
  );
  if (
    state.mixRotate === 0
    && state.mixX === 0
    && state.mixY === 0
    && state.mixScaleX === 0
    && state.mixScaleY === 0
    && state.mixShearY === 0
  ) return;
  const source = poses.get(constraint.target);
  if (!source) return;
  let constrainedBones = runtime.transformConstraintBoneSets.get(constraint);
  if (!constrainedBones) {
    constrainedBones = new Set(constraint.bones);
    runtime.transformConstraintBoneSets.set(constraint, constrainedBones);
  }
  const worldSpaceBones = runtime.transformWorldSpaceBonesScratch;
  worldSpaceBones.length = 0;
  for (const boneName of constraint.bones) {
    const bone = poses.get(boneName);
    if (!bone) continue;
    if (constraint.localTarget || constraint.localSource) {
      applyLocalTransformConstraint(constraint, state, source, bone);
      updateBoneTree(boneName, poses, children);
    } else {
      applyWorldTransformConstraint(constraint, state, source, bone);
      worldSpaceBones.push(boneName);
    }
  }
  for (const boneName of worldSpaceBones) updateDescendantBoneTrees(boneName, poses, children, constrainedBones);
}

function sampleTransformConstraint(
  constraint: TransformConstraintData,
  frames: unknown[] | undefined,
  time: number,
  duration: number,
  loop: boolean,
  out: Pick<TransformConstraintData, 'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'>,
  samplerState: SpineTimelineSamplerState,
): Pick<TransformConstraintData, 'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'> {
  out.mixRotate = sampleTimeline(frames ?? [], time, 'mixRotate', constraint.mixRotate, duration, loop, samplerState);
  out.mixX = sampleTimeline(frames ?? [], time, 'mixX', constraint.mixX, duration, loop, samplerState);
  out.mixY = sampleTimeline(frames ?? [], time, 'mixY', constraint.mixY, duration, loop, samplerState);
  out.mixScaleX = sampleTimeline(frames ?? [], time, 'mixScaleX', constraint.mixScaleX, duration, loop, samplerState);
  out.mixScaleY = sampleTimeline(frames ?? [], time, 'mixScaleY', constraint.mixScaleY, duration, loop, samplerState);
  out.mixShearY = sampleTimeline(frames ?? [], time, 'mixShearY', constraint.mixShearY, duration, loop, samplerState);
  return out;
}

function applyWorldTransformConstraint(
  constraint: TransformConstraintData,
  state: Pick<TransformConstraintData, 'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'>,
  source: BonePose,
  bone: BonePose,
): void {
  if (state.mixRotate !== 0) {
    let value = Math.atan2(source.c, source.a) * 180 / Math.PI
      + ((source.a * source.d - source.b * source.c) > 0 ? constraint.rotation : -constraint.rotation);
    if (value < 0) value += 360;
    if (!constraint.additive) value -= Math.atan2(bone.c, bone.a) * 180 / Math.PI;
    value = normalizeAngle(value) * Math.PI / 180 * state.mixRotate;
    const cos = Math.cos(value);
    const sin = Math.sin(value);
    const a = bone.a;
    const b = bone.b;
    const c = bone.c;
    const d = bone.d;
    bone.a = cos * a - sin * c;
    bone.b = cos * b - sin * d;
    bone.c = sin * a + cos * c;
    bone.d = sin * b + cos * d;
  }

  if (state.mixX !== 0) {
    let value = constraint.x * source.a + constraint.y * source.b + source.worldX;
    if (!constraint.additive) value -= bone.worldX;
    bone.worldX += value * state.mixX;
  }
  if (state.mixY !== 0) {
    let value = constraint.x * source.c + constraint.y * source.d + source.worldY;
    if (!constraint.additive) value -= bone.worldY;
    bone.worldY += value * state.mixY;
  }

  if (state.mixScaleX !== 0) {
    const sourceScale = Math.hypot(source.a, source.c) + constraint.scaleX;
    const boneScale = Math.hypot(bone.a, bone.c);
    if (constraint.additive) {
      const scale = 1 + (sourceScale - 1) * state.mixScaleX;
      bone.a *= scale;
      bone.c *= scale;
    } else if (boneScale !== 0) {
      const scale = 1 + (sourceScale - boneScale) * state.mixScaleX / boneScale;
      bone.a *= scale;
      bone.c *= scale;
    }
  }
  if (state.mixScaleY !== 0) {
    const sourceScale = Math.hypot(source.b, source.d) + constraint.scaleY;
    const boneScale = Math.hypot(bone.b, bone.d);
    if (constraint.additive) {
      const scale = 1 + (sourceScale - 1) * state.mixScaleY;
      bone.b *= scale;
      bone.d *= scale;
    } else if (boneScale !== 0) {
      const scale = 1 + (sourceScale - boneScale) * state.mixScaleY / boneScale;
      bone.b *= scale;
      bone.d *= scale;
    }
  }

  if (state.mixShearY !== 0) {
    const by = Math.atan2(bone.d, bone.b);
    let value = (Math.atan2(source.d, source.b) - Math.atan2(source.c, source.a)) * 180 / Math.PI - 90 + constraint.shearY;
    value = (value + 90) * Math.PI / 180;
    if (constraint.additive) value -= Math.PI / 2;
    else value = by + normalizeRadians(value - by + Math.atan2(bone.c, bone.a)) * state.mixShearY;
    const scale = Math.hypot(bone.b, bone.d);
    bone.b = Math.cos(value) * scale;
    bone.d = Math.sin(value) * scale;
  }
}

function applyLocalTransformConstraint(
  constraint: TransformConstraintData,
  state: Pick<TransformConstraintData, 'mixRotate' | 'mixX' | 'mixY' | 'mixScaleX' | 'mixScaleY' | 'mixShearY'>,
  source: BonePose,
  bone: BonePose,
): void {
  if (state.mixRotate !== 0) {
    const value = source.rotation + constraint.rotation;
    bone.rotation += (constraint.additive ? value : value - bone.rotation) * state.mixRotate;
  }
  if (state.mixX !== 0) {
    const value = source.x + constraint.x;
    bone.x += (constraint.additive ? value : value - bone.x) * state.mixX;
  }
  if (state.mixY !== 0) {
    const value = source.y + constraint.y;
    bone.y += (constraint.additive ? value : value - bone.y) * state.mixY;
  }
  if (state.mixScaleX !== 0) {
    const value = source.scaleX + constraint.scaleX;
    if (constraint.additive) bone.scaleX *= 1 + (value - 1) * state.mixScaleX;
    else bone.scaleX += (value - bone.scaleX) * state.mixScaleX;
  }
  if (state.mixScaleY !== 0) {
    const value = source.scaleY + constraint.scaleY;
    if (constraint.additive) bone.scaleY *= 1 + (value - 1) * state.mixScaleY;
    else bone.scaleY += (value - bone.scaleY) * state.mixScaleY;
  }
}

function applyOneBoneIk(
  constraint: IkConstraintData,
  state: { mix: number; softness: number; bendPositive: boolean },
  poses: Map<string, BonePose>,
): void {
  const boneName = constraint.bones[0];
  if (boneName === undefined) return;
  const bone = poses.get(boneName);
  const target = poses.get(constraint.target);
  if (!bone || !target) return;
  const parent = bone.data.parent ? poses.get(bone.data.parent) : null;
  const [targetX, targetY] = parent
    ? worldToLocal(parent, target.worldX, target.worldY)
    : [target.worldX, target.worldY];
  const rotation = Math.atan2(targetY - bone.y, targetX - bone.x) * 180 / Math.PI;
  bone.rotation += normalizeAngle(rotation - bone.rotation) * state.mix;
}

function applyTwoBoneIk(
  constraint: IkConstraintData,
  state: { mix: number; softness: number; bendPositive: boolean },
  poses: Map<string, BonePose>,
): void {
  const parentName = constraint.bones[0];
  const childName = constraint.bones[1];
  if (parentName === undefined || childName === undefined) return;
  const parent = poses.get(parentName);
  const child = poses.get(childName);
  const target = poses.get(constraint.target);
  if (!parent || !child || !target) return;
  if (parent.data.inherit && parent.data.inherit !== 'normal') return;
  if (child.data.inherit && child.data.inherit !== 'normal') return;
  const grandParent = parent.data.parent ? poses.get(parent.data.parent) : null;
  if (!grandParent) return;

  let parentScaleX = parent.scaleX;
  let parentScaleY = parent.scaleY;
  let childScaleX = child.scaleX;
  let parentOffset = 0;
  let childOffset = 0;
  let sign = 1;
  if (parentScaleX < 0) {
    parentScaleX = -parentScaleX;
    parentOffset = 180;
    sign = -1;
  }
  if (parentScaleY < 0) {
    parentScaleY = -parentScaleY;
    sign = -sign;
  }
  if (childScaleX < 0) {
    childScaleX = -childScaleX;
    childOffset = 180;
  }

  let childWorldX = 0;
  let childWorldY = 0;
  const uniformScale = Math.abs(parentScaleX - parentScaleY) <= 0.000001;
  if (!uniformScale) {
    child.y = 0;
    childWorldX = parent.a * child.x + parent.worldX;
    childWorldY = parent.c * child.x + parent.worldY;
  } else {
    childWorldX = parent.a * child.x + parent.b * child.y + parent.worldX;
    childWorldY = parent.c * child.x + parent.d * child.y + parent.worldY;
  }

  let a = grandParent.a;
  let b = grandParent.b;
  let c = grandParent.c;
  let d = grandParent.d;
  let det = a * d - b * c;
  det = Math.abs(det) <= 0.000001 ? 0 : 1 / det;
  let x = childWorldX - grandParent.worldX;
  let y = childWorldY - grandParent.worldY;
  const dx = (x * d - y * b) * det - parent.x;
  const dy = (y * a - x * c) * det - parent.y;
  let length1 = Math.hypot(dx, dy);
  let length2 = child.data.length * childScaleX;
  if (length1 < 0.000001) {
    applyOneBoneIk({ ...constraint, bones: [parentName] }, state, poses);
    child.rotation = 0;
    return;
  }

  x = target.worldX - grandParent.worldX;
  y = target.worldY - grandParent.worldY;
  let targetX = (x * d - y * b) * det - parent.x;
  let targetY = (y * a - x * c) * det - parent.y;
  let distanceSq = targetX * targetX + targetY * targetY;
  if (state.softness !== 0) {
    const softness = state.softness * parentScaleX * (childScaleX + 1) * 0.5;
    const targetDistance = Math.sqrt(distanceSq);
    const softDistance = targetDistance - length1 - length2 * parentScaleX + softness;
    if (softDistance > 0 && targetDistance > 0.000001) {
      let percent = Math.min(1, softDistance / (softness * 2)) - 1;
      percent = (softDistance - softness * (1 - percent * percent)) / targetDistance;
      targetX -= percent * targetX;
      targetY -= percent * targetY;
      distanceSq = targetX * targetX + targetY * targetY;
    }
  }

  const bend = state.bendPositive ? 1 : -1;
  let angle1 = 0;
  let angle2 = 0;
  if (uniformScale) {
    length2 *= parentScaleX;
    let cos = (distanceSq - length1 * length1 - length2 * length2) / (2 * length1 * length2);
    if (cos < -1) {
      cos = -1;
      angle2 = Math.PI * bend;
    } else if (cos > 1) {
      cos = 1;
      angle2 = 0;
    } else {
      angle2 = Math.acos(cos) * bend;
    }
    a = length1 + length2 * cos;
    b = length2 * Math.sin(angle2);
    angle1 = Math.atan2(targetY * a - targetX * b, targetX * a + targetY * b);
  } else {
    a = parentScaleX * length2;
    b = parentScaleY * length2;
    const aa = a * a;
    const bb = b * b;
    const targetAngle = Math.atan2(targetY, targetX);
    c = bb * length1 * length1 + aa * distanceSq - aa * bb;
    const c1 = -2 * bb * length1;
    const c2 = bb - aa;
    d = c1 * c1 - 4 * c2 * c;
    if (d >= 0) {
      let q = Math.sqrt(d);
      if (c1 < 0) q = -q;
      q = -(c1 + q) * 0.5;
      let r0 = q / c2;
      const r1 = c / q;
      const r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
      r0 = distanceSq - r * r;
      if (r0 >= 0) {
        y = Math.sqrt(r0) * bend;
        angle1 = targetAngle - Math.atan2(y, r);
        angle2 = Math.atan2(y / parentScaleY, (r - length1) / parentScaleX);
      }
    }
    if (!Number.isFinite(angle1) || !Number.isFinite(angle2)) {
      const minX = length1 - a;
      const maxX = length1 + a;
      if (distanceSq <= (minX * minX + maxX * maxX) * 0.5) {
        angle1 = targetAngle;
        angle2 = Math.PI * bend;
      } else {
        angle1 = targetAngle;
        angle2 = 0;
      }
    }
  }

  const childOffsetAngle = Math.atan2(child.y, child.x) * sign;
  let parentDelta = (angle1 - childOffsetAngle) * 180 / Math.PI + parentOffset - parent.rotation;
  parent.rotation += normalizeAngle(parentDelta) * state.mix;
  let childDelta = ((angle2 + childOffsetAngle) * 180 / Math.PI) * sign + childOffset - child.rotation;
  child.rotation += normalizeAngle(childDelta) * state.mix;
}

function updateBoneTree(name: string, poses: Map<string, BonePose>, children: Map<string, string[]>): void {
  const pose = poses.get(name);
  if (!pose) return;
  const parent = pose.data.parent ? poses.get(pose.data.parent) ?? null : null;
  updateWorldPose(pose, parent);
  for (const childName of children.get(name) ?? []) updateBoneTree(childName, poses, children);
}

function updateDescendantBoneTrees(
  name: string,
  poses: Map<string, BonePose>,
  children: Map<string, string[]>,
  blockedRoots: Set<string> = new Set(),
): void {
  for (const childName of children.get(name) ?? []) {
    if (blockedRoots.has(childName)) continue;
    updateBoneTree(childName, poses, children);
  }
}

function worldToLocal(bone: BonePose, worldX: number, worldY: number): [number, number] {
  const dx = worldX - bone.worldX;
  const dy = worldY - bone.worldY;
  const det = bone.a * bone.d - bone.b * bone.c;
  if (Math.abs(det) < 0.000001) return [dx, dy];
  return [
    (dx * bone.d - dy * bone.b) / det,
    (dy * bone.a - dx * bone.c) / det,
  ];
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 540) % 360 - 180;
}

function normalizeRadians(value: number): number {
  let angle = value % TWO_PI;
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

function getCurrentAnimationTime(data: SpineData, component: Spine2DComponent): number {
  const animation = data.animations[component.animation];
  const duration = getCompiledAnimationDuration(animation);
  return component.loop && duration > 0 ? (component.elapsed / 1000) % duration : Math.min(component.elapsed / 1000, duration);
}
