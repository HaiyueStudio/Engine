import { captureFrameGraphPlan, frameGraphCaptureActive } from '../core/FrameGraphCapture';
import { FrameGraphPlanCache } from '../core/FrameGraphPlanCache';
import { RenderGraph, type RenderGraphStats, type RenderGraphResourceLifetime, type RenderGraphCompiledPass } from '../core/RenderGraph';
import type { PostProcessPass } from './PostProcessPass';

interface Access {
  /** The shader still needs a valid, non-aliasing source binding when its color is ignored. */
  readonly readsColor: boolean;
  readonly sideEffect: boolean;
}
const contracts = new WeakMap<PostProcessPass, () => Access>();
const conservative: Access = { readsColor: true, sideEffect: true };
const colorOnly: Access = { readsColor: true, sideEffect: false };

/** Private, exact built-in registrations. Custom passes/subclasses stay conservative. */
export function registerPostProcessGraphAccess(pass: PostProcessPass, access: () => Access = () => colorOnly): void {
  contracts.set(pass, access);
}

interface CompiledPostPlan {
  readonly nodes: readonly Omit<RenderGraphCompiledPass<PostProcessPass>, 'payload'>[];
  readonly lifetimes: readonly RenderGraphResourceLifetime<string>[];
  readonly stats: RenderGraphStats;
}
type AccessKey = readonly [string, boolean, boolean, boolean, boolean, boolean, boolean];

/** Logical content dependencies; physical ping-pong bindings remain owned by the renderer. */
export class PostProcessGraph {
  private readonly graph = new RenderGraph<PostProcessPass, string>();
  private readonly active: PostProcessPass[] = [];
  constructor(private readonly domain = 'postprocess') {}
  readonly cache = new FrameGraphPlanCache<CompiledPostPlan>();
  private scope = '';
  private compiled: CompiledPostPlan | undefined;
  private readonly currentNodes: RenderGraphCompiledPass<PostProcessPass>[] = [];
  private readonly accessKeys: AccessKey[] = [];
  private keyScope = '';
  private serializedKey: string | undefined;
  setCacheScope(device: object | undefined, scope: string): void { this.cache.selectGeneration(device); this.scope = scope; }
  clearCache(): void { this.cache.clear(); this.active.length = 0; this.currentNodes.length = 0; this.compiled = undefined; this.graph.clear(); this.accessKeys.length = 0; this.serializedKey = undefined; }
  compile(passes: readonly PostProcessPass[]): readonly PostProcessPass[] {
    let changed = this.keyScope !== this.scope || this.accessKeys.length !== passes.length;
    const accesses = this.accessKeys;
    for (let index = 0; index < passes.length; index++) {
      const pass = passes[index]!;
      const access = contracts.get(pass)?.() ?? conservative;
      const label = pass.label, readsColor = access.readsColor, sideEffect = access.sideEffect;
      const depth = !!pass.needsDepthTexture, normal = !!pass.needsNormalTexture;
      const motion = !!pass.needsMotionTexture, outline = !!pass.needsOutlineMask;
      const old = accesses[index];
      // Re-read live contracts/requirements even when the pass instance is unchanged.
      if (!old || old[0] !== label || old[1] !== readsColor || old[2] !== sideEffect
        || old[3] !== depth || old[4] !== normal || old[5] !== motion || old[6] !== outline) {
        changed = true;
        // A later custom contract/getter may throw. Never leave an old serialized
        // key associated with partially refreshed structural fields after recovery.
        this.serializedKey = undefined;
        accesses[index] = [label, readsColor, sideEffect, depth, normal, motion, outline];
      }
    }
    accesses.length = passes.length;
    if (changed || this.serializedKey === undefined) {
      this.serializedKey = JSON.stringify([this.scope, accesses]); this.keyScope = this.scope;
    }
    const key = this.serializedKey;
    const cached = this.cache.get(key);
    if (cached) { const result = this.bind(cached, passes); this.capture(passes, accesses); return result; }
    const graph = this.graph;
    graph.clear(); this.active.length = 0;
    let color = graph.addResource({ name: 'scene-color', payload: 'external', transient: false });
    const binding = graph.addResource({ name: 'initialized-source-binding', payload: 'external', transient: false });
    const auxiliary = new Map<string, number>();
    for (let index = 0; index < passes.length; index++) {
      const pass = passes[index]!;
      const values = accesses[index]!;
      const access = { readsColor: values[1], sideEffect: values[2] };
      const node = graph.addPass({ name: `postprocess:${index}:${pass.label}`, passClass: 'view-local', payload: pass, sideEffect: access.sideEffect });
      graph.read(node, access.readsColor ? color : binding);
      for (const [name, required] of [
        ['linear-depth', values[3]], ['view-normal', values[4]],
        ['motion', values[5]], ['outline-mask', values[6]],
        ['outline-visible-mask', values[6]],
      ] as const) {
        if (!required) continue;
        let resource = auxiliary.get(name);
        if (resource === undefined) {
          resource = graph.addResource({ name, payload: 'external', transient: false }); auxiliary.set(name, resource);
        }
        graph.read(node, resource);
      }
      color = graph.addResource({ name: `color:${index}`, payload: 'color', observable: index === passes.length - 1 });
      graph.write(node, color);
    }
    const compiled = Object.freeze({
      nodes: Object.freeze(graph.compile().map(({ payload: _payload, ...node }) => Object.freeze(node))),
      lifetimes: Object.freeze(graph.resourceLifetimes.map(resource => Object.freeze({ ...resource }))),
      stats: Object.freeze({ ...graph.stats }),
    });
    this.cache.set(key, compiled);
    graph.clear();
    const result = this.bind(compiled, passes); this.capture(passes, accesses); return result;
  }
  private capture(passes: readonly PostProcessPass[], accesses: readonly (readonly [string, boolean, boolean, boolean, boolean, boolean, boolean])[]): void {
    if (!frameGraphCaptureActive()) return;
    const live = new Set(this.currentNodes.map(node => node.handle));
    captureFrameGraphPlan(this.domain, accesses.map((access, index) => ({
      name: `postprocess:${index}:${access[0]}`, kind: 'postprocess', live: live.has(index),
      reads: [access[1] ? index ? `color:${index - 1}` : 'scene-color' : 'initialized-source-binding',
        ...(access[3] ? ['linear-depth'] : []), ...(access[4] ? ['view-normal'] : []),
        ...(access[5] ? ['motion'] : []), ...(access[6] ? ['outline-mask', 'outline-visible-mask'] : [])],
      writes: [`color:${index}`], dependsOn: access[1] && index ? [`postprocess:${index - 1}:${passes[index - 1]!.label}`] : [],
      reason: !live.has(index) ? 'color-output-unconsumed' : access[2] ? 'history-or-conservative-side-effect' : index === passes.length - 1 ? 'final-color-output' : 'required-color-dependency',
    })), this.resourceLifetimes, this.cache.stats);
  }
  private bind(compiled: CompiledPostPlan, passes: readonly PostProcessPass[]): readonly PostProcessPass[] {
    this.compiled = compiled; this.active.length = 0; this.currentNodes.length = 0;
    for (const node of compiled.nodes) {
      const payload = passes[node.handle]!;
      this.active.push(payload); this.currentNodes.push({ ...node, payload });
    }
    return this.active;
  }
  get stats() { return this.compiled?.stats ?? this.graph.stats; }
  get snapshot() { return this.currentNodes; }
  get resourceLifetimes() { return this.compiled?.lifetimes ?? []; }
}
