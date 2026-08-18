import type { IEngine } from '../core/IEngine';
import { getEngineFrameDiagnostics } from '../core/EngineDiagnosticsAccess';
import type { FrameDiagnostics } from '../core/FrameDiagnostics';
import {
  configureRenderFrameContextGpuPassTiming,
  createRenderGpuPassProfiler,
  createRenderFrameContext,
  hasGpuPassTiming,
  setNextGpuPassTimingLabel,
} from '../core/RenderCommandContext';
import type {
  GpuPassTimingRecorder,
  RenderCommandContext,
  RenderFrameContext,
  RenderFrameContextOptions,
  RenderGpuPassProfiler,
} from '../core/RenderCommandContext';
import { cloneRenderPassDescriptor, getCachedRenderPassDescriptor } from '../core/renderPassDescriptor';
import type { RenderPassDescriptorCloneOptions, RenderPassLoadOp, RenderPassStoreOp } from '../core/renderPassDescriptor';
import type { World } from '../ecs/World';
import { getRenderViewPassOptions, type RenderViewSnapshot } from '../core/RenderView';
import type { WorldFrameToken } from '../frame/FrameData';
import {
  RenderFramePlanCompiler,
  type RenderFramePlan,
  type RenderFrameItemInput,
} from './frame-plan/RenderFramePlan';
import {
  canShareRenderPass,
  getResolvedRenderPassKey,
  sharedPassConflictMessage,
} from './frame-plan/RenderPassCompatibility';

export interface RenderRecordSystem {
  record(world: World, context: RenderCommandContext): unknown;
}

export interface DeltaRenderRecordSystem {
  record(world: World, delta: number, context: RenderCommandContext): unknown;
}

export type RenderPipelineSystem = RenderRecordSystem | DeltaRenderRecordSystem;
export type RenderPipelineEntryType = 'render' | 'compute';
export type RenderPipelineRecordMode = 'frame' | 'delta';
export type RenderPipelinePassSharing = 'isolated' | 'shared';

export interface RenderPipelineEntryOptions {
  passType?: RenderPipelineEntryType;
  loadOp?: RenderPassLoadOp | undefined;
  storeOp?: RenderPassStoreOp | undefined;
  colorLoadOp?: RenderPassLoadOp | undefined;
  colorStoreOp?: RenderPassStoreOp | undefined;
  depthLoadOp?: RenderPassLoadOp | undefined;
  depthStoreOp?: RenderPassStoreOp | undefined;
  /** Set to false for full-screen or compute-driven render passes whose pipeline has no depthStencil state. */
  depth?: boolean;
  pass?: RenderPipelinePassSharing;
  sort?: number | undefined;
  order?: number;
  recordMode?: RenderPipelineRecordMode;
}

interface RenderPipelineEntry {
  id: number;
  system: RenderPipelineSystem;
  type: RenderPipelineEntryType;
  loadOp: RenderPassLoadOp | undefined;
  storeOp: RenderPassStoreOp | undefined;
  colorLoadOp: RenderPassLoadOp | undefined;
  colorStoreOp: RenderPassStoreOp | undefined;
  depthLoadOp: RenderPassLoadOp | undefined;
  depthStoreOp: RenderPassStoreOp | undefined;
  depth: boolean;
  pass: RenderPipelinePassSharing;
  sort: number | undefined;
  recordMode: RenderPipelineRecordMode;
  order: number;
  active: boolean;
}

interface RenderPipelineEntryDescriptorOptionsCache {
  clear?: RenderPassDescriptorCloneOptions;
  load?: RenderPassDescriptorCloneOptions;
  inherit?: RenderPassDescriptorCloneOptions;
}

const renderPipelineEntryDescriptorOptionsCache = new WeakMap<RenderPipelineEntry, RenderPipelineEntryDescriptorOptionsCache>();

export type RenderPipelineDiagnosticIssueCode =
  | 'shared-pass-state-ended'
  | 'shared-pass-attachment-conflict';

