import { EngineError, EngineErrorCode } from './EngineError';

export type RenderGraphPassClass = 'scene-global' | 'view-local' | 'reflection-local';

export type RenderGraphPassHandle = number;
export type RenderGraphResourceHandle = number;

export interface RenderGraphPassOptions<T> {
  readonly name: string;
  readonly passClass: RenderGraphPassClass;
  readonly payload: T;
  /** Side-effect passes are graph roots. Their complete dependency chain is retained. */
  readonly sideEffect?: boolean;
  /** Disabled passes are counted as culled and never enter the compiled graph. */
  readonly enabled?: boolean;
}

export interface RenderGraphResourceOptions<T> {
  readonly name: string;
  readonly payload: T;
  readonly transient?: boolean;
  /** Observable resources retain their writer even when no graph pass reads them. */
  readonly observable?: boolean;
}

export interface RenderGraphCompiledPass<T> {
  readonly handle: RenderGraphPassHandle;
  readonly name: string;
  readonly passClass: RenderGraphPassClass;
  readonly payload: T;
  readonly index: number;
}

export interface RenderGraphResourceLifetime<T> {
  readonly handle: RenderGraphResourceHandle;
  readonly name: string;
  readonly payload: T;
  readonly transient: boolean;
  readonly observable: boolean;
  readonly firstUse: number;
  readonly lastUse: number;
}

export interface RenderGraphStats {
  readonly declaredPassCount: number;
  readonly executedPassCount: number;
  readonly culledPassCount: number;
  readonly resourceCount: number;
  readonly dependencyCount: number;
  readonly sceneGlobalPassCount: number;
  readonly viewLocalPassCount: number;
  readonly reflectionLocalPassCount: number;
}

interface MutablePass<T> {
  name: string;
  passClass: RenderGraphPassClass;
  payload: T;
  sideEffect: boolean;
  enabled: boolean;
  reads: number[];
  writes: number[];
  dependencies: number[];
}

interface MutableResource<T> {
  name: string;
  payload: T;
  transient: boolean;
  observable: boolean;
  writer: number;
  readers: number[];
}

/**
 * Small deterministic render graph used by the frame planner.
 *
 * Passes declare resource reads/writes and explicit dependencies. compile()
 * removes unreachable work, validates single-writer resources, performs a
 * stable topological sort, and exposes resource lifetimes for transient aliasing.
 */
export class RenderGraph<TPass = unknown, TResource = unknown> {
  private readonly _passes: MutablePass<TPass>[] = [];
  private readonly _resources: MutableResource<TResource>[] = [];
  private readonly _compiledPasses: RenderGraphCompiledPass<TPass>[] = [];
  private readonly _lifetimes: RenderGraphResourceLifetime<TResource>[] = [];
  private readonly _live: boolean[] = [];
  private readonly _indegree: number[] = [];
  private readonly _edges: number[][] = [];
  private readonly _compiledIndex: number[] = [];
  private readonly _ready: number[] = [];
  private _compiled = false;
  private readonly _stats: RenderGraphStats = {
    declaredPassCount: 0,
    executedPassCount: 0,
    culledPassCount: 0,
    resourceCount: 0,
    dependencyCount: 0,
    sceneGlobalPassCount: 0,
    viewLocalPassCount: 0,
    reflectionLocalPassCount: 0,
  };

  get stats(): RenderGraphStats { return this._stats; }
  get compiledPasses(): readonly RenderGraphCompiledPass<TPass>[] { return this._compiledPasses; }
  get resourceLifetimes(): readonly RenderGraphResourceLifetime<TResource>[] { return this._lifetimes; }

  clear(): void {
    this._passes.length = 0;
    this._resources.length = 0;
    this._compiledPasses.length = 0;
    this._lifetimes.length = 0;
    this._compiled = false;
  }

  addPass(options: RenderGraphPassOptions<TPass>): RenderGraphPassHandle {
    this._assertMutable();
    const handle = this._passes.length;
    this._passes.push({
      name: options.name,
      passClass: options.passClass,
      payload: options.payload,
      sideEffect: options.sideEffect === true,
      enabled: options.enabled !== false,
      reads: [],
      writes: [],
      dependencies: [],
    });
    return handle;
  }

