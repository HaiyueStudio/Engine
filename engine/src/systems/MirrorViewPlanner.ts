import type { PlanarMirror } from '../components/PlanarMirror';
import type { Mesh3D } from '../components/Mesh3D';
import { Camera3D } from '../components/Camera3D';
import type { Entity } from '../ecs/Entity';
import type { FrameData } from '../frame/FrameData';
import type { BoundingSphere } from '../culling/Frustum';
import type { RenderViewSnapshot } from '../core/RenderView';

export type MirrorViewDropReason =
  | 'invalid-camera'
  | 'back-facing'
  | 'outside-frustum'
  | 'too-distant'
  | 'below-min-pixels'
  | 'zero-contribution'
  | 'view-budget'
  | 'pixel-budget'
  | 'materialize-failed';

export interface MirrorViewPlannerOptions {
  /** Enables facing, frustum, distance, and projected-area rejection. Defaults to true. */
  visibilityCulling?: boolean;
  /** Minimum projected source-view pixels required to schedule a reflection. Defaults to 64. */
  minScreenPixels?: number;
  /** Maximum distance from the source camera to a mirror bound. Defaults to Infinity. */
  maxDistance?: number;
  /** Maximum reflection views encoded by one Render3D record. Defaults to 16. */
  maxViews?: number;
  /** Global sum of reflection target pixels. Defaults to 8x the source-view pixels. */
  maxRttPixels?: number;
  /** Frames an unused cached reflection path remains resident. Defaults to 1. */
  cacheRetentionFrames?: number;
}

export interface MirrorViewPlannerStats {
  readonly plannedViewCount: number;
  readonly executedViewCount: number;
  readonly cachedViewCount: number;
  readonly droppedViewCount: number;
  readonly rttPixels: number;
  readonly maxDepth: number;
  readonly dropReasons: Readonly<Record<MirrorViewDropReason, number>>;
}

export interface MirrorViewPlanBudget {
  /** Runtime view slots available to reflection work after source views are reserved. */
  readonly maxViews?: number;
  /** Runtime RTT pixel ceiling, combined with the configured planner ceiling. */
  readonly maxRttPixels?: number;
}

/** Stable mirror state prepared once per World frame by PlanarMirrorManager. */
export interface MirrorViewPlannerMirror {
  readonly entity: Entity;
  readonly component: PlanarMirror;
  readonly mesh: Mesh3D;
  readonly worldMatrix: Float32Array;
  readonly worldNormal: Float32Array;
  readonly worldSphere: BoundingSphere;
  readonly localBoundsMin: Float32Array;
  readonly localBoundsMax: Float32Array;
}

export interface MirrorViewCacheState {
  readonly lastRenderedFrame: number;
  readonly reflectionRevision: number;
}

export interface MirrorViewRenderRequest {
  readonly mirror: MirrorViewPlannerMirror;
  readonly sourceView: RenderViewSnapshot;
  /** The reflection pass that consumes this result, or null for a source-view root. */
  readonly parent: MirrorViewRenderRequest | null;
  readonly depth: number;
  readonly width: number;
  readonly height: number;
  readonly projectedPixels: number;
  readonly score: number;
}

export interface MirrorViewPlannerCallbacks {
  getCacheState(request: MirrorViewRenderRequest): MirrorViewCacheState | null;
  touchCache(request: MirrorViewRenderRequest): void;
  materialize(request: MirrorViewRenderRequest): RenderViewSnapshot | null;
  includeChild(parent: MirrorViewRenderRequest, childEntityId: number): void;
}

interface MutableMirrorViewPlannerStats {
  plannedViewCount: number;
  executedViewCount: number;
  cachedViewCount: number;
  droppedViewCount: number;
  rttPixels: number;
  maxDepth: number;
  dropReasons: Record<MirrorViewDropReason, number>;
}