export interface RenderPipelineEntryDebugSnapshot {
  readonly id: number;
  readonly system: string;
  readonly sort: number;
  readonly order: number;
  readonly type: RenderPipelineEntryType;
  readonly recordMode: RenderPipelineRecordMode;
  readonly sharing: RenderPipelinePassSharing;
  readonly target: string;
  readonly passKey: string;
  readonly loadStore: Readonly<{
    load?: RenderPassLoadOp | undefined;
    store?: RenderPassStoreOp | undefined;
    colorLoad?: RenderPassLoadOp | undefined;
    colorStore?: RenderPassStoreOp | undefined;
    depthLoad?: RenderPassLoadOp | undefined;
    depthStore?: RenderPassStoreOp | undefined;
    depth: boolean;
  }>;
}

export interface RenderPipelinePassDebugSnapshot {
  readonly index: number;
  readonly type: RenderPipelineEntryType;
  readonly key: string;
  readonly target: string;
  readonly shared: boolean;
  readonly entries: readonly number[];
}

export interface RenderPipelineDiagnosticIssue {
  readonly code: RenderPipelineDiagnosticIssueCode;
  readonly entryId: number;
  readonly message: string;
}

export interface RenderPipelineDebugSnapshot {
  readonly execution: number;
  readonly entries: readonly RenderPipelineEntryDebugSnapshot[];
  readonly passes: readonly RenderPipelinePassDebugSnapshot[];
  readonly passCount: number;
  readonly issues: readonly RenderPipelineDiagnosticIssue[];
}

interface MutableRenderPipelinePassTrace {
  index: number;
  type: RenderPipelineEntryType;
  key: string;
  target: string;
  shared: boolean;
  entries: number[];
}

const EMPTY_RENDER_PIPELINE_PASSES: readonly RenderPipelinePassDebugSnapshot[] = Object.freeze([]);
const EMPTY_RENDER_PIPELINE_ISSUES: readonly RenderPipelineDiagnosticIssue[] = Object.freeze([]);

/** Optional integration boundary for ownership/profiling without coupling it to pass scheduling. */
export interface RenderPipelineExecutionBoundary {
  add?(system: RenderPipelineSystem): void;
  enter(system: RenderPipelineSystem): unknown;
  leave(token: unknown): void;
  remove?(system: RenderPipelineSystem): void;
  clear?(): void;
}

export interface RenderPipelineExecuteOptions extends RenderFrameContextOptions {
  context?: RenderFrameContext;
  /** Borrowed phase token supplied by World.update(); callers must not retain it. */
  frameToken?: WorldFrameToken | undefined;
}

const EMPTY_RENDER_PIPELINE_EXECUTE_OPTIONS: RenderPipelineExecuteOptions = Object.freeze({});

export class RenderPipeline {
  private readonly _entries: RenderPipelineEntry[] = [];
  private readonly _entryBySystem = new Map<RenderPipelineSystem, RenderPipelineEntry>();
  private _nextOrder = 0;
  private _activeCount = 0;
  private _removedCount = 0;
  private _nextEntryId = 0;
  private _execution = 0;
  private _lastTargetKey = 'unresolved';
  private readonly _planCompiler = new RenderFramePlanCompiler<RenderPipelineEntry>();
  private _framePlan: RenderFramePlan<RenderPipelineEntry> | null = null;
  private _lastPasses: readonly RenderPipelinePassDebugSnapshot[] = EMPTY_RENDER_PIPELINE_PASSES;
  private _lastIssues: readonly RenderPipelineDiagnosticIssue[] = EMPTY_RENDER_PIPELINE_ISSUES;
  private readonly _frameContextOptions: RenderFrameContextOptions = {};
  private _gpuPassProfiler: RenderGpuPassProfiler | null = null;

  constructor(
    private readonly _engine: IEngine,
    private readonly _executionBoundary?: RenderPipelineExecutionBoundary,
  ) {}

  add(system: RenderPipelineSystem, options: RenderPipelineEntryOptions = {}): this {
    const current = this._entryBySystem.get(system);
    if (current?.active) this.remove(system);

    const entry: RenderPipelineEntry = {
      id: ++this._nextEntryId,
      system,
      type: options.passType ?? 'render',
      loadOp: options.loadOp,
      storeOp: options.storeOp,
      colorLoadOp: options.colorLoadOp,
      colorStoreOp: options.colorStoreOp,
      depthLoadOp: options.depthLoadOp,
      depthStoreOp: options.depthStoreOp,
      depth: options.depth ?? true,
      pass: options.pass ?? 'isolated',
      sort: options.sort,
      recordMode: options.recordMode ?? 'frame',
      order: options.order ?? this._nextOrder++,
      active: true,
    };
    this._executionBoundary?.add?.(system);
    this._entries.push(entry);
    this._entryBySystem.set(system, entry);
    this._activeCount++;
    this._framePlan = null;
    return this;
  }

