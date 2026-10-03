import { captureFrameGraphPlan, frameGraphCaptureActive } from '../core/FrameGraphCapture';
import { EngineError, EngineErrorCode } from '../core/EngineError';
import { FrameGraphPlanCache } from '../core/FrameGraphPlanCache';
import { RenderGraph, type RenderGraphPassClass, type RenderGraphStats, type RenderGraphResourceLifetime } from '../core/RenderGraph';

export type Render3DFramePassKind = 'prepare' | 'compute' | 'render' | 'postprocess' | 'cleanup';

export interface Render3DFramePassAccess {
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly after?: readonly string[];
  /** Required external state updates. Data producers are retained through consumers/exports. */
  readonly sideEffect?: boolean;
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
  sideEffect: boolean;
  run(): void;
}

interface CompiledFramePlan {
  readonly order: readonly number[];
  readonly dependencies: readonly (readonly string[])[];
  readonly lifetimes: readonly RenderGraphResourceLifetime<string>[];
  readonly stats: RenderGraphStats;
}
const idle = () => {};

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

  readonly cache = new FrameGraphPlanCache<CompiledFramePlan>();
  private _scope = '';
  private _compiledPlan: CompiledFramePlan | undefined;
  private _executing = false;

  setCacheScope(device: object | undefined, scope: string): this {
    this._assertIdle(); this.cache.selectGeneration(device); this._scope = scope; return this;
  }
  clearCache(): void { this._assertIdle(); this.cache.clear(); }

  constructor(private readonly _passClass: RenderGraphPassClass = 'view-local', private readonly _domain: string = _passClass) {}

  clear(): this {
    this._assertIdle();
    for (const pass of this._passPool) pass.run = idle;
    this._compiledPlan = undefined;
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
    this._assertIdle();
    for (const name of names) this._imports.add(name);
    return this;
  }

  /** Outputs observed outside this plan must never be considered transient. */
  exportResources(...names: string[]): this {
    this._assertIdle();
    for (const name of names) this._exports.add(name);
    return this;
  }

  add(name: string, kind: Render3DFramePassKind, run: () => void, access: Render3DFramePassAccess = {}): this {
    this._assertIdle();
    const index = this._passes.length;
    let pass = this._passPool[index];
    if (!pass) {
      pass = { snapshot: { name, kind, reads: [], writes: [], dependsOn: [] }, after: [], sideEffect: false, run };
      this._passPool.push(pass);
    }
    pass.run = run;
    pass.sideEffect = access.sideEffect === true;
    pass.snapshot.name = name;
    pass.snapshot.kind = kind;
    copyNames(pass.snapshot.reads, access.reads);
    copyNames(pass.snapshot.writes, access.writes);
    copyNames(pass.after, access.after);
    pass.snapshot.dependsOn.length = 0;
    this._passes.push(pass);
    return this;
  }

  execute(beforeExecute?: () => void): void {
    this._assertIdle(); this._executing = true;
    try {
      const key = JSON.stringify([this._passClass, this._scope, [...this._imports], [...this._exports],
        this._passes.map(pass => [pass.snapshot.name, pass.snapshot.kind, pass.snapshot.reads, pass.snapshot.writes, pass.after, pass.sideEffect])]);
      let compiled = this.cache.get(key);
      if (!compiled) {
        this._compile();
        compiled = Object.freeze({
          order: Object.freeze(this._graph.compiledPasses.map(pass => pass.handle)),
          dependencies: Object.freeze(this._passes.map(pass => Object.freeze([...pass.snapshot.dependsOn]))),
          lifetimes: Object.freeze(this._graph.resourceLifetimes.map(resource => Object.freeze({ ...resource }))),
          stats: Object.freeze({ ...this._graph.stats }),
        });
        this.cache.set(key, compiled);
      }
      this._compiledPlan = compiled;
      this._snapshot.length = 0;
      for (const index of compiled.order) {
        const snapshot = this._passes[index]!.snapshot;
        copyNames(snapshot.dependsOn, compiled.dependencies[index]); this._snapshot.push(snapshot);
      }
      if (frameGraphCaptureActive()) {
        for (let index = 0; index < this._passes.length; index++) copyNames(this._passes[index]!.snapshot.dependsOn, compiled.dependencies[index]);
        const live = new Set(compiled.order);
        captureFrameGraphPlan(this._domain, this._passes.map((pass, index) => ({ ...pass.snapshot, live: live.has(index),
          reason: !live.has(index) ? 'unreachable-from-outputs-and-side-effects' : pass.sideEffect ? 'side-effect' : pass.snapshot.writes.some(name => this._exports.has(name)) ? 'exported-output' : 'required-dependency' })), compiled.lifetimes, this.cache.stats);
      }
      beforeExecute?.();
      for (const index of compiled.order) this._passes[index]!.run();
    } finally { this._executing = false; }
  }

  private _compile(): void {
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
      const handle = this._graph.addPass({ name, passClass: this._passClass, payload: pass, sideEffect: pass.sideEffect });
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
    this._validateCycles();
    this._graph.compile();
  }

  get snapshot(): readonly Render3DFramePassSnapshot[] { return this._snapshot; }
  get resourceLifetimes() { return this._compiledPlan?.lifetimes ?? []; }
  get stats() { return this._compiledPlan?.stats ?? this._graph.stats; }

  private readonly _visitState: number[] = [];

  /** Validate even dead branches before executing any CPU/GPU work. */
  private _validateCycles(): void {
    const state = this._visitState;
    state.length = this._passes.length; state.fill(0);
    const visit = (index: number): void => {
      if (state[index] === 2) return;
      if (state[index] === 1) this._invalid('dependency cycle.');
      state[index] = 1;
      for (const name of this._passes[index]!.snapshot.dependsOn) visit(this._names.get(name)!);
      state[index] = 2;
    };
    for (let index = 0; index < this._passes.length; index++) visit(index);
  }

  private _resource(name: string): number {
    let handle = this._resources.get(name);
    if (handle === undefined) {
      handle = this._graph.addResource({ name, payload: name, transient: !this._imports.has(name) && !this._exports.has(name) });
      this._resources.set(name, handle);
    }
    return handle;
  }

  private _assertIdle(): void {
    if (this._executing) this._invalid('Cannot mutate or reenter an executing plan. Use a separate plan for nested recording.');
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
