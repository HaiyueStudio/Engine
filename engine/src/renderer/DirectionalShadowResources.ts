import type { RenderCommandContext } from '../core/RenderCommandContext';
import type { RecordedGpuResources } from './RecordedGpuResources';

const readers = new WeakMap<GPUTextureView, (context?: RenderCommandContext) => void>();

/** Private handoff from shadow storage to consumers, including frames reusing a cached map. */
export function registerDirectionalShadowView(view: GPUTextureView, texture: GPUTexture, owner: RecordedGpuResources): void {
  readers.set(view, context => owner.retain(texture, context));
}

export function retainDirectionalShadowView(view: GPUTextureView, context?: RenderCommandContext): void {
  readers.get(view)?.(context);
}
