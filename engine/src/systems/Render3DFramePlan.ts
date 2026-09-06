import { EngineError, EngineErrorCode } from '../core/EngineError';
import { RenderGraph, type RenderGraphPassClass } from '../core/RenderGraph';

export type Render3DFramePassKind = 'prepare' | 'compute' | 'render' | 'postprocess' | 'cleanup';

export interface Render3DFramePassAccess {
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly after?: readonly string[];
}

export interface Render3DFramePassSnapshot {
  name: string;
  kind: Render3DFramePassKind;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly dependsOn: readonly string[];
}

interface Render3DFramePass {
  snapshot: Render3DFramePassSnapshot & { reads: string[]; writes: string[]; dependsOn: string[] };
  after: string[];
  run(): void;
}

/** View-scoped, single-writer resource versions compiled by the shared RenderGraph. */
export class Render3DFramePlan {
  private readonly _passes: Render3DFramePass[] = [];
  private readonly _snapshot: Render3DFramePassSnapshot[] = [];
  private readonly _passPool: Render3DFramePass[] = [];
  private readonly _imports = new Set<string>();
  private readonly _exports = new Set<string>();
  private readonly _graph = new RenderGraph<Render3DFramePass, string>();
  private readonly _resources = new Map<string, number>();
  private readonly _writers = new Map<string, number>();
  private readonly _names = new Map<string, number>();

  constructor(private readonly _passClass: RenderGraphPassClass = 'view-local') {}

  clear(): this {
    this._passes.length = 0;
    this._snapshot.length = 0;
    this._imports.clear();
    this._exports.clear();
    this._resources.clear();
    this._writers.clear();
    this._names.clear();
    this._graph.clear();
    return this;
  }

  /** External inputs must be imported explicitly. Mutations write a new version. */
  importResources(...names: string[]): this {
    for (const name of names) this._imports.add(name);
    return this;
  }

  /** Outputs observed outside this plan must never be considered transient. */
  exportResources(...names: string[]): this {
    for (const name of names) this._exports.add(name);
    return this;
  }

  add(name: string, kind: Render3DFramePassKind, run: () => void, access: Render3DFramePassAccess = {}): this {
    const index = this._passes.length;
    let pass = this._passPool[index];
    if (!pass) {
      pass = { snapshot: { name, kind, reads: [], writes: [], dependsOn: [] }, after: [], run };
      this._passPool.push(pass);
    }
    pass.run = run;
    pass.snapshot.name = name;
    pass.snapshot.kind = kind;
    copyNames(pass.snapshot.reads, access.reads);
    copyNames(pass.snapshot.writes, access.writes);
    copyNames(pass.after, access.after);
    pass.snapshot.dependsOn.length = 0;
    this._passes.push(pass);
    return this;
  }

  execute(): void {
    // Compile the entire plan before invoking any action, including CPU preparation.
    this._graph.clear();
    this._resources.clear();
    this._writers.clear();
    this._names.clear();
    this._snapshot.length = 0;
    for (const name of this._imports) this._resource(name);
    for (const pass of this._passes) {
      const { name, writes } = pass.snapshot;
      if (this._names.has(name)) this._invalid(`Duplicate pass "${name}".`);
      const handle = this._graph.addPass({ name, passClass: this._passClass, payload: pass, sideEffect: true });
      this._names.set(name, handle);
      for (const resource of writes) {
        if (this._imports.has(resource)) this._invalid(`Pass "${name}" overwrites imported resource "${resource}"; write a new version.`);
        this._graph.write(handle, this._resource(resource));
        this._writers.set(resource, handle);
      }
    }
    for (const resource of this._exports) {
      if (!this._writers.has(resource)) this._invalid(`Exported resource "${resource}" has no producer.`);
    }
    for (const pass of this._passes) {
      const { name, reads, dependsOn } = pass.snapshot;
      const handle = this._names.get(name)!;
      dependsOn.length = 0;
      for (const resource of reads) {
        const writer = this._writers.get(resource);
        if (writer === undefined && !this._imports.has(resource)) {
          this._invalid(`Pass "${name}" reads resource "${resource}" without a producer or import.`);
        }
        if (writer === handle) this._invalid(`Pass "${name}" reads and writes the same resource version "${resource}".`);
        this._graph.read(handle, this._resource(resource));
        if (writer !== undefined) pushUnique(dependsOn, this._passes[writer]!.snapshot.name);
      }
      for (const dependency of pass.after) {
        const previous = this._names.get(dependency);
        if (previous === undefined) this._invalid(`Pass "${name}" depends on missing pass "${dependency}".`);
        this._graph.dependsOn(handle, previous);
        pushUnique(dependsOn, dependency);
      }
    }
    const compiled = this._graph.compile();
    for (const pass of compiled) this._snapshot.push(pass.payload.snapshot);
    for (const pass of compiled) pass.payload.run();
  }

  get snapshot(): readonly Render3DFramePassSnapshot[] { return this._snapshot; }
  get resourceLifetimes() { return this._graph.resourceLifetimes; }
  get stats() { return this._graph.stats; }

  private _resource(name: string): number {
    let handle = this._resources.get(name);
    if (handle === undefined) {
      handle = this._graph.addResource({ name, payload: name, transient: !this._imports.has(name) && !this._exports.has(name) });
      this._resources.set(name, handle);
    }
    return handle;
  }

  private _invalid(message: string): never {
    throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, `Render3DFramePlan: ${message}`, {
      docsPath: 'errors/E_RENDER_PIPELINE_INVALID_PASS_STATE',
    });
  }
}

function copyNames(target: string[], source: readonly string[] = []): void {
  target.length = 0;
  for (const name of source) pushUnique(target, name);
}

function pushUnique(target: string[], name: string): void {
  if (!target.includes(name)) target.push(name);
}