interface MirrorViewTask extends MirrorViewRenderRequest {
  mirror: MirrorViewPlannerMirror;
  sourceView: RenderViewSnapshot;
  parent: MirrorViewTask | null;
  view: RenderViewSnapshot | null;
  depth: number;
  remainingBounces: number;
  rootIndex: number;
  sequence: number;
  width: number;
  height: number;
  projectedPixels: number;
  score: number;
  targetPixels: number;
  projectedWidth: number;
  projectedHeight: number;
}

const DROP_REASONS: readonly MirrorViewDropReason[] = Object.freeze([
  'invalid-camera',
  'back-facing',
  'outside-frustum',
  'too-distant',
  'below-min-pixels',
  'zero-contribution',
  'view-budget',
  'pixel-budget',
  'materialize-failed',
]);

// Recursive mirror work grows exponentially (source views × mirrors ×
// bounces). Keep the product default below the point where transparent
// single-object draws can monopolize a frame; applications that deliberately
// trade frame time for deeper recursion can still raise this ceiling.
const DEFAULT_MAX_VIEWS = 16;
const DEFAULT_MIN_SCREEN_PIXELS = 64;
const DEFAULT_CACHE_RETENTION_FRAMES = 1;
const DEFAULT_SOURCE_PIXEL_MULTIPLIER = 8;
const CLIP_EPSILON = 1e-5;

/**
 * Budgeted, breadth-wise planar-reflection scheduler.
 *
 * It materializes one depth at a time so every root gets a chance to consume
 * the shared budget before a single root can expand its complete bounce chain.
 */
export class MirrorViewPlanner {
  private readonly _visibilityCulling: boolean;
  private readonly _minScreenPixels: number;
  private readonly _maxDistance: number;
  private readonly _maxViews: number;
  private readonly _maxRttPixels: number | null;
  readonly cacheRetentionFrames: number;
  private readonly _taskPool: MirrorViewTask[] = [];
  private readonly _candidateA: MirrorViewTask[] = [];
  private readonly _candidateB: MirrorViewTask[] = [];
  private readonly _runnable: MirrorViewTask[] = [];
  private readonly _accepted: MirrorViewTask[] = [];
  private readonly _acceptedDepth: MirrorViewTask[] = [];
  private readonly _orderedViews: RenderViewSnapshot[] = [];
  private readonly _rootSpentPixels = new Map<number, number>();
  private _taskCursor = 0;
  private _sequence = 0;
  private _rootCount = 0;
  private readonly _stats: MutableMirrorViewPlannerStats = {
    plannedViewCount: 0,
    executedViewCount: 0,
    cachedViewCount: 0,
    droppedViewCount: 0,
    rttPixels: 0,
    maxDepth: 0,
    dropReasons: createDropReasons(),
  };

  constructor(
    options: MirrorViewPlannerOptions = {},
    private readonly _maxTextureDimension2D = Number.MAX_SAFE_INTEGER,
  ) {
    this._visibilityCulling = options.visibilityCulling !== false;
    this._minScreenPixels = nonNegativeFinite(options.minScreenPixels ?? DEFAULT_MIN_SCREEN_PIXELS, 'minScreenPixels');
    this._maxDistance = options.maxDistance === undefined
      ? Number.POSITIVE_INFINITY
      : positiveFinite(options.maxDistance, 'maxDistance');
    this._maxViews = positiveInteger(options.maxViews ?? DEFAULT_MAX_VIEWS, 'maxViews');
    this._maxRttPixels = options.maxRttPixels === undefined
      ? null
      : positiveInteger(options.maxRttPixels, 'maxRttPixels');
    this.cacheRetentionFrames = positiveInteger(
      options.cacheRetentionFrames ?? DEFAULT_CACHE_RETENTION_FRAMES,
      'cacheRetentionFrames',
    );
  }

  get stats(): MirrorViewPlannerStats { return this._stats; }

