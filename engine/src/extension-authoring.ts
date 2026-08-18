/**
 * Stable, focused SPI for renderer extensions.
 *
 * This entrypoint deliberately exposes only the engine lifecycle and GPU
 * bookkeeping hooks needed by separately published HaiYue extensions. It is
 * not an alternate engine aggregate.
 */
export { requireEngineDevice } from './core/IEngine';
export type { IEngine } from './core/IEngine';
export { beginRenderCommandPass } from './core/RenderCommandContext';
export type { RenderCommandContext } from './core/RenderCommandContext';
export { cloneRenderPassDescriptor } from './core/renderPassDescriptor';
export type { FrameData } from './frame/FrameData';
export type { RenderPipelineEntryOptions } from './renderer/RenderPipeline';
export { alignUp4 } from './utils/align';
export {
  isEntityDisabledInHierarchyCached,
} from './ecs/utils/hierarchy';
export type { EntityHierarchyDisabledCache } from './ecs/utils/hierarchy';
export { estimateTextureBytes } from './core/GPUResourceTracker';

import type { IEngine } from './core/IEngine';
import { getEngineGPUResourceTracker } from './core/EngineDiagnosticsAccess';
import { RendererResourceCache } from './renderer/RendererResourceCache';

/** Narrow ownership hooks available to third-party render extensions. */
export interface ExtensionGPUResourceTracker {
  trackBuffer(buffer: GPUBuffer, label: string, bytes: number): GPUBuffer;
  trackTexture(texture: GPUTexture, label: string, bytes: number): GPUTexture;
  untrackBuffer(buffer: GPUBuffer): void;
  untrackTexture(texture: GPUTexture): void;
}

export function getExtensionGPUResourceTracker(engine: IEngine): ExtensionGPUResourceTracker | undefined {
  return getEngineGPUResourceTracker(engine);
}

export function getExtensionSharedRendererResource<T extends { destroy(): void }>(
  device: GPUDevice,
  key: string,
  create: () => T,
): T {
  return RendererResourceCache.get(device, key, create);
}
