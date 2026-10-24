import {Entity, World} from '@haiyue/engine/ecs';
import {Camera2D, Transform2D} from '@haiyue/engine/components';
import type {IEngine, RenderCommandContext} from '@haiyue/engine/extension-authoring';
import {AnimationMaskSources} from '../../AnimationMaskSources.js';
import {Animation2DRenderSystem} from '../../Animation2DRenderSystem.js';
import type {PreparedProductionFrameStep} from '../../production/FrameTransaction.js';
import {compileProductionDrawPlan, ProductionDrawError, type ProductionDrawPlan, type ProductionDrawTextures} from './ProductionDrawPlan.js';
import type {ProductionLayoutFrame} from './types.js';

interface Slot {readonly renderer: Animation2DRenderSystem;}
interface Generation {
  readonly identity: object | undefined; readonly id: number; readonly frames: readonly ProductionLayoutFrame[]; readonly revision: string;
  readonly plan: ProductionDrawPlan; readonly world: World; readonly camera: Entity; readonly slots: Slot[];
  readonly queues: Set<GPUQueue>; recordings: number; retired: boolean; collecting: boolean; destroyed: boolean;
}
interface Recording {readonly generation: Generation; readonly slot: Slot; closed: boolean; close(): void;}
const devices = new WeakMap<GPUDevice, Set<Recording>>();
let nextOwner = 0;
const fail = (code: string, path: string, message: string): never => {throw new ProductionDrawError(code, path, message);};