  remove(system: RenderPipelineSystem): this {
    const entry = this._entryBySystem.get(system);
    if (!entry?.active) return this;
    entry.active = false;
    this._entryBySystem.delete(system);
    this._activeCount--;
    this._removedCount++;
    this._framePlan = null;
    this._executionBoundary?.remove?.(system);
    this._compactRemovedEntriesIfNeeded();
    return this;
  }

  clear(): this {
    this._executionBoundary?.clear?.();
    this._entries.length = 0;
    this._entryBySystem.clear();
    this._nextOrder = 0;
    this._activeCount = 0;
    this._removedCount = 0;
    this._lastPasses = EMPTY_RENDER_PIPELINE_PASSES;
    this._lastIssues = EMPTY_RENDER_PIPELINE_ISSUES;
    this._lastTargetKey = 'unresolved';
    this._framePlan = null;
    this._gpuPassProfiler?.destroy();
    this._gpuPassProfiler = null;
    return this;
  }

  get size(): number {
    return this._activeCount;
  }

  /** Pass/issue traces are populated only while FrameDiagnostics is enabled. */
  getDebugSnapshot(): RenderPipelineDebugSnapshot {
    const entries = this._getFramePlan().items.map(item => freezeEntrySnapshot(item.payload, this._lastTargetKey));
    return Object.freeze({
      execution: this._execution,
      entries: Object.freeze(entries),
      passes: Object.freeze(this._lastPasses.map(pass => Object.freeze({ ...pass, entries: Object.freeze([...pass.entries]) }))),
      passCount: this._lastPasses.length,
      issues: Object.freeze(this._lastIssues.map(issue => Object.freeze({ ...issue }))),
    });
  }

