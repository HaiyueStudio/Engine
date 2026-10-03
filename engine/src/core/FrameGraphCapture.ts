import { inheritRenderCommandContextGpuPassTiming, type RenderCommandContext } from './RenderCommandContext';

interface CacheCounters { hits: number; misses: number; evictions: number; invalidations: number; size: number; lastReason: string; lastInvalidationReason: string }
interface PlanNode { name: string; kind: string; reads: readonly string[]; writes: readonly string[]; dependsOn: readonly string[]; live: boolean; reason: string }
interface Lifetime { name: string; firstUse: number; lastUse: number; transient: boolean; observable: boolean }
interface Mapping { name: string; physicalId: number; bytes: number; firstUse: number; lastUse: number; descriptor: string; decision: string }

/** Experimental, JSON-safe point-in-time data. Contains no GPU resources or execution callbacks. */
export interface FrameGraphSnapshot {
  readonly schemaVersion: 1;
  readonly frame: number;
  readonly status: 'recorded' | 'submitted' | 'failed';
  readonly error: string | null;
  readonly scope: 'selected-system-command-context';
  readonly overhead: { readonly gpuReadbacks: 0; readonly extraPasses: 0; readonly retainedGpuBytes: 0; readonly metadataCopyMs: number };
  readonly work: Readonly<{ renderPasses: number; computePasses: number; drawCalls: number; dispatchCalls: number; bundleExecutions: number; bundledDraws: number | null; copies: number; resolves: number; submissions: number | null }>;
  readonly plans: readonly {
    readonly id: number; readonly domain: string; readonly view: string | null;
    readonly nodes: readonly Readonly<PlanNode>[]; readonly lifetimes: readonly Readonly<Lifetime>[];
    readonly cache: Readonly<CacheCounters>;
  }[];
  readonly allocations: readonly {
    readonly id: number; readonly pool: number; readonly owner: string; readonly view: string | null;
    readonly intervalScope: 'allocation-local'; readonly mappings: readonly Readonly<Mapping>[];
    readonly cache: Readonly<CacheCounters>;
  }[];
  readonly pools: readonly { readonly id: number; readonly owner: string; readonly at: 'record-end'; readonly counters: Readonly<Record<string, number>> }[];
  readonly truncated: boolean;
}
export interface FrameGraphInspector {
  /** Arms one capture for the next record() of this system. Does not start a render loop. */
  requestCapture(): void;
  snapshot(): FrameGraphSnapshot | null;
  clear(): void;
  dispose(): void;
}
interface State { armed: boolean; revision: number; snapshot: MutableSnapshot | null }
type MutableSnapshot = { -readonly [K in keyof FrameGraphSnapshot]: FrameGraphSnapshot[K] };
interface Capture {
  context: RenderCommandContext; state: State; revision: number; data: MutableSnapshot;
  plans: FrameGraphSnapshot['plans'][number][]; allocations: FrameGraphSnapshot['allocations'][number][];
  pools: Map<object, { id: number; owner: string; counters: Record<string, number> }>;
  overhead: { gpuReadbacks: 0; extraPasses: 0; retainedGpuBytes: 0; metadataCopyMs: number };
}
const states = new WeakMap<object, State>();
const poolIds = new WeakMap<object, number>();
let nextPool = 0;
let active: Capture | undefined;
const MAX_ENTRIES = 256;

export function createFrameGraphCaptureInspector(owner: object): FrameGraphInspector {
  if (states.has(owner)) throw Error('A FrameGraph inspector already exists for this system.');
  const state: State = { armed: false, revision: 0, snapshot: null }; states.set(owner, state);
  let disposed = false;
  const clear = () => { state.armed = false; state.snapshot = null; state.revision++; };
  return {
    requestCapture() { if (disposed) throw Error('FrameGraph inspector is disposed.'); state.armed = true; },
    snapshot() { return state.snapshot ? freezeCopy(state.snapshot) : null; },
    clear,
    dispose() { if (disposed) return; disposed = true; clear(); states.delete(owner); },
  };
}

