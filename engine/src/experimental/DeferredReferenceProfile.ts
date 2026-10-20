import type { DeferredTileOptions } from '../renderer/DeferredTileResources';
import type { IEngine } from '../core/IEngine';
import type { Render3DSystem } from '../systems/Render3DSystem';
import { prepareRender3DPbrRenderer } from '../systems/Render3DSystemAccess';
import { beginDeferredLightingInitialization, endDeferredLightingInitialization, installDeferredLightingBackend } from '../renderer/DeferredLightingBackendPort';
import { validateDeferredDevice } from '../renderer/DeferredLightingCapabilities';
import { DeferredLightingCapabilityError } from '../frame/DeferredLightTable';

export interface InternalDeferredReferenceProfileOptions {
  readonly tiled?: DeferredTileOptions;
  readonly baseline?: 'batched' | 'gpu-driven';
  readonly failurePolicy?: 'strict' | 'forward';
  readonly signal?: AbortSignal;
}

/** G02 private factory/installer. G07 owns public experimental exports and consumer API review. */
export async function createDeferredReferenceProfile(system: Render3DSystem, engine: IEngine, options: InternalDeferredReferenceProfileOptions = {}) {
  const strategy = options.tiled ? 'deferred-tiled' as const : 'deferred-reference' as const;
  const baseline = options.baseline ?? 'batched';
  const failurePolicy = options.failurePolicy ?? 'strict';
  if (!['batched', 'gpu-driven'].includes(baseline) || !['strict', 'forward'].includes(failurePolicy)) throw new Error('Invalid Deferred reference profile configuration.');
  if (options.signal?.aborted) throw options.signal.reason;
  system.setRenderProfile(baseline);
  const controller = beginDeferredLightingInitialization(system);
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    try {
      validateDeferredDevice(engine.device);
      if (options.tiled) {
        const { planDeferredTiles } = await import('../renderer/DeferredTileResources');
        if (controller.signal.aborted) throw controller.signal.reason;
        planDeferredTiles(engine.device, 1, 1, options.tiled);
      }
    }
    catch (error) {
      if (!(error instanceof DeferredLightingCapabilityError) || failurePolicy === 'strict') throw error;
      const backend = {
        diagnostics: Object.freeze({ requested: strategy, effective: 'forward', completeCoverage: false, reason: error.reason }),
        record: () => false,
        destroy: () => {},
      };
      installDeferredLightingBackend(system, backend);
      return Object.freeze({ name: baseline, lightingStrategy: strategy, backend });
    }
    const { DeferredReferenceBackend } = await import('../renderer/DeferredReferenceBackend');
    if (controller.signal.aborted) throw controller.signal.reason;
    const renderer = prepareRender3DPbrRenderer(system);
    const backend = new DeferredReferenceBackend(engine, { failurePolicy, ...(options.tiled ? { tiled: options.tiled } : {}) });
    const cancel = () => backend.destroy();
    controller.signal.addEventListener('abort', cancel, { once: true });
    try {
      await backend.initialize(renderer, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      installDeferredLightingBackend(system, backend);
      return Object.freeze({ name: baseline, lightingStrategy: strategy, backend });
    } catch (error) { backend.destroy(); throw error; }
    finally { controller.signal.removeEventListener('abort', cancel); }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    endDeferredLightingInitialization(system, controller);
  }
}