  execute(
    world: World,
    _time = performance.now(),
    delta = 0,
    options: RenderPipelineExecuteOptions = EMPTY_RENDER_PIPELINE_EXECUTE_OPTIONS,
  ): RenderFrameContext {
    const frameDiagnostics = getEngineFrameDiagnostics(this._engine);
    const diagnosticsEnabled = frameDiagnostics?.enabled === true;
    if (!diagnosticsEnabled) {
      this._lastPasses = EMPTY_RENDER_PIPELINE_PASSES;
      this._lastIssues = EMPTY_RENDER_PIPELINE_ISSUES;
    }
    const gpuPassTiming = !options.context && diagnosticsEnabled && frameDiagnostics
      ? this._beginGpuPassTiming(frameDiagnostics.frame)
      : null;
    const context = options.context ?? this._createFrameContext(world, options, gpuPassTiming);
    if (context.frameData) {
      if (options.frameToken !== undefined) context.frameData.useFrameToken(world, this._engine, options.frameToken);
      else context.frameData.begin(world, this._engine, _time, delta);
    }
    const passes: MutableRenderPipelinePassTrace[] | null = diagnosticsEnabled ? [] : null;
    const issues: RenderPipelineDiagnosticIssue[] | null = diagnosticsEnabled ? [] : null;
    let activeSharedEntry: RenderPipelineEntry | null = null;
    let activeSharedDescriptor: GPURenderPassDescriptor | null = null;
    let activeSharedTargetKey = '';
    let activeSharedSampleCount = 1;
    let activePass: MutableRenderPipelinePassTrace | null = null;
    this._execution++;
    const targetKey = getViewTargetKey(context.view);
    this._lastTargetKey = targetKey;

    try {
      for (const planned of this._getFramePlan().items) {
        const entry = planned.payload;
        if (entry.type === 'compute') {
          context.endPass();
          activeSharedEntry = null;
          activeSharedDescriptor = null;
          if (passes) {
            activePass = {
              index: passes.length,
              type: 'compute',
              key: `compute:${entry.id}`,
              target: targetKey,
              shared: false,
              entries: [entry.id],
            };
            passes.push(activePass);
          }
          if (hasGpuPassTiming(context)) {
            setNextGpuPassTimingLabel(context, {
              type: 'compute',
              label: `compute:${entry.id}:${getSystemLabel(entry.system)}`,
            });
          }
          this._recordEntry(entry, world, delta, context, frameDiagnostics, diagnosticsEnabled);
          activePass = null;
          continue;
        }
        const loadOp = entry.loadOp ?? getSystemLoadOp(entry.system) ?? options.loadOp;
        const descriptor = getEntryRenderPassDescriptor(this._engine, entry, loadOp, context.view);
        const sampleCount = context.view?.sampleCount ?? this._engine.msaaSamples;
        if (entry.pass === 'shared') {
          if (
            !context.passActive
            || !activeSharedEntry
            || !activeSharedDescriptor
            || !canShareRenderPass(
              activeSharedDescriptor,
              activeSharedTargetKey,
              activeSharedSampleCount,
              descriptor,
              targetKey,
              sampleCount,
            )
          ) {
            if (issues && context.passActive && activeSharedEntry && activeSharedDescriptor) {
              issues.push({
                code: 'shared-pass-attachment-conflict',
                entryId: entry.id,
                message: sharedPassConflictMessage(
                  activeSharedDescriptor,
                  activeSharedTargetKey,
                  activeSharedSampleCount,
                  descriptor,
                  targetKey,
                  sampleCount,
                ),
              });
            }
            context.endPass();
            context.descriptor = descriptor;
            context.loadOp = loadOp;
            if (hasGpuPassTiming(context)) {
              setNextGpuPassTimingLabel(context, {
                type: 'render',
                label: `render:${getResolvedRenderPassKey(descriptor, targetKey, sampleCount)}`,
              });
            }
            context.beginPass(context.descriptor, loadOp);
            activeSharedEntry = entry;
            activeSharedDescriptor = descriptor;
            activeSharedTargetKey = targetKey;
            activeSharedSampleCount = sampleCount;
            if (passes) {
              activePass = {
                index: passes.length,
                type: 'render',
                key: getResolvedRenderPassKey(descriptor, targetKey, sampleCount),
                target: targetKey,
                shared: true,
                entries: [],
              };
              passes.push(activePass);
            }
          }
          activePass?.entries.push(entry.id);
        } else {
          context.endPass();
          activeSharedEntry = null;
          activeSharedDescriptor = null;
          context.descriptor = descriptor;
          context.loadOp = loadOp;
          if (passes) {
            activePass = {
              index: passes.length,
              type: 'render',
              key: getResolvedRenderPassKey(descriptor, targetKey, sampleCount),
              target: targetKey,
              shared: false,
              entries: [entry.id],
            };
            passes.push(activePass);
          }
          if (hasGpuPassTiming(context)) {
            setNextGpuPassTimingLabel(context, {
              type: 'render',
              label: `render:${getResolvedRenderPassKey(descriptor, targetKey, sampleCount)}:${getSystemLabel(entry.system)}`,
            });
          }
        }

        this._recordEntry(entry, world, delta, context, frameDiagnostics, diagnosticsEnabled);
        if (entry.pass === 'shared' && !context.passActive) {
          if (issues) {
            issues.push({
              code: 'shared-pass-state-ended',
              entryId: entry.id,
              message: `System "${getSystemLabel(entry.system)}" ended a shared pass it does not own.`,
            });
          }
          activeSharedEntry = null;
          activeSharedDescriptor = null;
          activePass = null;
        } else if (!context.passActive) {
          activeSharedEntry = null;
          activeSharedDescriptor = null;
          activePass = null;
        }
      }
    } catch (error) {
      gpuPassTiming?.cancel();
      throw error;
    } finally {
      context.endPass();
    }

    if (passes && issues && frameDiagnostics) {
      this._lastPasses = passes.map(pass => Object.freeze({
        ...pass,
        entries: Object.freeze([...pass.entries]),
      }));
      this._lastIssues = issues;
      frameDiagnostics.increment('passes', passes.length);
    }
    if (!options.context) {
      if (diagnosticsEnabled) frameDiagnostics.measure('submit', () => context.submit());
      else context.submit();
    }
    return context;
  }

