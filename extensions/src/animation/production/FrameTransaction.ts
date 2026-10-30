import {snapshotPlainTextData} from '../text/PlainTextData.js';
import type {RoutedInteractionEvent} from '../interaction/runtime-types.js';

export type ProductionFramePhase = 'input-queue' | 'atomic-data' | 'state-timeline' | 'text-layout' | 'geometry-draw';
export interface ProductionFrameInput extends Omit<RoutedInteractionEvent, 'sequence' | 'phase' | 'currentTarget' | 'target'> {
  readonly target?: string; readonly pointerType?: 'mouse' | 'touch' | 'pen'; readonly consumed: boolean;
}
export interface ProductionFrameRequest {
  readonly sequence: number; readonly deltaSeconds: number; readonly viewport: readonly [number, number]; readonly dpr: number;
  readonly input?: readonly ProductionFrameInput[];
}
/** Internal transport compiled by the Player; never accepted inside a public frame request. */
export interface ProductionFrameTransport {
  readonly time: number; readonly deltaSeconds: number; readonly rate: number;
  readonly status: 'running' | 'paused' | 'stopped'; readonly relocation?: 'seek' | 'restart' | 'stop';
}
export function snapshotProductionFrameTransport(value: ProductionFrameTransport): ProductionFrameTransport {
  const v = snapshotPlainTextData(value, '$.transport', (path, message) => {throw new ProductionFrameError('E_HYA_RUNTIME_TIME', path, message);}, {strict:true}) as unknown as ProductionFrameTransport;
  if (!v || Array.isArray(v) || Object.keys(v).some(k=>!['time','deltaSeconds','rate','status','relocation'].includes(k))
    || !Number.isFinite(v.time) || v.time < 0 || !Number.isFinite(v.deltaSeconds) || v.deltaSeconds < 0
    || !Number.isFinite(v.rate) || v.rate === 0 || !['running','paused','stopped'].includes(v.status)
    || v.relocation !== undefined && (!['seek','restart','stop'].includes(v.relocation) || v.relocation !== 'seek' && v.time !== 0)) throw new ProductionFrameError('E_HYA_RUNTIME_TIME', '$.transport', 'invalid compiled transport intent');
  return v;
}
export interface ProductionFrameContext {
  readonly transport?: ProductionFrameTransport;
  readonly request: ProductionFrameRequest; readonly values: ReadonlyMap<string, unknown>;
}
export interface PreparedProductionFrameStep {
  readonly value?: unknown;
  /** Logical commit is infallible. Borrowed host callbacks belong in publish, never here. */
  commit(): void; rollback(): void; finalize?(): void; publish?(): void;
}
export interface ProductionFrameStage {
  readonly id: string; readonly phase: ProductionFramePhase;
  /** Must unwind its own work if preparation throws before returning a step. */
  prepare(context: ProductionFrameContext): PreparedProductionFrameStep;
  dispose?(): void;
}
export interface ProductionFrameReceipt {
  readonly sequence: number; readonly values: Readonly<Record<string, unknown>>;
}
export class ProductionFrameError extends Error {
  override readonly name = 'ProductionFrameError';
  constructor(readonly code: string, readonly path: string, message: string) {super(`${message} (${path})`);}
}
const phases: readonly ProductionFramePhase[] = Object.freeze(['input-queue', 'atomic-data', 'state-timeline', 'text-layout', 'geometry-draw']);