  plan(
    sourceViews: readonly RenderViewSnapshot[],
    mirrors: readonly MirrorViewPlannerMirror[],
    frameData: FrameData,
    callbacks: MirrorViewPlannerCallbacks,
    budget: MirrorViewPlanBudget = {},
  ): readonly RenderViewSnapshot[] {
    this._reset();
    if (sourceViews.length === 0 || mirrors.length === 0) return this._orderedViews;
    const configuredPixelBudget = this._maxRttPixels ?? defaultPixelBudget(sourceViews);
    const pixelBudget = Math.min(
      configuredPixelBudget,
      budget.maxRttPixels === undefined
        ? configuredPixelBudget
        : nonNegativeInteger(budget.maxRttPixels, 'budget.maxRttPixels'),
    );
    const viewBudget = Math.min(
      this._maxViews,
      budget.maxViews === undefined
        ? this._maxViews
        : nonNegativeInteger(budget.maxViews, 'budget.maxViews'),
    );
    let depth = 1;
    let current = this._candidateA;
    current.length = 0;
    for (let sourceIndex = 0; sourceIndex < sourceViews.length; sourceIndex++) {
      const sourceView = sourceViews[sourceIndex];
      if (!sourceView || sourceView.key.startsWith('planar-mirror:')) continue;
      for (let mirrorIndex = 0; mirrorIndex < mirrors.length; mirrorIndex++) {
        const mirror = mirrors[mirrorIndex];
        if (!mirror) continue;
        const rootIndex = this._rootCount++;
        current.push(this._nextTask(mirror, sourceView, null, 1, mirror.component.maxBounces, rootIndex));
      }
    }

    while (current.length > 0 && depth <= 8) {
      const acceptedAtDepth = this._planDepth(current, frameData, callbacks, pixelBudget, viewBudget);
      if (acceptedAtDepth.length === 0) break;
      const next = current === this._candidateA ? this._candidateB : this._candidateA;
      next.length = 0;
      for (let parentIndex = 0; parentIndex < acceptedAtDepth.length; parentIndex++) {
        const parent = acceptedAtDepth[parentIndex];
        if (!parent?.view || parent.remainingBounces <= 1) continue;
        for (let mirrorIndex = 0; mirrorIndex < mirrors.length; mirrorIndex++) {
          const mirror = mirrors[mirrorIndex];
          if (!mirror || mirror === parent.mirror) continue;
          next.push(this._nextTask(
            mirror,
            parent.view,
            parent,
            depth + 1,
            parent.remainingBounces - 1,
            parent.rootIndex,
          ));
        }
      }
      current = next;
      depth++;
    }

    this._accepted.sort(compareDeepestFirst);
    for (let index = 0; index < this._accepted.length; index++) {
      const view = this._accepted[index]?.view;
      if (view) this._orderedViews.push(view);
    }
    return this._orderedViews;
  }

  private _planDepth(
    candidates: readonly MirrorViewTask[],
    frameData: FrameData,
    callbacks: MirrorViewPlannerCallbacks,
    pixelBudget: number,
    viewBudget: number,
  ): MirrorViewTask[] {
    const acceptedDepth = this._acceptedDepth;
    acceptedDepth.length = 0;
    const runnable = this._runnable;
    runnable.length = 0;
    for (let index = 0; index < candidates.length; index++) {
      const task = candidates[index];
      if (!task) continue;
      this._stats.plannedViewCount++;
      const dropReason = this._evaluate(task, frameData);
      if (dropReason) {
        this._drop(dropReason);
        continue;
      }
      const cache = callbacks.getCacheState(task);
      if (cache && !shouldRefresh(task.mirror.component, cache, frameData.frameId)) {
        callbacks.touchCache(task);
        if (task.parent) callbacks.includeChild(task.parent, task.mirror.entity.id);
        this._stats.cachedViewCount++;
        continue;
      }
      runnable.push(task);
    }

    const rootShare = pixelBudget / Math.max(1, this._rootCount);
    while (runnable.length > 0) {
      if (this._stats.executedViewCount >= viewBudget) {
        this._dropRemaining(runnable, 'view-budget');
        break;
      }
      const selectedIndex = this._selectFairCandidate(runnable, rootShare, frameData.frameId);
      const task = runnable[selectedIndex]!;
      runnable[selectedIndex] = runnable[runnable.length - 1]!;
      runnable.pop();
      if (this._stats.rttPixels + task.targetPixels > pixelBudget) {
        this._drop('pixel-budget');
        continue;
      }
      const view = callbacks.materialize(task);
      if (!view) {
        this._drop('materialize-failed');
        continue;
      }
      task.view = view;
      this._accepted.push(task);
      acceptedDepth.push(task);
      this._stats.executedViewCount++;
      this._stats.rttPixels += task.targetPixels;
      this._stats.maxDepth = Math.max(this._stats.maxDepth, task.depth);
      this._rootSpentPixels.set(task.rootIndex, (this._rootSpentPixels.get(task.rootIndex) ?? 0) + task.targetPixels);
      if (task.parent) callbacks.includeChild(task.parent, task.mirror.entity.id);
    }
    return acceptedDepth;
  }