  private _getFramePlan(): RenderFramePlan<RenderPipelineEntry> {
    if (this._framePlan) return this._framePlan;
    const inputs: RenderFrameItemInput<RenderPipelineEntry>[] = [];
    for (const entry of this._entries) {
      if (!entry.active) continue;
      inputs.push({ id: entry.id, sort: getEntrySort(entry), order: entry.order, payload: entry });
    }
    this._framePlan = this._planCompiler.compile(inputs);
    return this._framePlan;
  }

  private _createFrameContext(
    world: World,
    options: RenderPipelineExecuteOptions,
    gpuPassTiming: GpuPassTimingRecorder | null,
  ): RenderFrameContext {
    const contextOptions = this._frameContextOptions;
    contextOptions.label = options.label ?? 'RenderPipeline.execute';
    contextOptions.loadOp = options.loadOp;
    contextOptions.descriptor = options.descriptor;
    contextOptions.frameData = options.frameData ?? world.frameData;
    contextOptions.view = options.view;
    contextOptions.viewFamily = options.viewFamily;
    configureRenderFrameContextGpuPassTiming(contextOptions, gpuPassTiming);
    try {
      return createRenderFrameContext(this._engine, contextOptions);
    } finally {
      contextOptions.label = undefined;
      contextOptions.loadOp = undefined;
      contextOptions.descriptor = undefined;
      contextOptions.frameData = undefined;
      contextOptions.view = undefined;
      contextOptions.viewFamily = undefined;
      configureRenderFrameContextGpuPassTiming(contextOptions, null);
    }
  }

  private _beginGpuPassTiming(frame: number): GpuPassTimingRecorder | null {
    if (this._engine.timestampQuerySupported !== true) {
      this._gpuPassProfiler?.destroy();
      this._gpuPassProfiler = null;
      return null;
    }
    const device = this._engine.device;
    if (!this._gpuPassProfiler || this._gpuPassProfiler.device !== device) {
      this._gpuPassProfiler?.destroy();
      const diagnostics = getEngineFrameDiagnostics(this._engine);
      if (!diagnostics) return null;
      this._gpuPassProfiler = createRenderGpuPassProfiler(device, diagnostics);
    }
    return this._gpuPassProfiler.beginFrame(frame);
  }

  private _recordEntry(
    entry: RenderPipelineEntry,
    world: World,
    delta: number,
    context: RenderCommandContext,
    diagnostics: FrameDiagnostics | undefined,
    diagnosticsEnabled: boolean,
  ): void {
    if (diagnosticsEnabled && diagnostics) {
      diagnostics.measure('record', () => this._recordEntryWithoutDiagnostics(entry, world, delta, context));
      return;
    }
    this._recordEntryWithoutDiagnostics(entry, world, delta, context);
  }

  private _recordEntryWithoutDiagnostics(
    entry: RenderPipelineEntry,
    world: World,
    delta: number,
    context: RenderCommandContext,
  ): void {
    const boundary = this._executionBoundary;
    if (!boundary) {
      recordPipelineEntry(entry, world, delta, context);
      return;
    }
    const token = boundary.enter(entry.system);
    try {
      recordPipelineEntry(entry, world, delta, context);
    } finally {
      boundary.leave(token);
    }
  }

  private _compactRemovedEntriesIfNeeded(): void {
    if (this._removedCount < 16 && this._removedCount <= this._activeCount) return;
    let write = 0;
    for (const entry of this._entries) {
      if (entry.active) this._entries[write++] = entry;
    }
    this._entries.length = write;
    this._removedCount = 0;
  }

}

function recordPipelineEntry(
  entry: RenderPipelineEntry,
  world: World,
  delta: number,
  context: RenderCommandContext,
): void {
  if (entry.recordMode === 'delta') {
    (entry.system as DeltaRenderRecordSystem).record(world, delta, context);
  } else {
    (entry.system as RenderRecordSystem).record(world, context);
  }
}

function getSystemPriority(system: RenderPipelineSystem): number {
  const priority = (system as { priority?: unknown }).priority;
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
}

function getEntrySort(entry: RenderPipelineEntry): number {
  return entry.sort ?? getSystemPriority(entry.system);
}

