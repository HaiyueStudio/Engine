import { shaderError } from '../diagnostics';
import type {
  DeformationHistoryAudit,
  DeformationHistorySample,
  DeformationHistorySnapshot,
  DeformationHistoryState,
} from './contracts';

interface HistoryEntry {
  current: DeformationHistorySnapshot;
  pendingResetReason: string | null;
}

/** Renderer-owned history policy. The compiler never owns GPU resources. */
export class DeformationHistoryTracker {
  private readonly entries = new Map<string, HistoryEntry>();
  private state: 'active' | 'disposed' = 'active';

  sample(
    viewId: string | number,
    entityId: string | number,
    state: DeformationHistoryState,
    options: { readonly reset?: boolean; readonly reason?: string } = {},
  ): DeformationHistorySample {
    this.assertActive();
    const current = snapshot(state);
    validateSnapshot(current);
    const key = historyKey(viewId, entityId);
    const entry = this.entries.get(key);
    const reason = options.reason ?? entry?.pendingResetReason ?? (entry ? null : 'first-frame');
    const reset = options.reset === true || !entry || entry.pendingResetReason !== null;
    const previous = reset ? cloneSnapshot(current) : cloneSnapshot(entry.current);
    this.entries.set(key, { current: cloneSnapshot(current), pendingResetReason: null });
    return Object.freeze({
      current,
      previous,
      reset,
      resetReason: reset ? reason ?? 'explicit-reset' : null,
    });
  }

  reset(viewId: string | number, entityId: string | number, reason: string): void {
    this.assertActive();
    const entry = this.entries.get(historyKey(viewId, entityId));
    if (entry) entry.pendingResetReason = reason;
  }

  resetEntity(entityId: string | number, reason: string): void {
    this.assertActive();
    const suffix = `\u0000${String(entityId)}`;
    for (const [key, entry] of this.entries) if (key.endsWith(suffix)) entry.pendingResetReason = reason;
  }

  releaseView(viewId: string | number): void {
    this.assertActive();
    const prefix = `${String(viewId)}\u0000`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  releaseEntity(entityId: string | number): void {
    this.assertActive();
    const suffix = `\u0000${String(entityId)}`;
    for (const key of this.entries.keys()) if (key.endsWith(suffix)) this.entries.delete(key);
  }

  audit(): DeformationHistoryAudit {
    const views = new Set<string>();
    const entities = new Set<string>();
    for (const key of this.entries.keys()) {
      const separator = key.indexOf('\u0000');
      views.add(key.slice(0, separator));
      entities.add(key.slice(separator + 1));
    }
    return Object.freeze({
      state: this.state,
      entryCount: this.entries.size,
      viewCount: views.size,
      entityCount: entities.size,
    });
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.entries.clear();
    this.state = 'disposed';
  }

  private assertActive(): void {
    if (this.state === 'disposed') {
      shaderError('E_SHADER_IR_INVALID', 'Deformation history tracker is disposed.', {
        path: 'deformation.history',
      });
    }
  }
}

function historyKey(viewId: string | number, entityId: string | number): string {
  return `${String(viewId)}\u0000${String(entityId)}`;
}

function snapshot(state: DeformationHistoryState): DeformationHistorySnapshot {
  return Object.freeze({
    modelMatrix: Float32Array.from(state.modelMatrix),
    viewProjectionMatrix: Float32Array.from(state.viewProjectionMatrix),
    morphWeights: Float32Array.from(state.morphWeights),
    jointMatrices: Float32Array.from(state.jointMatrices),
    displacement: Float32Array.from(state.displacement),
  });
}

function cloneSnapshot(state: DeformationHistorySnapshot): DeformationHistorySnapshot {
  return Object.freeze({
    modelMatrix: Float32Array.from(state.modelMatrix),
    viewProjectionMatrix: Float32Array.from(state.viewProjectionMatrix),
    morphWeights: Float32Array.from(state.morphWeights),
    jointMatrices: Float32Array.from(state.jointMatrices),
    displacement: Float32Array.from(state.displacement),
  });
}

function validateSnapshot(state: DeformationHistorySnapshot): void {
  if (state.modelMatrix.length !== 16) invalid('modelMatrix', 16, state.modelMatrix.length);
  if (state.viewProjectionMatrix.length !== 16) invalid('viewProjectionMatrix', 16, state.viewProjectionMatrix.length);
  if (state.morphWeights.length < 1 || state.morphWeights.length > 4) {
    shaderError('E_SHADER_IR_INVALID', 'History morph weights require one to four values.', {
      path: 'deformation.history.morphWeights',
    });
  }
  if (state.jointMatrices.length === 0 || state.jointMatrices.length % 16 !== 0) {
    shaderError('E_SHADER_IR_INVALID', 'History joint matrices must contain complete mat4x4 values.', {
      path: 'deformation.history.jointMatrices',
    });
  }
  if (state.displacement.length !== 3) invalid('displacement', 3, state.displacement.length);
}

function invalid(path: string, expected: number, actual: number): never {
  shaderError('E_SHADER_IR_INVALID', `History ${path} requires ${expected} values; received ${actual}.`, {
    path: `deformation.history.${path}`,
  });
}