  private _evaluate(task: MirrorViewTask, frameData: FrameData): MirrorViewDropReason | null {
    const camera = getCamera3D(task.sourceView);
    if (!camera) return 'invalid-camera';
    const cameraFrame = frameData.getCamera3D(task.sourceView.camera, camera, {
      width: task.sourceView.width,
      height: task.sourceView.height,
      reverseZ: task.sourceView.reverseZ,
    });
    let projectedWidth = task.sourceView.width;
    let projectedHeight = task.sourceView.height;
    if (this._visibilityCulling) {
      const sphere = task.mirror.worldSphere;
      const center = sphere.center;
      const toCameraX = (cameraFrame.position[0] ?? 0) - center[0];
      const toCameraY = (cameraFrame.position[1] ?? 0) - center[1];
      const toCameraZ = (cameraFrame.position[2] ?? 0) - center[2];
      const normal = task.mirror.worldNormal;
      if (toCameraX * (normal[0] ?? 0) + toCameraY * (normal[1] ?? 0) + toCameraZ * (normal[2] ?? 0) <= CLIP_EPSILON) {
        return 'back-facing';
      }
      if (!cameraFrame.frustum.containsSphere(sphere)) return 'outside-frustum';
      const distance = Math.max(0, Math.hypot(toCameraX, toCameraY, toCameraZ) - sphere.radius);
      if (distance > this._maxDistance) return 'too-distant';
      if (!projectBounds(task.mirror, cameraFrame.viewProjectionMatrix, task.sourceView.width, task.sourceView.height, task)) {
        return 'outside-frustum';
      }
      projectedWidth = task.projectedWidth;
      projectedHeight = task.projectedHeight;
      task.projectedPixels = projectedWidth * projectedHeight;
      if (task.projectedPixels < this._minScreenPixels) return 'below-min-pixels';
    } else {
      task.projectedPixels = projectedWidth * projectedHeight;
    }
    const component = task.mirror.component;
    if (component.material.reflectivity <= 0) return 'zero-contribution';
    const bounceScale = task.depth > 1 ? component.bounceResolutionScale : 1;
    // An implicit target inherits the previous reflection view's dimensions,
    // so multiplying by bounceScale once naturally compounds at every hop.
    // A fixed width/height does not inherit that size and must compound the
    // scale explicitly to preserve PlanarMirror's "every recursive bounce"
    // contract.
    const fixedBounceScale = task.depth > 1
      ? component.bounceResolutionScale ** (task.depth - 1)
      : 1;
    const requestedWidth = component.width
      ?? Math.min(task.sourceView.width * component.resolutionScale, projectedWidth * component.resolutionScale);
    const requestedHeight = component.height
      ?? Math.min(task.sourceView.height * component.resolutionScale, projectedHeight * component.resolutionScale);
    task.width = clampDimension(
      requestedWidth * (component.width === undefined ? bounceScale : fixedBounceScale),
      this._maxTextureDimension2D,
    );
    task.height = clampDimension(
      requestedHeight * (component.height === undefined ? bounceScale : fixedBounceScale),
      this._maxTextureDimension2D,
    );
    task.targetPixels = task.width * task.height;
    task.score = task.projectedPixels * component.material.reflectivity / Math.max(1, task.depth);
    return null;
  }