/** Immutable changed-frame generations reuse the original renderer and public recording lifetime. */
export class ProductionDrawOwner {
  private readonly generations = new Set<Generation>();
  private readonly recordings = new WeakMap<RenderCommandContext, Map<string, Recording>>();
  private readonly closedContexts = new WeakSet<RenderCommandContext>();
  private current: Generation | undefined;
  private pending: Generation | undefined;
  private preparing = false;
  private recording = false;
  private disposed = false;
  private suspended = false;
  private device: GPUDevice | undefined;
  private serial = 0;
  private readonly unregisterRecovery: (() => void) | undefined;
  private readonly failures: unknown[] = [];
  readonly recoveryLabel = `HYA layout draw:${++nextOwner}`;
  readonly recoverySource = {kind: 'hya-layout-draw' as const};
  readonly renderPipelineOptions = {pass: 'isolated' as const, loadOp: 'load' as const};
  constructor(private readonly engine: IEngine, private readonly textures?: ProductionDrawTextures,
    private readonly options: Readonly<{maxGeometryBytes?: number; maxMaskTargets?: number; diagnostic?: (error: unknown) => void}> = {}) {
    if (options.maxGeometryBytes !== undefined && (!Number.isSafeInteger(options.maxGeometryBytes) || options.maxGeometryBytes < 0 || options.maxGeometryBytes > 512 * 1024 * 1024))
      fail('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'geometry limit may only tighten this private 512 MiB staging guard');
    this.unregisterRecovery = engine.registerDeviceRecoveryParticipant?.(this);
  }
  /** May be returned directly from the compiled composition host.draw callback. */
  prepare(frames: readonly ProductionLayoutFrame[], resourceRevision = ''): PreparedProductionFrameStep {
    this.live();
    if (this.preparing || this.recording || this.pending) fail('E_HYA_RUNTIME_REENTRANT', '$.draw.prepare', 'another draw preparation/recording is active');
    this.preparing = true;
    try {this.textures?.prepare?.(frames); this.live();} finally {this.preparing = false;}
    resourceRevision += ':' + String(this.textures?.revision ?? '');
    if (this.current && this.current.identity === undefined && this.current.revision === resourceRevision && sameFrames(this.current.frames, frames)) {
      this.preparing = true; try {this.current.plan.assertReady(); this.live(); return {commit() {}, rollback() {}};} finally {this.preparing = false;}
    }
    return this.prepareGeneration(frames, resourceRevision, undefined, () => compileProductionDrawPlan(frames, this.textures, this.options.maxGeometryBytes));
  }
  /** Internal bridge: a core/combined compiler uses the same generation, recording and fence owner. */
  preparePlan(identity: object, revision: string, compile: () => ProductionDrawPlan): PreparedProductionFrameStep {
    this.live();
    if (this.preparing || this.recording || this.pending) fail('E_HYA_RUNTIME_REENTRANT', '$.draw.prepare', 'another draw preparation/recording is active');
    if (this.current?.identity === identity && this.current.revision === revision) {
      this.preparing = true; try {this.current.plan.assertReady(); this.live(); return {commit() {}, rollback() {}};} finally {this.preparing = false;}
    }
    return this.prepareGeneration([], revision, identity, compile);
  }
  private prepareGeneration(frames: readonly ProductionLayoutFrame[], resourceRevision: string, identity: object | undefined, compile: () => ProductionDrawPlan): PreparedProductionFrameStep {
    this.preparing = true; let next: Generation | undefined, prepared: ProductionDrawPlan | undefined;
    try {
      const plan = prepared = compile();
      if (plan.viewport.length !== 2 || plan.viewport.some(value => !Number.isFinite(value) || value <= 0) || !Number.isFinite(plan.dpr) || plan.dpr <= 0
        || !Number.isSafeInteger(plan.geometryBytes) || plan.geometryBytes < 0) fail('E_HYA_RUNTIME_DRAW', '$.draw.plan', 'compiled draw plan has invalid dimensions or accounting');
      plan.assertReady();
      const retained = [...this.generations].reduce((bytes, value) => bytes + value.plan.geometryBytes * Math.max(1, value.slots.length), 0);
      if (retained + plan.geometryBytes > (this.options.maxGeometryBytes ?? 512 * 1024 * 1024))
        fail('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'prepared and retained draw generations exceed the private staging guard');
      const world = new World('HYA prepared layout draw'), camera = new Entity('HYA layout camera').addComponent(new Camera2D({
        width: Math.max(1, plan.viewport[0]), height: Math.max(1, plan.viewport[1]), designWidth: Math.max(1, plan.viewport[0]), designHeight: Math.max(1, plan.viewport[1]), viewportMode: 'fixed',
      }));
      next = {identity, id: ++this.serial, frames: Object.freeze([...frames]), revision: resourceRevision, plan, world, camera, slots: [], queues: new Set(), recordings: 0, retired: false, collecting: false, destroyed: false};
      this.generations.add(next); world.addEntity(camera);
      const plane = new Entity('HYA logical screen plane').addComponent(new Transform2D({x: -plan.viewport[0] / 2, y: plan.viewport[1] / 2, scaleY: -1}));
      if (plan.maskSources?.length) plane.addComponent(new AnimationMaskSources(plan.maskSources));
      world.addEntity(plane);
      for (const visual of plan.visuals) plane.addChild(new Entity(visual.nodeId).addComponent(new Transform2D()).addComponent(visual));
      this.live(); this.pending = next;
      let generation: Generation | undefined = next, previous = this.current, closed = false, committed = false;
      return Object.freeze({value: Object.freeze({generation: next.id, visuals: plan.visuals.length}),
        commit: () => {if (closed) return; closed = true; this.pending = undefined; const value = generation; generation = undefined; if (!this.disposed && value && !value.destroyed) {this.current = value; committed = true;}},
        rollback: () => {if (closed) return; closed = true; this.pending = undefined; const value = generation; generation = undefined; if (value) this.retire(value);},
        finalize: () => {if (!committed) return; const value = previous; previous = undefined; if (value) this.retire(value);},
      });
    } catch (error) {
      if (next) this.retire(next); else if (prepared) try {prepared.release();} catch (cleanup) {throw new AggregateError([error, cleanup], 'Draw staging and cleanup failed');}
      throw error;
    } finally {this.preparing = false;}
  }
  record(_world: World, context: RenderCommandContext): this {
    this.live(); const generation = this.current ?? fail('E_HYA_RUNTIME_DRAW', '$.draw.record', 'there is no committed draw frame');
    if (this.suspended) fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.device', 'draw owner is waiting for device recovery');
    if (this.preparing || this.recording) fail('E_HYA_RUNTIME_REENTRANT', '$.draw.record', 'draw recording cannot reenter preparation or recording');
    this.recording = true;
    try {
    if (this.closedContexts.has(context)) fail('E_HYA_RUNTIME_DRAW', '$.draw.context', 'a closed recording cannot be reused for another generation or view');
    if (context.device !== this.engine.device || this.device && this.device !== context.device)
      fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.device', 'a recording requires the active device and completed draw recovery');
    this.device = context.device;
    const afterSubmit = context.afterSubmit?.bind(context) ?? fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.context', 'draw ownership requires public submit callbacks');
    const afterCancel = context.afterCancel?.bind(context) ?? fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.context', 'draw ownership requires public cancel callbacks');
    generation.plan.assertReady();
    this.live();
    let entries = this.recordings.get(context); if (!entries) {entries = new Map(); this.recordings.set(context, entries);}
    const view = context.view, key = JSON.stringify([generation.id, view?.key ?? 'default', view?.target.width ?? this.engine.width,
      view?.target.height ?? this.engine.height, view?.sampleCount ?? this.engine.msaaSamples, view?.target.format ?? this.engine.format]);
    let recording = entries.get(key);
    if (recording?.closed) fail('E_HYA_RUNTIME_DRAW', '$.draw.context', 'a closed recording cannot be reused');
    if (!recording) {
      // This generation's visuals, screen plane and camera are immutable.
      // Pending views can share their object/geometry buffers; changed frames
      // still receive a distinct generation until all old recordings retire.
      let slot = generation.slots[0];
      if (!slot) {
        const retained = [...this.generations].reduce((bytes, value) => bytes + value.plan.geometryBytes * Math.max(1, value.slots.length), 0);
        if (retained + (generation.slots.length ? generation.plan.geometryBytes : 0) > (this.options.maxGeometryBytes ?? 512 * 1024 * 1024))
          fail('E_HYA_RUNTIME_LIMIT', '$.draw.geometryBytes', 'retained draw generations/recordings exceed the private staging guard');
        const renderer = new Animation2DRenderSystem(this.engine, generation.camera, {loadOp: 'load', ...(this.options.maxMaskTargets === undefined ? {} : {maxMaskTargets: this.options.maxMaskTargets})});
        generation.world.addSystem(renderer); slot = {renderer}; generation.slots.push(slot);
      }
      generation.recordings++; generation.queues.add(context.device.queue);
      let active = devices.get(context.device);
      if (!active) {active = new Set(); devices.set(context.device, active); const owned = active; void context.device.lost.then(() => {for (const value of [...owned]) value.close(); owned.clear();});}
      const owned = active, acquired = slot;
      const value: Recording = {generation, slot: acquired, closed: false, close: () => {
        if (value.closed) return; value.closed = true; owned.delete(value); this.closedContexts.add(context);
        entries!.delete(key); if (!entries!.size) this.recordings.delete(context);
        generation.recordings--; this.collect(generation);
      }};
      recording = value; entries.set(key, value); active.add(value);
      try {afterCancel(value.close); afterSubmit(value.close);} catch (error) {value.close(); throw error;}
    }
    if (recording.closed) fail('E_HYA_RUNTIME_DRAW', '$.draw.context', 'a terminal context cannot start drawing');
    // A view's scene camera must not replace the layout's fixed logical plane.
    // The Proxy preserves context getters and binds methods to the real context.
    generation.world.frameData.begin(generation.world, this.engine, context.frameData?.frameId ?? 0, 0);
    const ownView = view ? {...view, camera: generation.camera} : undefined;
    const forwarded = new Proxy(context, {get(target, name) {
      if (name === 'view') return ownView;
      if (name === 'frameData') return generation.world.frameData;
      const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
    recording.slot.renderer.record(generation.world, forwarded); this.live(); return this;
    } finally {this.recording = false;}
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.unregisterRecovery?.(); this.current = undefined; this.pending = undefined;
    for (const value of this.generations) this.retire(value);
  }
  suspendForDeviceLoss(): void {
    if (this.disposed) return; this.suspended = true;
    for (const value of this.generations) for (const slot of value.slots) slot.renderer.suspendForDeviceLoss();
  }
  recoverGpuResource(device: GPUDevice, signal: AbortSignal): void {
    if (this.disposed) return; if (signal.aborted) throw signal.reason;
    if (device !== this.engine.device) fail('E_HYA_RUNTIME_HOST_PORT', '$.draw.device', 'recovery device is not the active host device');
    for (const value of this.generations) for (const slot of value.slots) slot.renderer.recoverGpuResource(device, signal);
    this.device = device;
    this.suspended = false;
  }
  private retire(value: Generation): void {if (value.retired || value.destroyed) return; value.retired = true; this.collect(value);}
  private collect(value: Generation): void {
    if (!value.retired || value.recordings || value.destroyed || value.collecting) return;
    value.collecting = true;
    if (!value.queues.size) {this.finish(value); return;}
    const fences: Promise<unknown>[] = [];
    for (const queue of value.queues) try {fences.push(queue.onSubmittedWorkDone().catch(() => {}));} catch {/* A lost queue cannot retain usable work. */}
    void Promise.all(fences).then(() => this.finish(value));
  }
  private finish(value: Generation): void {
    if (value.destroyed) return; value.destroyed = true; this.generations.delete(value);
    try {value.world.destroy();} catch (error) {this.report(error);}
    try {value.plan.release();} catch (error) {this.report(error);}
  }
  private report(error: unknown): void {this.failures.push(error); if (this.failures.length > 16) this.failures.shift(); try {this.options.diagnostic?.(error);} catch {/* Cleanup cannot be replayed. */}}
  private live(): void {if (this.disposed) fail('E_HYA_RUNTIME_DISPOSED', '$.draw', 'draw owner is disposed');}
  get stats(): Readonly<{generation: number; retainedGenerations: number; retainedGeometryBytes: number; renderers: number; recordings: number; maskTargets: number; maskSources: number; cleanupErrors: number; disposed: boolean}> {
    const values = [...this.generations]; return Object.freeze({generation: this.current?.id ?? 0, retainedGenerations: values.length,
      retainedGeometryBytes: values.reduce((bytes, value) => bytes + value.plan.geometryBytes * Math.max(1, value.slots.length), 0),
      renderers: values.reduce((count, value) => count + value.slots.length, 0), recordings: values.reduce((count, value) => count + value.recordings, 0),
      maskTargets: values.reduce((count, value) => count + value.slots.reduce((sum, slot) => sum + slot.renderer.stats.maskTargetCount, 0), 0),
      maskSources: values.reduce((count, value) => count + value.slots.reduce((sum, slot) => sum + (slot.renderer.stats.maskSourceCount ?? 0), 0), 0), cleanupErrors: this.failures.length, disposed: this.disposed});
  }
}
function sameFrames(a: readonly ProductionLayoutFrame[], b: readonly ProductionLayoutFrame[]): boolean {
  return a.length === b.length && a.every((frame, index) => {const next = b[index]; return next !== undefined && frame.nodes === next.nodes && frame.dpr === next.dpr && frame.viewport.every((value, axis) => value === next.viewport[axis]);});
}