export function frameGraphCaptureActive(): boolean { return active !== undefined; }
export function captureFrameGraphPlan(domain: string, nodes: readonly PlanNode[], lifetimes: readonly Lifetime[], cache: CacheCounters): void {
  const capture = active; if (!capture) return;
  const start = performance.now();
  if (capture.plans.length >= MAX_ENTRIES) capture.data.truncated = true;
  else capture.plans.push({ id: capture.plans.length, domain, view: domain === 'scene-global' ? null : capture.context.view?.key ?? null,
    nodes: nodes.slice(0, MAX_ENTRIES).map(node => ({ ...node, reads: [...node.reads], writes: [...node.writes], dependsOn: [...node.dependsOn] })),
    lifetimes: lifetimes.slice(0, MAX_ENTRIES).map(resource => ({ name: resource.name, firstUse: resource.firstUse, lastUse: resource.lastUse, transient: resource.transient, observable: resource.observable })), cache: { ...cache } });
  if (nodes.length > MAX_ENTRIES || lifetimes.length > MAX_ENTRIES) capture.data.truncated = true;
  capture.overhead.metadataCopyMs += performance.now() - start;
}
export function captureFrameGraphAllocation(pool: object, owner: string, mappings: readonly Mapping[], counters: Record<string, number>, cache: CacheCounters): void {
  const capture = active; if (!capture) return;
  const start = performance.now();
  let id = poolIds.get(pool); if (id === undefined) { id = ++nextPool; poolIds.set(pool, id); }
  // These numeric counters are sampled at record-end, then the temporary owner references are dropped.
  capture.pools.set(pool, { id, owner, counters });
  if (capture.allocations.length >= MAX_ENTRIES) capture.data.truncated = true;
  else capture.allocations.push({ id: capture.allocations.length, pool: id, owner, view: capture.context.view?.key ?? null,
    intervalScope: 'allocation-local', mappings: mappings.slice(0, MAX_ENTRIES).map(mapping => ({ ...mapping })), cache: { ...cache } });
  if (mappings.length > MAX_ENTRIES) capture.data.truncated = true;
  capture.overhead.metadataCopyMs += performance.now() - start;
}

/** A synchronous record scope; callbacks and physical bindings never enter the exported snapshot. */
export function beginFrameGraphCapture(owner: object, context: RenderCommandContext): { context: RenderCommandContext; finish(error?: unknown): void } | undefined {
  const state = states.get(owner);
  if (!state?.armed) {
    if (!active) return undefined;
    const previous = active; active = undefined;
    return { context, finish() { active = previous; } };
  }
  state.armed = false;
  const original = context.encoder, previous = active;
  const work = { renderPasses: 0, computePasses: 0, drawCalls: 0, dispatchCalls: 0, bundleExecutions: 0, bundledDraws: 0 as number | null, copies: 0, resolves: 0, submissions: context.afterSubmit ? 0 : null };
  const overhead = { gpuReadbacks: 0 as const, extraPasses: 0 as const, retainedGpuBytes: 0 as const, metadataCopyMs: 0 };
  const data: MutableSnapshot = { schemaVersion: 1, frame: context.frameData?.frameId ?? 0, status: 'recorded', error: null,
    scope: 'selected-system-command-context', work, overhead, plans: [], allocations: [], pools: [], truncated: false };
  const capture: Capture = { state, revision: state.revision, data, context, plans: [], allocations: [], pools: new Map(), overhead };
  const encoder = new Proxy(original, { get(target, key) {
    if (key === 'beginRenderPass' || key === 'beginComputePass') return (descriptor: GPURenderPassDescriptor & GPUComputePassDescriptor) => {
      const render = key === 'beginRenderPass';
      if (render) { work.renderPasses++; for (const attachment of descriptor.colorAttachments) if (attachment?.resolveTarget) work.resolves++; }
      else work.computePasses++;
      const pass = render ? target.beginRenderPass(descriptor) : target.beginComputePass(descriptor);
      return new Proxy(pass, { get(passTarget, method) {
        const value = Reflect.get(passTarget, method, passTarget) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].includes(String(method))) work.drawCalls++;
          if (method === 'dispatchWorkgroups' || method === 'dispatchWorkgroupsIndirect') work.dispatchCalls++;
          if (method === 'executeBundles') { work.bundleExecutions++; work.bundledDraws = null; }
          return Reflect.apply(value, passTarget, args);
        };
      } });
    };
    const value = Reflect.get(target, key, target) as unknown;
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { if (String(key).startsWith('copy')) work.copies++; return Reflect.apply(value, target, args); };
  } });
  context.afterSubmit?.(() => {
    if (state.revision !== capture.revision) return;
    work.submissions = 1; if (data.status !== 'failed') data.status = 'submitted';
  });
  const recordingContext = new Proxy(context, { get(target, key) { return key === 'encoder' ? encoder : Reflect.get(target, key, target); } });
  inheritRenderCommandContextGpuPassTiming(context, recordingContext);
  active = capture;
  return { context: recordingContext, finish(error) {
    active = previous;
    data.plans = capture.plans; data.allocations = capture.allocations;
    data.pools = [...capture.pools.values()].map(pool => ({ id: pool.id, owner: pool.owner, at: 'record-end', counters: { ...pool.counters } }));
    capture.pools.clear();
    if (error !== undefined) { data.status = 'failed'; data.error = String(error); }
    if (state.revision === capture.revision) state.snapshot = data;
  } };
}
function freezeCopy<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); } };
  freeze(clone); return clone;
}