/** One whole-player barrier. Domain owners still perform all sampling, binding, layout and drawing. */
export class ProductionFrameTransaction {
  private readonly stages: readonly ProductionFrameStage[];
  private running = false;
  private disposed = false;
  private broken = false;
  private attempt: Readonly<{sequence: number; key: string}> | undefined;
  private committed: Readonly<{key: string; receipt: ProductionFrameReceipt}> | undefined;
  private publicationErrors: readonly Readonly<{stage: string; error: unknown}>[] = Object.freeze([]);
  constructor(stages: readonly ProductionFrameStage[], private readonly diagnostic?: (error: unknown, stage: string) => void) {
    if (stages.length > 16 * 6) throw new ProductionFrameError('E_HYA_RUNTIME_LIMIT', '$.stages', 'compiled stages exceed the original part/stage ceiling');
    const ids = new Set<string>();
    for (const stage of stages) {
      if (!stage || typeof stage.id !== 'string' || !stage.id || ids.has(stage.id) || !phases.includes(stage.phase) || typeof stage.prepare !== 'function')
        throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', '$.stages', 'compiled frame stages need unique identities and accepted phases');
      ids.add(stage.id);
    }
    this.stages = Object.freeze([...stages].sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase)));
  }

  advance(value: ProductionFrameRequest, intent?: ProductionFrameTransport): ProductionFrameReceipt {
    this.assertLive();
    if (this.running) throw new ProductionFrameError('E_HYA_RUNTIME_REENTRANT', '$.advance', 'a composition frame is already active');
    const request = snapshotProductionFrameRequest(value), transport = intent === undefined ? undefined : snapshotProductionFrameTransport(intent), key = JSON.stringify(transport ? {request,transport} : request);
    if (this.attempt && (request.sequence < this.attempt.sequence || request.sequence === this.attempt.sequence && key !== this.attempt.key))
      throw new ProductionFrameError('E_HYA_RUNTIME_SEQUENCE', '$.sequence', 'sequence must increase or repeat exactly the same request');
    if (this.committed?.receipt.sequence === request.sequence && this.committed.key === key) return this.committed.receipt;
    this.attempt = Object.freeze({sequence: request.sequence, key}); this.running = true;
    const values = new Map<string, unknown>(), context = Object.freeze({request, values, ...(transport ? {transport} : {})});
    const prepared: {stage: ProductionFrameStage; step: PreparedProductionFrameStep}[] = [];
    let committing = false;
    try {
      for (const stage of this.stages) {
        this.assertLive();
        const step = stage.prepare(context);
        if (!step || typeof step.commit !== 'function' || typeof step.rollback !== 'function')
          throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', stage.id, 'prepared stage has no commit/rollback ownership');
        prepared.push({stage, step}); values.set(stage.id, step.value); this.assertLive();
      }
      const receipt = Object.freeze({sequence: request.sequence, values: Object.freeze(Object.fromEntries(values))});
      committing = true;
      for (const {step} of prepared) {step.commit(); this.assertLive();}
      for (const {step} of prepared) {step.finalize?.(); this.assertLive();}
      this.committed = Object.freeze({key, receipt});
      const errors: {stage: string; error: unknown}[] = [];
      for (const {stage, step} of prepared) {
        if (this.disposed) break;
        try {step.publish?.();} catch (error) {errors.push(Object.freeze({stage: stage.id, error})); this.report(error, stage.id);}
      }
      this.publicationErrors = Object.freeze(errors); return receipt;
    } catch (error) {
      if (committing) {
        // A violating internal commit cannot be replayed safely. It must never become an
        // apparent successful frame or cause already delivered callbacks to be retried.
        this.broken = true; this.report(error, '$.commit'); this.dispose(); throw error;
      }
      const errors: unknown[] = [error];
      for (const {stage, step} of prepared.reverse()) {
        try {step.rollback();} catch (rollbackError) {errors.push(rollbackError); this.report(rollbackError, stage.id);}
      }
      if (errors.length > 1) {this.broken = true; this.dispose(); throw new AggregateError(errors, 'Composition preparation and rollback failed');}
      throw error;
    } finally {this.running = false;}
  }
  get lastReceipt(): ProductionFrameReceipt | undefined {return this.committed?.receipt;}
  get stats(): Readonly<{running: boolean; disposed: boolean; broken: boolean; publicationErrors: number}> {
    return Object.freeze({running: this.running, disposed: this.disposed, broken: this.broken, publicationErrors: this.publicationErrors.length});
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.committed = undefined; this.attempt = undefined;
    for (const stage of [...this.stages].reverse()) {try {stage.dispose?.();} catch (error) {this.report(error, stage.id);}}
  }
  private report(error: unknown, stage: string): void {try {this.diagnostic?.(error, stage);} catch {/* Diagnostics cannot resend or roll back a committed frame. */}}
  private assertLive(): void {if (this.disposed || this.broken) throw new ProductionFrameError(this.broken ? 'E_HYA_RUNTIME_FRAME_BROKEN' : 'E_HYA_RUNTIME_DISPOSED', '$.frame', 'composition frame owner is not active');}
}

export interface ProductionCheckpointOwner {captureFrame(): object; releaseFrame(token: object): void; restoreFrame(token: object): void;}
/** Adapter for existing data/interaction/semantics/layout checkpoints; it never evaluates another algorithm. */
export function checkpointFrameStage(id: string, phase: ProductionFramePhase, owner: ProductionCheckpointOwner,
  prepare: (context: ProductionFrameContext) => Readonly<{value?: unknown; publish?: () => void}>): ProductionFrameStage {
  let active: object | undefined;
  const close = (action: (token: object) => void): void => {const token = active; if (token === undefined) return; active = undefined; action(token);};
  return Object.freeze({id, phase, prepare(context: ProductionFrameContext) {
    if (active) throw new ProductionFrameError('E_HYA_RUNTIME_STAGE', id, 'checkpoint stage is already active');
    active = owner.captureFrame();
    try {
      const result = prepare(context);
      return Object.freeze({value: result.value, commit: () => close(token => owner.releaseFrame(token)), rollback: () => close(token => owner.restoreFrame(token)), ...(result.publish ? {publish: result.publish} : {})});
    } catch (error) {
      try {close(token => owner.restoreFrame(token));} catch (rollbackError) {throw new AggregateError([error, rollbackError], 'Stage preparation and checkpoint rollback failed');}
      throw error;
    }
  }, dispose: () => close(token => owner.restoreFrame(token))});
}

const requests = new WeakSet<object>();
export function snapshotProductionFrameRequest(value: ProductionFrameRequest): ProductionFrameRequest {
  if (value && typeof value === 'object' && requests.has(value)) return value;
  const request = snapshotPlainTextData(value, '$.frame', (path, message, limit) => {throw new ProductionFrameError(limit ? 'E_HYA_RUNTIME_LIMIT' : 'E_HYA_RUNTIME_FRAME', path, message);}, {strict: true, maxBytes: 64 * 1024 * 1024}) as unknown as ProductionFrameRequest;
  if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !['sequence', 'deltaSeconds', 'viewport', 'dpr', 'input'].includes(key)))
    throw new ProductionFrameError('E_HYA_RUNTIME_FRAME', '$.frame', 'unknown or malformed frame request');
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || typeof request.deltaSeconds !== 'number' || request.deltaSeconds < 0
    || !Array.isArray(request.viewport) || request.viewport.length !== 2 || request.viewport.some(value => typeof value !== 'number' || value < 0) || typeof request.dpr !== 'number' || request.dpr <= 0)
    throw new ProductionFrameError('E_HYA_RUNTIME_FRAME', '$.frame', 'invalid finite sequence, delta, viewport or DPR');
  if (request.input !== undefined && (!Array.isArray(request.input) || request.input.some(event => !event || typeof event.kind !== 'string' || typeof event.consumed !== 'boolean')))
    throw new ProductionFrameError('E_HYA_RUNTIME_FRAME', '$.input', 'expected routed input with an explicit consumption flag');
  requests.add(request); return request;
}
