import { EngineError, EngineErrorCode } from '@haiyue/engine/core';
import type { Scene, SceneAssetRequest } from '@haiyue/engine/scene';
import type { PreparedScene, SceneFlow, SceneFlowOptions, SceneFlowProgress, SceneFlowRequest } from './types.js';

// Ownership guard only: no registry, asset cache, scene lookup or strong global retention.
const claimed = new WeakSet<Scene>();
type Request = Exclude<SceneAssetRequest, string>;
interface Preparation {
  readonly id: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly assets: readonly Request[];
  readonly cleanups: (() => void)[];
  scene?: Scene;
  completed: number;
  committed: boolean;
  committing: boolean;
  error?: unknown;
}

const invalid = (message: string) => new EngineError(EngineErrorCode.GameplayInvalidInput, message, { docsPath: 'errors/E_GAMEPLAY_INVALID_INPUT' });
const aborted = (cause?: unknown) => new EngineError(EngineErrorCode.SceneFlowAborted, 'Scene preparation was cancelled.', { cause, docsPath: 'errors/E_SCENE_FLOW_ABORTED' });
const superseded = () => new EngineError(EngineErrorCode.SceneFlowSuperseded, 'A newer scene preparation replaced this request.', { docsPath: 'errors/E_SCENE_FLOW_SUPERSEDED' });
const terminal = (scene: Scene) => scene.state === 'destroyed' || scene.state === 'destroying';

class Controller implements SceneFlow {
  private readonly concurrency: number;
  private readonly maxRequests: number;
  private readonly previous: 'destroy-owned' | 'retain';
  private readonly engine: SceneFlowOptions['engine'];
  private readonly onProgress: SceneFlowOptions['onProgress'];
  private readonly owned = new Map<Scene, string>();
  private generation = 0;
  private pending: Preparation | undefined;
  private disposed = false;
  private snapshot: SceneFlowProgress = Object.freeze({ generation: 0, id: null, activeId: null, phase: 'idle', completed: 0, total: 0 });

  constructor(options: SceneFlowOptions) {
    if (!options || typeof options.engine?.switchScene !== 'function') throw invalid('SceneFlow requires an engine scene host.');
    this.engine = options.engine;
    this.concurrency = finiteInteger(options.concurrency, 4, 16, 'concurrency');
    this.maxRequests = finiteInteger(options.maxRequests, 256, 4096, 'maxRequests');
    this.previous = options.previous === undefined ? 'destroy-owned' : options.previous;
    if (!['destroy-owned', 'retain'].includes(this.previous)) throw invalid('Invalid previous-scene policy.');
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw invalid('onProgress must be a function.');
    this.onProgress = options.onProgress;
  }

  get progress(): SceneFlowProgress {
    const active = this.engine.activeScene;
    const activeId = active && !terminal(active) ? this.owned.get(active) ?? null : null;
    if (this.snapshot.activeId !== activeId) this.snapshot = Object.freeze({ ...this.snapshot, activeId });
    return this.snapshot;
  }

