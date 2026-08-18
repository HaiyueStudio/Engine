import type { Entity } from '../ecs/Entity';
import type { ScissorRect, ViewportRect } from './ViewportRect';
import type { RenderPassLoadOp } from './renderPassDescriptor';
import { EngineError, EngineErrorCode } from './EngineError';

export type RenderDepthConvention = 'standard' | 'reverse';
export type RenderSampleCount = 1 | 4;

export interface RenderViewTargetPassOptions {
  readonly clearColor: Readonly<GPUColorDict>;
  readonly depthConvention: RenderDepthConvention;
  readonly sampleCount: RenderSampleCount;
}

/** A render destination. It owns attachments; a RenderView only describes how to use them. */
export interface RenderViewTarget {
  readonly key: string;
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  getOutputView(): GPUTextureView;
  getRenderPassDescriptor(options: RenderViewTargetPassOptions): GPURenderPassDescriptor;
  getRenderPassDescriptorVersion?(options: RenderViewTargetPassOptions): number;
}

export interface RenderViewOptions {
  /** Stable identity used by view-local caches. Generated when omitted. */
  key?: string;
  camera: Entity;
  target: RenderViewTarget;
  clearColor?: GPUColorDict;
  depthConvention?: RenderDepthConvention;
  sampleCount?: RenderSampleCount;
  loadOp?: RenderPassLoadOp;
  viewport?: ViewportRect | null;
  scissor?: ScissorRect | null;
  /** Entity ids omitted only from this view. Useful for reflection/probe passes. */
  excludedEntityIds?: ReadonlySet<number> | null;
  /** Apply the Render3DSystem post chain to this view. Disable for reflection/probe captures. */
  postProcessEnabled?: boolean;
}

export interface RenderViewSnapshot {
  readonly key: string;
  readonly camera: Entity;
  readonly target: RenderViewTarget;
  readonly clearColor: Readonly<GPUColorDict>;
  readonly depthConvention: RenderDepthConvention;
  readonly reverseZ: boolean;
  readonly sampleCount: RenderSampleCount;
  readonly loadOp: RenderPassLoadOp;
  readonly viewport: Readonly<ViewportRect> | null;
  readonly scissor: Readonly<ScissorRect> | null;
  readonly excludedEntityIds: ReadonlySet<number> | null;
  readonly postProcessEnabled: boolean;
  readonly width: number;
  readonly height: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
}

/** Mutable scene/view configuration. snapshot() creates the immutable frame input. */
export class RenderView {
  readonly key: string;
  camera: Entity;
  target: RenderViewTarget;
  clearColor: GPUColorDict;
  depthConvention: RenderDepthConvention;
  sampleCount: RenderSampleCount;
  loadOp: RenderPassLoadOp;
  viewport: ViewportRect | null;
  scissor: ScissorRect | null;
  excludedEntityIds: ReadonlySet<number> | null;
  postProcessEnabled: boolean;
  private _snapshotCache: RenderViewSnapshot | null = null;

  constructor(options: RenderViewOptions) {
    this.key = normalizeViewKey(options.key);
    this.camera = options.camera;
    this.target = options.target;
    this.clearColor = cloneGpuColor(options.clearColor ?? { r: 0, g: 0, b: 0, a: 1 });
    this.depthConvention = options.depthConvention ?? 'standard';
    this.sampleCount = options.sampleCount ?? 1;
    this.loadOp = options.loadOp ?? 'clear';
    this.viewport = options.viewport ? { ...options.viewport } : null;
    this.scissor = options.scissor ? { ...options.scissor } : null;
    this.excludedEntityIds = options.excludedEntityIds ?? null;
    this.postProcessEnabled = options.postProcessEnabled ?? true;
  }

  get reverseZ(): boolean { return this.depthConvention === 'reverse'; }
  set reverseZ(value: boolean) { this.depthConvention = value ? 'reverse' : 'standard'; }

  snapshot(): RenderViewSnapshot {
    const cached = this._snapshotCache;
    if (cached && matchesRenderViewSnapshot(this, cached)) return cached;
    const viewport = this.viewport ? Object.freeze({ ...this.viewport }) : null;
    const scissor = this.scissor ? Object.freeze({ ...this.scissor }) : null;
    const width = viewport?.width ?? this.target.width;
    const height = viewport?.height ?? this.target.height;
    this._snapshotCache = Object.freeze({
      key: this.key,
      camera: this.camera,
      target: this.target,
      clearColor: Object.freeze(cloneGpuColor(this.clearColor)),
      depthConvention: this.depthConvention,
      reverseZ: this.reverseZ,
      sampleCount: this.sampleCount,
      loadOp: this.loadOp,
      viewport,
      scissor,
      excludedEntityIds: this.excludedEntityIds,
      postProcessEnabled: this.postProcessEnabled,
      width,
      height,
      displayWidth: viewport?.width ?? this.target.displayWidth,
      displayHeight: viewport?.height ?? this.target.displayHeight,
    });
    return this._snapshotCache;
  }
}

