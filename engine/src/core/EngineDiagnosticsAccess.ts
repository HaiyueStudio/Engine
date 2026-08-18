import type { FrameDiagnostics } from './FrameDiagnostics';
import type { GPUResourceTracker } from './GPUResourceTracker';
import type { IEngine } from './IEngine';

export interface EngineDiagnosticsState {
  resourceTracker: GPUResourceTracker;
  frameDiagnostics: FrameDiagnostics;
}

const diagnosticsByEngine = new WeakMap<IEngine, EngineDiagnosticsState>();

/** Experimental target-adapter hook. Import from `@haiyue/engine/experimental`. */
export function registerEngineDiagnostics(engine: IEngine, state: EngineDiagnosticsState): void {
  diagnosticsByEngine.set(engine, state);
}

/** Experimental diagnostics accessor. Import from `@haiyue/engine/experimental`. */
export function getEngineGPUResourceTracker(engine: IEngine): GPUResourceTracker | undefined {
  return diagnosticsByEngine.get(engine)?.resourceTracker;
}

/** Experimental diagnostics accessor. Import from `@haiyue/engine/experimental`. */
export function getEngineFrameDiagnostics(engine: IEngine): FrameDiagnostics | undefined {
  return diagnosticsByEngine.get(engine)?.frameDiagnostics;
}