  async prepare(request: SceneFlowRequest): Promise<PreparedScene> {
    if (this.disposed) throw aborted('flow-disposed');
    const assets = validateRequest(request, this.maxRequests);
    const { id, create, signal } = request;
    const generation = ++this.generation;
    this.stopPending(superseded(), false);
    // Abort listeners of the previous owner may synchronously start a newer request.
    if (this.generation !== generation || this.disposed) throw superseded();
    const preparation: Preparation = { id, generation, assets, controller: new AbortController(), cleanups: [], completed: 0, committed: false, committing: false };
    this.pending = preparation;
    if (signal) {
      const cancel = () => this.stop(preparation, aborted(signal.reason));
      signal.addEventListener('abort', cancel, { once: true });
      preparation.cleanups.push(() => signal.removeEventListener('abort', cancel));
      if (signal.aborted) cancel();
    }
    try {
      this.live(preparation);
      this.publish(preparation, 'preparing');
      this.live(preparation);
      const creation = Promise.resolve().then(() => {
        this.live(preparation);
        return create(preparation.controller.signal);
      }).then(scene => this.adopt(preparation, scene));
      await this.waitForCreation(preparation, creation);
      this.live(preparation);
      const values = new Array<unknown>(assets.length);
      let next = 0;
      const worker = async () => {
        while (next < assets.length) {
          this.live(preparation);
          const index = next++, asset = assets[index]!;
          const signals = [preparation.controller.signal, asset.signal, asset.options?.signal].filter((s): s is AbortSignal => s !== undefined);
          const { assign: _assign, ...loadRequest } = asset;
          try {
            values[index] = await preparation.scene!.load({ ...loadRequest, signal: AbortSignal.any(signals) });
          } catch (error) {
            if (!preparation.error && (signals.some(signal => signal.aborted) || terminal(preparation.scene!))) {
              this.stop(preparation, aborted(error));
            }
            throw preparation.error ?? error;
          }
          this.live(preparation);
          preparation.completed++;
          this.publish(preparation, 'preparing');
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, assets.length) }, worker));
      this.live(preparation);
      // Commit application bindings in declared order only after the whole preparation succeeds.
      for (let index = 0; index < assets.length; index++) {
        this.live(preparation);
        assets[index]!.assign?.(values[index], preparation.scene!);
      }
      this.live(preparation);
      this.publish(preparation, 'ready');
      this.live(preparation);
      return Object.freeze({ id: preparation.id, generation, scene: preparation.scene!, commit: () => this.commit(preparation), dispose: () => {
        if (!preparation.committed) this.stop(preparation, aborted('prepared-disposed'));
      } });
    } catch (error) {
      if (this.pending === preparation) this.stop(preparation, preparation.error ?? error, true, preparation.controller.signal.aborted ? 'cancelled' : 'failed');
      throw preparation.error ?? error;
    }
  }

  async transition(request: SceneFlowRequest): Promise<Scene> { return (await this.prepare(request)).commit(); }
  cancel(): void { this.stopPending(aborted('flow-cancelled')); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPending(aborted('flow-disposed'), false);
    if (this.engine.activeScene && this.owned.has(this.engine.activeScene)) this.engine.switchScene(null);
    try { for (const scene of [...this.owned.keys()]) this.release(scene); }
    finally { this.snapshot = Object.freeze({ ...this.snapshot, phase: 'disposed', activeId: null }); this.notify(); }
  }

  private adopt(preparation: Preparation, scene: Scene): Scene {
    if (!scene || typeof scene.load !== 'function' || typeof scene.destroy !== 'function' || scene.state !== 'created'
      || scene === this.engine.activeScene || claimed.has(scene)) throw invalid('Scene factory must return a fresh, unowned, live Scene.');
    claimed.add(scene);
    this.owned.set(scene, preparation.id);
    if (!this.isLive(preparation)) {
      this.release(scene);
      throw preparation.error ?? superseded();
    }
    preparation.scene = scene;
    const unregister = scene.engine.registerDeviceRecoveryParticipant?.({
      recoveryLabel: 'scene-flow:' + preparation.id,
      recoverySource: null,
      suspendForDeviceLoss: () => this.stop(preparation, aborted('device-lost')),
      recoverGpuResource: () => {},
    });
    if (unregister) preparation.cleanups.push(unregister);
    return scene;
  }

  private async waitForCreation(preparation: Preparation, creation: Promise<Scene>): Promise<void> {
    const signal = preparation.controller.signal;
    let cancel: () => void = () => {};
    try {
      await Promise.race([creation, new Promise<never>((_resolve, reject) => {
        cancel = () => reject(preparation.error ?? aborted(signal.reason));
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      })]);
    } finally { signal.removeEventListener('abort', cancel); }
  }

  private commit(preparation: Preparation): Scene {
    if (preparation.committed) throw invalid('A prepared scene can only be committed once.');
    try { this.live(preparation); }
    catch (error) {
      this.stop(preparation, error, true, error instanceof EngineError && error.code === EngineErrorCode.SceneFlowAborted ? 'cancelled' : 'failed');
      throw error;
    }
    const scene = preparation.scene!, previous = this.engine.activeScene;
    this.publish(preparation, 'committing');
    this.live(preparation);
    preparation.committing = true;
    try {
      this.engine.switchScene(scene, { destroyPrevious: false });
      this.live(preparation);
      if (this.engine.activeScene !== scene) throw invalid('Scene host did not activate the prepared scene.');
    } catch (error) {
      try {
        if (this.engine.activeScene === scene) this.engine.switchScene(previous && !terminal(previous) ? previous : null);
        // A throwing deactivation hook can leave the old scene selected but inactive.
        if (previous && this.engine.activeScene === previous && previous.state === 'inactive') previous.activate();
        if (this.engine.activeScene !== previous || (previous && previous.state !== 'active')) throw invalid('The previous scene could not be restored.');
      } catch (rollbackError) {
        preparation.error = new EngineError(EngineErrorCode.SceneInvalidState, 'Scene activation failed and the previous scene could not be restored.', {
          cause: new AggregateError([preparation.error ?? error, rollbackError], 'Scene activation and rollback failed.'),
        });
      } finally {
        preparation.committing = false;
        this.stop(preparation, preparation.error ?? error, true, 'failed');
      }
      throw preparation.error ?? error;
    }
    preparation.committing = false;
    preparation.committed = true;
    this.pending = undefined;
    this.cleanup(preparation);
    if (this.previous === 'destroy-owned' && previous && this.owned.has(previous)) this.release(previous);
    this.publish(preparation, 'active');
    return scene;
  }

  private isLive(preparation: Preparation): boolean {
    return !this.disposed && this.pending === preparation && this.generation === preparation.generation
      && !preparation.controller.signal.aborted && (!preparation.scene || !terminal(preparation.scene));
  }
  private live(preparation: Preparation): void {
    if (!this.isLive(preparation)) throw preparation.error ?? aborted('scene-or-flow-unavailable');
  }
  private stopPending(error: unknown, notify = true): void { if (this.pending) this.stop(this.pending, error, notify); }
  private stop(preparation: Preparation, error: unknown, notify = true, phase: 'cancelled' | 'failed' = 'cancelled'): void {
    if (preparation.committed) return;
    const current = this.pending === preparation;
    if (current) this.pending = undefined;
    preparation.error ??= error;
    this.cleanup(preparation);
    preparation.controller.abort(preparation.error);
    if (preparation.scene && !preparation.committing) this.release(preparation.scene);
    if (current && notify && this.generation === preparation.generation && !this.disposed) this.publish(preparation, phase);
  }
  private cleanup(preparation: Preparation): void { for (const cleanup of preparation.cleanups.splice(0)) cleanup(); }
  private release(scene: Scene): void {
    if (!this.owned.delete(scene)) return;
    scene.destroy();
  }
  private publish(preparation: Preparation, phase: SceneFlowProgress['phase']): void {
    if (this.generation !== preparation.generation || this.disposed) return;
    this.snapshot = Object.freeze({ generation: preparation.generation, id: preparation.id, activeId: this.progress.activeId, phase, completed: preparation.completed, total: preparation.assets.length });
    this.notify();
  }
  private notify(): void {
    try { this.onProgress?.(this.progress); }
    catch (error) { console.error('[SceneFlow] Progress observer failed.', error); }
  }
}

function finiteInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw invalid(`${name} must be an integer in [1, ${max}].`);
  return result;
}
function validateRequest(request: SceneFlowRequest, maxRequests: number): readonly Request[] {
  if (!request || typeof request.id !== 'string' || !request.id.trim() || typeof request.create !== 'function'
    || (request.assets !== undefined && !Array.isArray(request.assets)) || (request.assets?.length ?? 0) > maxRequests) throw invalid('Invalid scene request or asset request limit exceeded.');
  validateSignal(request.signal);
  return Array.from(request.assets ?? [], asset => {
    const result = typeof asset === 'string' ? { url: asset } : { ...asset };
    if (typeof result.url !== 'string' || !result.url.trim() || (result.assign !== undefined && typeof result.assign !== 'function')) throw invalid('Invalid scene asset request.');
    validateSignal(result.signal);
    validateSignal(result.options?.signal);
    return Object.freeze({ ...result, ...(result.options ? { options: { ...result.options } } : {}) });
  });
}
function validateSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid('Invalid scene request AbortSignal.');
}

/** Prepare resources on fresh Scenes and activate only the latest complete transaction. */
export function createSceneFlow(options: SceneFlowOptions): SceneFlow { return new Controller(options); }