  private _selectFairCandidate(candidates: readonly MirrorViewTask[], rootShare: number, frameId: number): number {
    let bestIndex = 0;
    let bestPriority = Number.NEGATIVE_INFINITY;
    let bestFairnessRank = Number.MAX_SAFE_INTEGER;
    const rotation = this._rootCount > 0 ? frameId % this._rootCount : 0;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index]!;
      const spent = this._rootSpentPixels.get(candidate.rootIndex) ?? 0;
      const priority = candidate.score / (1 + spent / Math.max(1, rootShare));
      const fairnessRank = (candidate.rootIndex - rotation + this._rootCount) % Math.max(1, this._rootCount);
      if (priority > bestPriority || (priority === bestPriority && fairnessRank < bestFairnessRank)) {
        bestIndex = index;
        bestPriority = priority;
        bestFairnessRank = fairnessRank;
      }
    }
    return bestIndex;
  }

  private _nextTask(
    mirror: MirrorViewPlannerMirror,
    sourceView: RenderViewSnapshot,
    parent: MirrorViewTask | null,
    depth: number,
    remainingBounces: number,
    rootIndex: number,
  ): MirrorViewTask {
    let task = this._taskPool[this._taskCursor++];
    if (!task) {
      task = {
        mirror,
        sourceView,
        parent,
        view: null,
        depth,
        remainingBounces,
        rootIndex,
        sequence: 0,
        width: 1,
        height: 1,
        projectedPixels: 0,
        score: 0,
        targetPixels: 1,
        projectedWidth: 0,
        projectedHeight: 0,
      };
      this._taskPool.push(task);
    }
    task.mirror = mirror;
    task.sourceView = sourceView;
    task.parent = parent;
    task.view = null;
    task.depth = depth;
    task.remainingBounces = remainingBounces;
    task.rootIndex = rootIndex;
    task.sequence = this._sequence++;
    task.width = 1;
    task.height = 1;
    task.projectedPixels = 0;
    task.score = 0;
    task.targetPixels = 1;
    task.projectedWidth = 0;
    task.projectedHeight = 0;
    return task;
  }

  private _drop(reason: MirrorViewDropReason): void {
    this._stats.droppedViewCount++;
    this._stats.dropReasons[reason]++;
  }

  private _dropRemaining(tasks: MirrorViewTask[], reason: MirrorViewDropReason): void {
    const count = tasks.length;
    this._stats.droppedViewCount += count;
    this._stats.dropReasons[reason] += count;
    tasks.length = 0;
  }

  private _reset(): void {
    this._taskCursor = 0;
    this._sequence = 0;
    this._rootCount = 0;
    this._runnable.length = 0;
    this._candidateA.length = 0;
    this._candidateB.length = 0;
    this._accepted.length = 0;
    this._acceptedDepth.length = 0;
    this._orderedViews.length = 0;
    this._rootSpentPixels.clear();
    this._stats.plannedViewCount = 0;
    this._stats.executedViewCount = 0;
    this._stats.cachedViewCount = 0;
    this._stats.droppedViewCount = 0;
    this._stats.rttPixels = 0;
    this._stats.maxDepth = 0;
    for (const reason of DROP_REASONS) this._stats.dropReasons[reason] = 0;
  }
}

function getCamera3D(view: RenderViewSnapshot): Camera3D | null {
  return view.camera.getComponent(Camera3D);
}

function shouldRefresh(component: PlanarMirror, cache: MirrorViewCacheState, frameId: number): boolean {
  if (cache.reflectionRevision !== component.reflectionRevision) return true;
  if (component.staticCache) return false;
  const elapsed = frameId >= cache.lastRenderedFrame
    ? frameId - cache.lastRenderedFrame
    : Number.MAX_SAFE_INTEGER;
  return elapsed >= component.updateInterval;
}