export interface RenderViewFamilyOptions {
  views?: readonly RenderView[];
}

export interface RenderViewFamilySnapshot {
  readonly views: readonly RenderViewSnapshot[];
}

/** Mutable group of views rendered from one shared World frame state. */
export class RenderViewFamily {
  private readonly _views: RenderView[] = [];
  private _snapshotCache: RenderViewFamilySnapshot | null = null;

  constructor(options: RenderViewFamilyOptions = {}) {
    for (const view of options.views ?? []) this.add(view);
  }

  get views(): readonly RenderView[] { return this._views; }
  get size(): number { return this._views.length; }

  add(view: RenderView): this {
    if (this._views.includes(view)) return this;
    if (this._views.some(candidate => candidate.key === view.key)) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        `RenderViewFamily already contains view key "${view.key}".`,
        {
          hint: 'Assign every RenderView a stable, unique key before adding it to a family.',
          docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
        },
      );
    }
    this._views.push(view);
    this._snapshotCache = null;
    return this;
  }

  remove(view: RenderView): this {
    const index = this._views.indexOf(view);
    if (index >= 0) {
      this._views.splice(index, 1);
      this._snapshotCache = null;
    }
    return this;
  }

  clear(): this {
    this._views.length = 0;
    this._snapshotCache = null;
    return this;
  }

  snapshot(): RenderViewFamilySnapshot {
    const cached = this._snapshotCache;
    if (cached && cached.views.length === this._views.length) {
      let unchanged = true;
      for (let i = 0; i < this._views.length; i++) {
        if (this._views[i]?.snapshot() !== cached.views[i]) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return cached;
    }
    const views = new Array<RenderViewSnapshot>(this._views.length);
    for (let i = 0; i < this._views.length; i++) {
      const view = this._views[i];
      if (view) views[i] = view.snapshot();
    }
    this._snapshotCache = Object.freeze({ views: Object.freeze(views) });
    return this._snapshotCache;
  }
}

export function cloneGpuColor(color: Readonly<GPUColorDict>): GPUColorDict {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

export function getRenderViewPassOptions(view: RenderViewSnapshot): RenderViewTargetPassOptions {
  let options = renderViewPassOptionsCache.get(view);
  if (options) return options;
  options = Object.freeze({
    clearColor: view.clearColor,
    depthConvention: view.depthConvention,
    sampleCount: view.sampleCount,
  });
  renderViewPassOptionsCache.set(view, options);
  return options;
}

const renderViewPassOptionsCache = new WeakMap<RenderViewSnapshot, RenderViewTargetPassOptions>();

function matchesRenderViewSnapshot(view: RenderView, snapshot: RenderViewSnapshot): boolean {
  const viewport = view.viewport;
  const scissor = view.scissor;
  return snapshot.camera === view.camera
    && snapshot.target === view.target
    && snapshot.clearColor.r === view.clearColor.r
    && snapshot.clearColor.g === view.clearColor.g
    && snapshot.clearColor.b === view.clearColor.b
    && snapshot.clearColor.a === view.clearColor.a
    && snapshot.depthConvention === view.depthConvention
    && snapshot.sampleCount === view.sampleCount
    && snapshot.loadOp === view.loadOp
    && snapshot.excludedEntityIds === view.excludedEntityIds
    && snapshot.postProcessEnabled === view.postProcessEnabled
    && sameViewport(viewport, snapshot.viewport)
    && sameScissor(scissor, snapshot.scissor)
    && snapshot.width === (viewport?.width ?? view.target.width)
    && snapshot.height === (viewport?.height ?? view.target.height)
    && snapshot.displayWidth === (viewport?.width ?? view.target.displayWidth)
    && snapshot.displayHeight === (viewport?.height ?? view.target.displayHeight);
}

function sameViewport(a: ViewportRect | null, b: Readonly<ViewportRect> | null): boolean {
  return a === null
    ? b === null
    : b !== null
      && a.x === b.x
      && a.y === b.y
      && a.width === b.width
      && a.height === b.height
      && a.minDepth === b.minDepth
      && a.maxDepth === b.maxDepth;
}

function sameScissor(a: ScissorRect | null, b: Readonly<ScissorRect> | null): boolean {
  return a === null
    ? b === null
    : b !== null
      && a.x === b.x
      && a.y === b.y
      && a.width === b.width
      && a.height === b.height;
}

let nextRenderViewId = 0;

function normalizeViewKey(key: string | undefined): string {
  const normalized = key?.trim();
  if (normalized) return normalized;
  nextRenderViewId = (nextRenderViewId + 1) >>> 0;
  if (nextRenderViewId === 0) nextRenderViewId = 1;
  return `view:${nextRenderViewId}`;
}
