import type { IEngine } from '../core/IEngine';
import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RenderViewSnapshot } from '../core/RenderView';
import type { World } from '../ecs/World';
import type { SceneFrameUniformSnapshot } from '../frame/SceneFrameUniformLayout';
import type { Render3DRenderItem } from '../systems/Render3DContracts';

export interface DeferredLightingRecordInput {
  readonly engine: IEngine;
  readonly context: RenderCommandContext;
  readonly world: World;
  readonly view: RenderViewSnapshot;
  readonly sceneFrame: SceneFrameUniformSnapshot;
  readonly opaqueItems: readonly Render3DRenderItem[];
  readonly transparentCount: number;
  readonly helperCount: number;
  readonly sceneDescriptor: GPURenderPassDescriptor;
  drawOpaque(pass: GPURenderPassEncoder): void;
  drawSky(pass: GPURenderPassEncoder): void;
  applyViewport(pass: GPURenderPassEncoder): void;
}
export interface DeferredLightingBackendPort {
  /** Returns false only for an explicitly diagnosed whole-view Forward fallback. */
  record(input: DeferredLightingRecordInput): boolean;
  destroy(abandon?: boolean): void;
}
const backends = new WeakMap<object, DeferredLightingBackendPort>();
const initializing = new WeakMap<object, AbortController>();
export function beginDeferredLightingInitialization(owner: object): AbortController {
  removeDeferredLightingBackend(owner);
  const controller = new AbortController();
  initializing.set(owner, controller);
  return controller;
}
export function endDeferredLightingInitialization(owner: object, controller: AbortController): void {
  if (initializing.get(owner) === controller) initializing.delete(owner);
}
export function getDeferredLightingBackend(owner: object): DeferredLightingBackendPort | undefined { return backends.get(owner); }
export function installDeferredLightingBackend(owner: object, backend: DeferredLightingBackendPort): void {
  backends.get(owner)?.destroy();
  backends.set(owner, backend);
}
export function removeDeferredLightingBackend(owner: object, abandon = false): void {
  initializing.get(owner)?.abort(new Error('Deferred profile initialization cancelled by owner change.'));
  initializing.delete(owner);
  backends.get(owner)?.destroy(abandon);
  backends.delete(owner);
}
