import {EngineError, EngineErrorCode} from './EngineError.js';
import type {RenderRegion, RenderRegionOptions, RegionUpdateMode} from './RenderRegion';
import type {ScissorRect} from './ViewportRect';

export interface RegionContentSnapshot extends RenderRegionOptions {
  readonly revision: number;
  readonly contentGeneration: number;
  readonly initialized: boolean;
  readonly dirty: boolean;
  readonly pendingOnce: boolean;
}
/** A recording intent. Only a successful submission may confirm it. */
export interface RegionUpdatePlan extends RegionContentSnapshot {
  readonly update: boolean;
  readonly clear: boolean;
  readonly resourceKey: string;
  readonly configuration: number;
  readonly onceSerial: number;
}
function bounds(rect: Readonly<ScissorRect>): Readonly<ScissorRect> {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Invalid render region bounds.');
  return Object.freeze({x: rect.x, y: rect.y, width: rect.width, height: rect.height});
}
function mode(value: RegionUpdateMode): void {
  if (!['demand','once','continuous','disabled'].includes(value)) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Invalid render region update mode.');
}

/** Internal scheduling state; no textures, canvas access, GUI or layout dependencies. */
export class RenderRegionState {
  private options: RenderRegionOptions;
  private revision = 1;
  private renderedRevision = 0;
  private contentGeneration = 0;
  private initialized = false;
  private configuration = 0;
  private onceSerial: number;
  private consumedOnce = 0;
  private resourceKey: string | null = null;
  private disposed = false;
  private readonly plans = new WeakSet<RegionUpdatePlan>();
  readonly handle: RenderRegion;
  get isDisposed(): boolean {return this.disposed;}

  constructor(options: RenderRegionOptions, private readonly changed: () => void, private readonly removed: () => void) {
    if (!options || typeof options.id !== 'string' || !options.id.trim()) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Render region requires a nonempty ID.');
    mode(options.updateMode);
    if (!['on-update','once','never-after-initialization'].includes(options.clearMode) || typeof options.visible !== 'boolean') throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Invalid render region clear mode or visibility.');
    this.options = Object.freeze({...options, bounds: bounds(options.bounds)});
    this.onceSerial = options.updateMode === 'once' ? 1 : 0;
    this.handle = Object.freeze({
      id: options.id,
      invalidate: (reason: string) => {this.live(); if (typeof reason !== 'string' || !reason.trim()) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Render region invalidation requires a reason.'); this.revision++; this.changed();},
      setBounds: (rect: Readonly<ScissorRect>) => {
        this.live(); const next = bounds(rect), previous = this.options.bounds;
        if (next.x === previous.x && next.y === previous.y && next.width === previous.width && next.height === previous.height) return;
        this.options = Object.freeze({...this.options, bounds: next});
        this.configuration++; this.revision++; this.initialized = false; this.changed();
      },
      setMode: (value: RegionUpdateMode) => {
        this.live(); mode(value);
        if (value === this.options.updateMode && value !== 'once') return;
        this.options = Object.freeze({...this.options, updateMode: value}); this.configuration++;
        if (value === 'once') this.onceSerial++;
        this.changed();
      },
      setVisible: (visible: boolean) => {
        this.live(); if (typeof visible !== 'boolean') throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Invalid render region visibility.');
        if (visible === this.options.visible) return;
        this.options = Object.freeze({...this.options, visible}); this.configuration++; this.changed();
      },
      requestOnce: () => {this.live(); this.onceSerial++; this.changed();},
      dispose: () => this.dispose(),
    });
    handles.set(this.handle, this);
  }
  private live(): void {if (this.disposed) throw new EngineError(EngineErrorCode.EngineInvalidState, 'Render region is disposed.');}
  snapshot(): RegionContentSnapshot {
    this.live();
    return Object.freeze({...this.options, revision: this.revision, contentGeneration: this.contentGeneration, initialized: this.initialized,
      dirty: this.revision !== this.renderedRevision, pendingOnce: this.onceSerial > this.consumedOnce});
  }
  prepare(resourceKey: string): RegionUpdatePlan | null {
    this.live(); if (typeof resourceKey !== 'string' || !resourceKey) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Region resource generation requires a key.');
    if (this.resourceKey !== resourceKey) {this.resourceKey = resourceKey; this.configuration++; this.initialized = false;}
    const state = this.snapshot();
    if (!state.visible || state.bounds.width === 0 || state.bounds.height === 0) return null;
    const update = state.updateMode !== 'disabled' && (!state.initialized || state.pendingOnce || state.updateMode === 'continuous' || (state.updateMode === 'demand' && state.dirty));
    if (state.initialized && !update) return null;
    const plan = Object.freeze({...state, update, clear: !state.initialized || (update && state.clearMode === 'on-update'), resourceKey, configuration: this.configuration, onceSerial: this.onceSerial});
    this.plans.add(plan); return plan;
  }
  /** Call from RenderCommandContext.afterSubmit, never from encode or GPU allocation. */
  submitted(plan: RegionUpdatePlan): boolean {
    if (this.disposed || !this.plans.delete(plan) || plan.configuration !== this.configuration || plan.resourceKey !== this.resourceKey) return false;
    this.initialized = true;
    if (plan.update) {
      this.renderedRevision = plan.revision; this.contentGeneration++;
      // A source changed while recording: preserve the pulse until that newer content is rendered.
      if (plan.revision === this.revision) this.consumedOnce = Math.max(this.consumedOnce, plan.onceSerial);
    }
    return true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.removed(); this.changed();
  }
}

/** View-owned registry. GPU cache count/byte limits are enforced by the cache allocator, not by dropping logical regions. */
export class RenderRegionCollection {
  private readonly regions = new Map<string, RenderRegionState>();
  private disposed = false;
  private version = 0;
  get generation(): number {return this.version;}
  get size(): number {return this.regions.size;}
  create(options: RenderRegionOptions): RenderRegion {
    if (this.disposed) throw new EngineError(EngineErrorCode.EngineInvalidState, 'Render view regions are disposed.');
    if (this.regions.has(options?.id)) throw new EngineError(EngineErrorCode.RenderPipelineInvalidPassState, 'Render region IDs must be unique within a view.');
    const state = new RenderRegionState(options, () => {this.version++;}, () => {this.regions.delete(state.handle.id);});
    this.regions.set(state.handle.id, state); this.version++; return state.handle;
  }
  states(): readonly RenderRegionState[] {return Object.freeze([...this.regions.values()]);}
  dispose(): void {if (this.disposed) return; this.disposed = true; for (const state of this.regions.values()) state.dispose();}
}

const owners = new WeakMap<object, RenderRegionCollection>();
const handles = new WeakMap<RenderRegion, RenderRegionState>();
export function getRenderRegionState(handle: RenderRegion): RenderRegionState | undefined {return handles.get(handle);}
export function getRenderRegionCollection(view: object): RenderRegionCollection | undefined {return owners.get(view);}
export function bindRenderRegionCollection(view: object, collection: RenderRegionCollection): void {owners.set(view, collection);}
