import type { HaiyueEngine } from '@haiyue/engine/core';
import type { Scene, SceneAssetRequest } from '@haiyue/engine/scene';

export interface SceneFlowProgress {
  readonly generation: number;
  readonly id: string | null;
  readonly activeId: string | null;
  readonly phase: 'idle' | 'preparing' | 'ready' | 'committing' | 'active' | 'cancelled' | 'failed' | 'disposed';
  readonly completed: number;
  readonly total: number;
}
export interface SceneFlowRequest {
  readonly id: string;
  readonly create: (signal: AbortSignal) => Scene | Promise<Scene>;
  readonly assets?: readonly SceneAssetRequest[];
  readonly signal?: AbortSignal;
}
export interface SceneFlowOptions {
  readonly engine: Pick<HaiyueEngine, 'activeScene' | 'switchScene'>;
  readonly concurrency?: number;
  readonly maxRequests?: number;
  readonly previous?: 'destroy-owned' | 'retain';
  readonly onProgress?: (progress: SceneFlowProgress) => void;
}
export interface PreparedScene {
  readonly id: string;
  readonly generation: number;
  readonly scene: Scene;
  commit(): Scene;
  dispose(): void;
}
export interface SceneFlow {
  prepare(request: SceneFlowRequest): Promise<PreparedScene>;
  transition(request: SceneFlowRequest): Promise<Scene>;
  cancel(): void;
  readonly progress: SceneFlowProgress;
  dispose(): void;
}