  addResource(options: RenderGraphResourceOptions<TResource>): RenderGraphResourceHandle {
    this._assertMutable();
    const handle = this._resources.length;
    this._resources.push({
      name: options.name,
      payload: options.payload,
      transient: options.transient !== false,
      observable: options.observable === true || options.transient === false,
      writer: -1,
      readers: [],
    });
    return handle;
  }

  read(pass: RenderGraphPassHandle, resource: RenderGraphResourceHandle): void {
    this._assertMutable();
    const passNode = this._requirePass(pass);
    const resourceNode = this._requireResource(resource);
    pushUnique(passNode.reads, resource);
    pushUnique(resourceNode.readers, pass);
  }

  write(pass: RenderGraphPassHandle, resource: RenderGraphResourceHandle): void {
    this._assertMutable();
    const passNode = this._requirePass(pass);
    const resourceNode = this._requireResource(resource);
    if (resourceNode.writer >= 0 && resourceNode.writer !== pass) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        `RenderGraph resource "${resourceNode.name}" has more than one writer.`,
        {
          context: {
            resource: resourceNode.name,
            currentWriter: resourceNode.writer,
            conflictingWriter: pass,
          },
          docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
        },
      );
    }
    resourceNode.writer = pass;
    pushUnique(passNode.writes, resource);
  }

  dependsOn(pass: RenderGraphPassHandle, dependency: RenderGraphPassHandle): void {
    this._assertMutable();
    this._requirePass(dependency);
    pushUnique(this._requirePass(pass).dependencies, dependency);
  }

  compile(): readonly RenderGraphCompiledPass<TPass>[] {
    if (this._compiled) return this._compiledPasses;
    this._compiled = true;
    this._compiledPasses.length = 0;
    this._lifetimes.length = 0;
    this._prepareScratch();

    for (let pass = 0; pass < this._passes.length; pass++) {
      const node = this._passes[pass];
      if (node?.enabled && node.sideEffect) this._markLive(pass);
    }
    for (const resource of this._resources) {
      if (resource.observable && resource.writer >= 0) this._markLive(resource.writer);
    }
    for (let pass = 0; pass < this._passes.length; pass++) {
      if (!this._live[pass]) continue;
      const node = this._passes[pass]!;
      for (const dependency of node.dependencies) this._addEdge(dependency, pass);
      for (const resource of node.reads) {
        const writer = this._resources[resource]?.writer ?? -1;
        if (writer >= 0 && this._live[writer]) this._addEdge(writer, pass);
      }
    }

    for (let pass = 0; pass < this._passes.length; pass++) {
      if (this._live[pass] && this._indegree[pass] === 0) this._insertReady(pass);
    }
    while (this._ready.length > 0) {
      const handle = this._ready.shift()!;
      const node = this._passes[handle]!;
      const index = this._compiledPasses.length;
      this._compiledIndex[handle] = index;
      this._compiledPasses.push({ handle, name: node.name, passClass: node.passClass, payload: node.payload, index });
      for (const dependent of this._edges[handle] ?? []) {
        const indegree = (this._indegree[dependent] ?? 0) - 1;
        this._indegree[dependent] = indegree;
        if (indegree === 0) this._insertReady(dependent);
      }
    }

    const liveCount = this._countLive();
    if (this._compiledPasses.length !== liveCount) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineCompilationFailed,
        'RenderGraph contains a dependency cycle.',
        {
          context: {
            livePassCount: liveCount,
            compiledPassCount: this._compiledPasses.length,
          },
          docsPath: 'errors/E_RENDER_PIPELINE_COMPILATION_FAILED',
        },
      );
    }
    this._buildLifetimes();
    this._updateStats(liveCount);
    return this._compiledPasses;
  }

  private _markLive(pass: number): void {
    if (this._live[pass]) return;
    const node = this._passes[pass];
    if (!node?.enabled) return;
    this._live[pass] = true;
    for (const dependency of node.dependencies) this._markLive(dependency);
    for (const resource of node.reads) {
      const writer = this._resources[resource]?.writer ?? -1;
      if (writer >= 0) this._markLive(writer);
    }
  }

  private _buildLifetimes(): void {
    for (let handle = 0; handle < this._resources.length; handle++) {
      const resource = this._resources[handle]!;
      let firstUse = Number.MAX_SAFE_INTEGER;
      let lastUse = -1;
      if (resource.writer >= 0) {
        const index = this._compiledIndex[resource.writer] ?? -1;
        if (index >= 0) firstUse = lastUse = index;
      }
      for (const reader of resource.readers) {
        const index = this._compiledIndex[reader] ?? -1;
        if (index < 0) continue;
        firstUse = Math.min(firstUse, index);
        lastUse = Math.max(lastUse, index);
      }
      if (lastUse < 0) continue;
      this._lifetimes.push({
        handle,
        name: resource.name,
        payload: resource.payload,
        transient: resource.transient,
        observable: resource.observable,
        firstUse,
        lastUse,
      });
    }
  }

  private _prepareScratch(): void {
    this._live.length = this._passes.length;
    this._indegree.length = this._passes.length;
    this._edges.length = this._passes.length;
    this._compiledIndex.length = this._passes.length;
    this._ready.length = 0;
    for (let index = 0; index < this._passes.length; index++) {
      this._live[index] = false;
      this._indegree[index] = 0;
      this._compiledIndex[index] = -1;
      const edges = this._edges[index] ?? [];
      edges.length = 0;
      this._edges[index] = edges;
    }
  }

  private _addEdge(from: number, to: number): void {
    if (from === to || !this._live[from] || !this._live[to]) return;
    const edges = this._edges[from]!;
    if (edges.includes(to)) return;
    edges.push(to);
    this._indegree[to] = (this._indegree[to] ?? 0) + 1;
  }

  private _insertReady(handle: number): void {
    let index = this._ready.length;
    while (index > 0 && (this._ready[index - 1] ?? -1) > handle) index--;
    this._ready.splice(index, 0, handle);
  }

  private _countLive(): number {
    let count = 0;
    for (const live of this._live) if (live) count++;
    return count;
  }

  private _updateStats(liveCount: number): void {
    let dependencies = 0;
    let sceneGlobal = 0;
    let viewLocal = 0;
    let reflectionLocal = 0;
    for (const pass of this._compiledPasses) {
      dependencies += this._edges[pass.handle]?.length ?? 0;
      if (pass.passClass === 'scene-global') sceneGlobal++;
      else if (pass.passClass === 'view-local') viewLocal++;
      else reflectionLocal++;
    }
    Object.assign(this._stats, {
      declaredPassCount: this._passes.length,
      executedPassCount: liveCount,
      culledPassCount: this._passes.length - liveCount,
      resourceCount: this._lifetimes.length,
      dependencyCount: dependencies,
      sceneGlobalPassCount: sceneGlobal,
      viewLocalPassCount: viewLocal,
      reflectionLocalPassCount: reflectionLocal,
    });
  }

  private _requirePass(handle: number): MutablePass<TPass> {
    const pass = this._passes[handle];
    if (!pass) throw new RangeError(`Unknown RenderGraph pass ${handle}.`);
    return pass;
  }

  private _requireResource(handle: number): MutableResource<TResource> {
    const resource = this._resources[handle];
    if (!resource) throw new RangeError(`Unknown RenderGraph resource ${handle}.`);
    return resource;
  }

  private _assertMutable(): void {
    if (this._compiled) {
      throw new EngineError(
        EngineErrorCode.RenderPipelineInvalidPassState,
        'RenderGraph is already compiled. Call clear() before rebuilding it.',
        { docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE' },
      );
    }
  }
}

function pushUnique(values: number[], value: number): void {
  if (!values.includes(value)) values.push(value);
}