function projectBounds(
  mirror: MirrorViewPlannerMirror,
  viewProjection: Float32Array,
  viewWidth: number,
  viewHeight: number,
  out: MirrorViewTask,
): boolean {
  const min = mirror.localBoundsMin;
  const max = mirror.localBoundsMax;
  const world = mirror.worldMatrix;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let frontCount = 0;
  let behindCount = 0;
  for (let corner = 0; corner < 8; corner++) {
    const lx = (corner & 1) === 0 ? (min[0] ?? 0) : (max[0] ?? 0);
    const ly = (corner & 2) === 0 ? (min[1] ?? 0) : (max[1] ?? 0);
    const lz = (corner & 4) === 0 ? (min[2] ?? 0) : (max[2] ?? 0);
    const wx = (world[0] ?? 1) * lx + (world[4] ?? 0) * ly + (world[8] ?? 0) * lz + (world[12] ?? 0);
    const wy = (world[1] ?? 0) * lx + (world[5] ?? 1) * ly + (world[9] ?? 0) * lz + (world[13] ?? 0);
    const wz = (world[2] ?? 0) * lx + (world[6] ?? 0) * ly + (world[10] ?? 1) * lz + (world[14] ?? 0);
    const clipX = (viewProjection[0] ?? 0) * wx + (viewProjection[4] ?? 0) * wy + (viewProjection[8] ?? 0) * wz + (viewProjection[12] ?? 0);
    const clipY = (viewProjection[1] ?? 0) * wx + (viewProjection[5] ?? 0) * wy + (viewProjection[9] ?? 0) * wz + (viewProjection[13] ?? 0);
    const clipW = (viewProjection[3] ?? 0) * wx + (viewProjection[7] ?? 0) * wy + (viewProjection[11] ?? 0) * wz + (viewProjection[15] ?? 0);
    if (clipW <= CLIP_EPSILON) {
      behindCount++;
      continue;
    }
    frontCount++;
    const inverseW = 1 / clipW;
    const x = clipX * inverseW;
    const y = clipY * inverseW;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (frontCount === 0) return false;
  // Bounds crossing the near plane conservatively occupy the complete view.
  if (behindCount > 0) {
    out.projectedWidth = viewWidth;
    out.projectedHeight = viewHeight;
    return true;
  }
  if (maxX <= -1 || minX >= 1 || maxY <= -1 || minY >= 1) return false;
  const clampedMinX = Math.max(-1, minX);
  const clampedMaxX = Math.min(1, maxX);
  const clampedMinY = Math.max(-1, minY);
  const clampedMaxY = Math.min(1, maxY);
  out.projectedWidth = Math.max(0, (clampedMaxX - clampedMinX) * 0.5 * viewWidth);
  out.projectedHeight = Math.max(0, (clampedMaxY - clampedMinY) * 0.5 * viewHeight);
  return true;
}

function compareDeepestFirst(a: MirrorViewTask, b: MirrorViewTask): number {
  return (b.depth - a.depth) || (a.sequence - b.sequence);
}

function defaultPixelBudget(sourceViews: readonly RenderViewSnapshot[]): number {
  let pixels = 0;
  for (const view of sourceViews) {
    if (!view.key.startsWith('planar-mirror:')) pixels += Math.max(1, view.width) * Math.max(1, view.height);
  }
  return Math.max(1, Math.floor(pixels * DEFAULT_SOURCE_PIXEL_MULTIPLIER));
}

function clampDimension(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.round(value)));
}

function createDropReasons(): Record<MirrorViewDropReason, number> {
  return {
    'invalid-camera': 0,
    'back-facing': 0,
    'outside-frustum': 0,
    'too-distant': 0,
    'below-min-pixels': 0,
    'zero-contribution': 0,
    'view-budget': 0,
    'pixel-budget': 0,
    'materialize-failed': 0,
  };
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`MirrorViewPlanner.${label} must be non-negative.`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`MirrorViewPlanner.${label} must be greater than zero.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`MirrorViewPlanner.${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`MirrorViewPlanner.${label} must be a non-negative integer.`);
  return value;
}