function getSystemLoadOp(system: RenderPipelineSystem): RenderPassLoadOp | undefined {
  const loadOp = (system as { loadOp?: unknown }).loadOp;
  return loadOp === 'clear' || loadOp === 'load' ? loadOp : undefined;
}

function getEntryRenderPassDescriptor(
  engine: IEngine,
  entry: RenderPipelineEntry,
  loadOp: RenderPassLoadOp | undefined,
  view: RenderViewSnapshot | undefined,
): GPURenderPassDescriptor {
  const source = view
    ? view.target.getRenderPassDescriptor(getRenderViewPassOptions(view))
    : engine.getRenderPassDescriptor();
  if (
    entry.storeOp ||
    entry.colorLoadOp ||
    entry.colorStoreOp ||
    entry.depthLoadOp ||
    entry.depthStoreOp ||
    !entry.depth
  ) {
    return cloneRenderPassDescriptor(source, createDescriptorCloneOptions(entry, loadOp));
  }
  if (view) return cloneRenderPassDescriptor(source, loadOp);
  return getCachedRenderPassDescriptor(engine, loadOp);
}

function createDescriptorCloneOptions(
  entry: RenderPipelineEntry,
  loadOp: RenderPassLoadOp | undefined,
): RenderPassDescriptorCloneOptions {
  let cache = renderPipelineEntryDescriptorOptionsCache.get(entry);
  if (!cache) {
    cache = {};
    renderPipelineEntryDescriptorOptionsCache.set(entry, cache);
  }
  const key = loadOp ?? 'inherit';
  const cached = cache[key];
  if (cached) return cached;
  const options: RenderPassDescriptorCloneOptions = Object.freeze({
    loadOp,
    storeOp: entry.storeOp,
    colorLoadOp: entry.colorLoadOp,
    colorStoreOp: entry.colorStoreOp,
    depthLoadOp: entry.depthLoadOp,
    depthStoreOp: entry.depthStoreOp,
    depth: entry.depth,
  });
  cache[key] = options;
  return options;
}

function getRenderPassKey(
  entry: RenderPipelineEntry,
  loadOp: RenderPassLoadOp | undefined,
  targetKey = 'view',
): string {
  return [
    targetKey,
    loadOp ?? 'inherit',
    entry.storeOp ?? 'store?',
    entry.colorLoadOp ?? '',
    entry.colorStoreOp ?? '',
    entry.depthLoadOp ?? '',
    entry.depthStoreOp ?? '',
    entry.depth ? 'depth' : 'no-depth',
  ].join('|');
}

function getViewTargetKey(view: RenderViewSnapshot | undefined): string {
  return view?.target.key ?? 'default';
}

function getSystemLabel(system: RenderPipelineSystem): string {
  const label = (system as { label?: unknown }).label;
  if (typeof label === 'string' && label.trim()) return label;
  const name = (system as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name ? name : 'RenderPipelineSystem';
}

function freezeEntrySnapshot(entry: RenderPipelineEntry, targetKey: string): RenderPipelineEntryDebugSnapshot {
  const loadOp = entry.loadOp ?? getSystemLoadOp(entry.system);
  return Object.freeze({
    id: entry.id,
    system: getSystemLabel(entry.system),
    sort: getEntrySort(entry),
    order: entry.order,
    type: entry.type,
    recordMode: entry.recordMode,
    sharing: entry.pass,
    target: targetKey,
    passKey: entry.type === 'compute' ? `compute:${entry.id}` : getRenderPassKey(entry, loadOp, targetKey),
    loadStore: Object.freeze({
      ...(loadOp === undefined ? {} : { load: loadOp }),
      ...(entry.storeOp === undefined ? {} : { store: entry.storeOp }),
      ...(entry.colorLoadOp === undefined ? {} : { colorLoad: entry.colorLoadOp }),
      ...(entry.colorStoreOp === undefined ? {} : { colorStore: entry.colorStoreOp }),
      ...(entry.depthLoadOp === undefined ? {} : { depthLoad: entry.depthLoadOp }),
      ...(entry.depthStoreOp === undefined ? {} : { depthStore: entry.depthStoreOp }),
      depth: entry.depth,
    }),
  });
}
